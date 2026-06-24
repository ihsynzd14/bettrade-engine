/**
 * Predicted stoppage-time estimator — ported from the psychobet ExtraTimeCalculator
 * (psychobet/utils/extra-time-calculator.ts), adapted to the bettrade-engine event shape.
 *
 * Estimates per-phase added time from: substitutions (30s/batch), injuries (suspended-due-to-
 * injury → resume, >60s), VAR (InProgress → Safe, overlap-corrected), incidents (suspended,
 * not injury), and red cards (delay window). We only surface the TOTAL for the current phase.
 *
 * Engine events come from GET /api/feed/:id/events (processMatchActions shape); `toMatchEvent`
 * maps them to the calculator's MatchEvent shape. Same heuristics as the live system.
 */

class ExtraTimeCalculator {
  constructor() {
    this.reset()
  }

  reset() {
    this.calculations = {
      firstHalf: { substitutions: 0, injuries: 0, varChecks: 0, incidents: 0, redCards: 0, total: 0 },
      secondHalf: { substitutions: 0, injuries: 0, varChecks: 0, incidents: 0, redCards: 0, total: 0 },
      history: [],
    }
    this.stoppageTimeAnnounced = { FirstHalf: null, SecondHalf: null }
  }

  processEvents(events) {
    this.reset()

    const stoppageEvents = events.filter(e => e.type === 'stoppageTime')
    for (const event of stoppageEvents) {
      if (event.phase === 'FirstHalf') this.stoppageTimeAnnounced.FirstHalf = new Date(event.timestamp).getTime()
      else if (event.phase === 'SecondHalf') this.stoppageTimeAnnounced.SecondHalf = new Date(event.timestamp).getTime()
    }

    for (const phase of ['firstHalf', 'secondHalf']) {
      const P = phase === 'firstHalf' ? 'FirstHalf' : 'SecondHalf'
      this.calculations[phase].substitutions = this.calculateSubstitutionTime(events, P)
      this.calculations[phase].injuries = this.calculateInjuryTime(events, P)
      this.calculations[phase].varChecks = this.calculateVarTime(events, P)
      this.calculations[phase].incidents = this.calculateIncidentTime(events, P)
      this.calculations[phase].redCards = this.calculateRedCardTime(events, P)
      this.calculations[phase].total = this.sumPhaseTime(this.calculations[phase])
    }

    this.removeOverlappingEvents()
    this.recalculateTotals()
    return this.calculations
  }

  calculateSubstitutionTime(events, phase) {
    const subs = events.filter(e => e.type === 'substitution' && e.phase === phase)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    let totalTime = 0, batchStartTime = null, batchStartEvent = null, batchSize = 0
    const stoppageAnnounced = this.stoppageTimeAnnounced[phase]

    for (const event of subs) {
      const eventTime = new Date(event.timestamp)
      if (stoppageAnnounced && eventTime.getTime() >= stoppageAnnounced) continue
      if (!batchStartTime || eventTime.getTime() - batchStartTime.getTime() > 30000) {
        if (batchSize > 0 && batchStartEvent && batchStartTime) {
          totalTime += 30
          this.addToHistory({ id: this.id('sub'), type: 'substitution', phase, startTime: batchStartTime.toISOString(), endTime: new Date(batchStartTime.getTime() + 30000).toISOString(), duration: 30, description: `Substitution batch (${batchSize} players)`, timestamp: batchStartTime.toISOString(), timeElapsed: batchStartEvent.timeElapsed })
        }
        batchStartTime = eventTime; batchStartEvent = event; batchSize = 1
      } else batchSize++
    }
    if (batchSize > 0 && batchStartEvent && batchStartTime) {
      totalTime += 30
      this.addToHistory({ id: this.id('sub'), type: 'substitution', phase, startTime: batchStartTime.toISOString(), endTime: new Date(batchStartTime.getTime() + 30000).toISOString(), duration: 30, description: `Substitution batch (${batchSize} players)`, timestamp: batchStartTime.toISOString(), timeElapsed: batchStartEvent.timeElapsed })
    }
    return totalTime
  }

  calculateInjuryTime(events, phase) {
    const sorted = [...events].filter(e => e.phase === phase).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    let totalTime = 0, injuryStartTime = null, injuryStartEvent = null
    for (let i = 0; i < sorted.length; i++) {
      const event = sorted[i]
      const eventTime = new Date(event.timestamp).getTime()
      if (event.type === 'systemMessage' && !injuryStartTime) {
        const message = event.details.message || ''
        if (message.includes('The game is suspended due to an injured')) {
          const stoppageAnnounced = this.stoppageTimeAnnounced[phase]
          if (stoppageAnnounced && eventTime >= stoppageAnnounced) continue
          let startEvent = event
          for (let j = i - 1; j >= 0; j--) { if (sorted[j].type !== 'systemMessage') { startEvent = sorted[j]; break } }
          injuryStartTime = new Date(startEvent.timestamp); injuryStartEvent = startEvent
        }
      } else if (injuryStartTime && injuryStartEvent && event.type === 'dangerState') {
        const state = event.details.dangerState
        const isPenalty = this.isPenaltyContext(sorted, i)
        if (isPenalty && state === 'DangerousAttack') continue
        if (state === 'Safe' || state === 'Attack' || state === 'DangerousAttack') {
          const endTime = new Date(event.timestamp)
          const duration = endTime.getTime() - injuryStartTime.getTime()
          if (duration > 60000) {
            const stoppageAnnounced = this.stoppageTimeAnnounced[phase]
            if (!stoppageAnnounced || endTime.getTime() <= stoppageAnnounced) {
              const secondsDuration = Math.floor(duration / 1000)
              totalTime += secondsDuration
              this.finishInjuryCalculation(injuryStartTime, endTime, phase, secondsDuration, injuryStartEvent.timeElapsed)
            }
          }
          injuryStartTime = null; injuryStartEvent = null
        }
      }
    }
    return totalTime
  }

  finishInjuryCalculation(startTime, endTime, phase, duration, timeElapsed) {
    const calcDuration = duration || Math.floor((endTime.getTime() - startTime.getTime()) / 1000)
    this.addToHistory({ id: this.id('injury'), type: 'injury', phase, startTime: startTime.toISOString(), endTime: endTime.toISOString(), duration: calcDuration, description: 'Injury treatment', timestamp: startTime.toISOString(), timeElapsed: timeElapsed || '00:00' })
  }

  calculateVarTime(events, phase) {
    const sorted = [...events].filter(e => e.phase === phase).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    const varEvents = sorted.filter(e => e.type === 'var')
    let totalTime = 0, varStartTime = null, varStartEvent = null, varReason = ''
    for (const event of varEvents) {
      const state = event.details.state
      const isInProgress = event.details.isInProgress
      const isStart = isInProgress
      const isEnd = state === 'Safe' && !isInProgress
      if (varStartTime === null) {
        if (isStart) {
          const stoppageAnnounced = this.stoppageTimeAnnounced[phase]
          if (stoppageAnnounced && new Date(event.timestamp).getTime() >= stoppageAnnounced) continue
          varStartTime = new Date(event.timestamp); varStartEvent = event; varReason = event.details.reason || 'VAR Check'
        }
      } else if (varStartTime !== null && varStartEvent !== null) {
        if (event.details.reason && event.details.reason !== 'VAR Check' && event.details.reason !== 'NotSet') varReason = event.details.reason
        if (isEnd) {
          let startTime = varStartTime, endTime = new Date(event.timestamp), timeElapsed = varStartEvent.timeElapsed
          const startIdx = sorted.findIndex(e => e.id === varStartEvent.id)
          const endIdx = sorted.findIndex(e => e.id === event.id)
          if (startIdx > 0) {
            const prev = sorted[startIdx - 1]
            if (startTime.getTime() - new Date(prev.timestamp).getTime() < 300000) { startTime = new Date(prev.timestamp); timeElapsed = prev.timeElapsed }
          }
          if (endIdx !== -1 && endIdx < sorted.length - 1) {
            const next = sorted[endIdx + 1]
            if (new Date(next.timestamp).getTime() - endTime.getTime() < 300000) endTime = new Date(next.timestamp)
          }
          const duration = Math.floor((endTime.getTime() - startTime.getTime()) / 1000)
          const stoppageAnnounced = this.stoppageTimeAnnounced[phase]
          if (stoppageAnnounced && endTime.getTime() > stoppageAnnounced) { varStartTime = null; varStartEvent = null; varReason = ''; continue }
          let overlapSeconds = 0
          const injuryEvents = this.calculations.history.filter(h => h.type === 'injury' && h.phase === phase)
          for (const injury of injuryEvents) {
            if (!injury.startTime || !injury.endTime) continue
            const intersectStart = Math.max(new Date(injury.startTime).getTime(), startTime.getTime())
            const intersectEnd = Math.min(new Date(injury.endTime).getTime(), endTime.getTime())
            if (intersectEnd > intersectStart) overlapSeconds += (intersectEnd - intersectStart) / 1000
          }
          totalTime += Math.max(0, duration - Math.floor(overlapSeconds))
          this.addToHistory({ id: this.id('var'), type: 'var', phase, startTime: startTime.toISOString(), endTime: endTime.toISOString(), duration, description: `VAR Review: ${varReason}`, timestamp: startTime.toISOString(), timeElapsed })
          varStartTime = null; varStartEvent = null; varReason = ''
        }
      }
    }
    return totalTime
  }

  calculateIncidentTime(events, phase) {
    const sorted = [...events].filter(e => e.phase === phase).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    let totalTime = 0, incidentStartTime = null, incidentStartEvent = null
    for (let i = 0; i < sorted.length; i++) {
      const event = sorted[i]
      const eventTime = new Date(event.timestamp).getTime()
      if (event.type === 'systemMessage' && !incidentStartTime) {
        const message = (event.details.message || '').toLowerCase()
        if (message.includes('suspended') && !message.includes('injured')) {
          const nearbyInjury = events.some(e => e.type === 'systemMessage' && e.details.message?.includes('The game is suspended due to an injured') && Math.abs(new Date(e.timestamp).getTime() - eventTime) < 60000)
          if (!nearbyInjury) {
            const stoppageAnnounced = this.stoppageTimeAnnounced[phase]
            if (stoppageAnnounced && eventTime >= stoppageAnnounced) continue
            let startEvent = event
            for (let j = i - 1; j >= 0; j--) { if (sorted[j].type !== 'systemMessage') { startEvent = sorted[j]; break } }
            incidentStartTime = new Date(startEvent.timestamp); incidentStartEvent = startEvent
          }
        }
      } else if (incidentStartTime && incidentStartEvent) {
        let isEnd = false
        const endTime = new Date(event.timestamp)
        if (event.type === 'systemMessage') {
          const msg = (event.details.message || '').toLowerCase()
          if (msg.includes('resumed') || msg.includes('play resumed')) isEnd = true
        } else if (event.type === 'dangerState') {
          const s = event.details.dangerState
          const isPenalty = this.isPenaltyContext(sorted, i)
          if (isPenalty && s === 'DangerousAttack') continue
          if (s === 'Safe' || s === 'Attack' || s === 'DangerousAttack') isEnd = true
        }
        if (isEnd) {
          const duration = Math.floor((endTime.getTime() - incidentStartTime.getTime()) / 1000)
          const stoppageAnnounced = this.stoppageTimeAnnounced[phase]
          if ((!stoppageAnnounced || endTime.getTime() <= stoppageAnnounced) && duration > 10) {
            if (duration > 5) {
              totalTime += duration
              this.addToHistory({ id: this.id('incident'), type: 'incident', phase, startTime: incidentStartTime.toISOString(), endTime: endTime.toISOString(), duration, description: 'Incident delay', timestamp: incidentStartTime.toISOString(), timeElapsed: incidentStartEvent.timeElapsed })
            }
          }
          incidentStartTime = null; incidentStartEvent = null
        }
      }
    }
    return totalTime
  }

  calculateRedCardTime(events, phase) {
    const redCardEvents = events.filter(e => (e.type === 'redCard' || e.type === 'secondYellow') && e.phase === phase)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    let totalTime = 0
    for (const redCardEvent of redCardEvents) {
      const stoppageAnnounced = this.stoppageTimeAnnounced[phase]
      if (stoppageAnnounced && new Date(redCardEvent.timestamp).getTime() >= stoppageAnnounced) continue
      if (!this.hasAssociatedInjury(events, redCardEvent) && !this.hasAssociatedVar(events, redCardEvent)) {
        const allEvents = events.filter(e => e.phase === phase).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
        const idx = allEvents.findIndex(e => e.id === redCardEvent.id)
        if (idx > 0) {
          const previousEvent = allEvents[idx - 1], nextEvent = allEvents[idx + 1]
          if (previousEvent && nextEvent) {
            const delayStart = new Date(previousEvent.timestamp), delayEnd = new Date(nextEvent.timestamp)
            const duration = Math.floor((delayEnd.getTime() - delayStart.getTime()) / 1000)
            if (stoppageAnnounced && delayEnd.getTime() > stoppageAnnounced) continue
            if (duration >= 30 && duration <= 180) {
              totalTime += duration
              this.addToHistory({ id: this.id('redcard'), type: 'redCard', phase, startTime: delayStart.toISOString(), endTime: delayEnd.toISOString(), duration, description: 'Red card delay', timestamp: delayStart.toISOString(), timeElapsed: redCardEvent.timeElapsed })
            }
          }
        }
      }
    }
    return totalTime
  }

  hasAssociatedInjury(events, redCardEvent) {
    const t = new Date(redCardEvent.timestamp).getTime()
    return events.some(e => e.type === 'systemMessage' && e.details.message?.toLowerCase().includes('injured') && Math.abs(new Date(e.timestamp).getTime() - t) < 60000)
  }

  hasAssociatedVar(events, redCardEvent) {
    const t = new Date(redCardEvent.timestamp).getTime()
    return events.some(e => e.type === 'var' && e.details.reason?.toLowerCase().includes('redcard') && Math.abs(new Date(e.timestamp).getTime() - t) < 120000)
  }

  isPenaltyContext(events, currentIndex) {
    const currentTime = new Date(events[currentIndex].timestamp).getTime()
    for (let j = currentIndex - 1; j >= 0; j--) {
      const prev = events[j]
      if (currentTime - new Date(prev.timestamp).getTime() > 120000) break
      if (prev.type === 'dangerState' && prev.details.dangerState === 'Penalty') return true
      if (prev.type === 'var') {
        const reason = (prev.details.reason || '').toLowerCase()
        const outcome = (prev.details.originalOutcome || '').toLowerCase()
        if (reason.includes('penalty') || outcome.includes('penalty')) return true
      }
      if (prev.type === 'systemMessage' && prev.details.message?.toLowerCase().includes('penalty')) return true
    }
    return false
  }

  sumPhaseTime(p) { return p.substitutions + p.injuries + p.varChecks + p.incidents + p.redCards }
  addToHistory(e) { this.calculations.history.push(e) }
  id(prefix) { this._seq = (this._seq || 0) + 1; return `${prefix}-${this._seq}` }

  removeOverlappingEvents() {
    for (const phase of ['FirstHalf', 'SecondHalf']) {
      const phaseEvents = this.calculations.history.filter(e => e.phase === phase)
      const toRemove = new Set()
      for (let i = 0; i < phaseEvents.length; i++) {
        if (toRemove.has(phaseEvents[i].id)) continue
        for (let j = i + 1; j < phaseEvents.length; j++) {
          if (toRemove.has(phaseEvents[j].id)) continue
          const a = phaseEvents[i], b = phaseEvents[j]
          if (!a.startTime || !a.endTime || !b.startTime || !b.endTime) continue
          const intersectStart = Math.max(new Date(a.startTime).getTime(), new Date(b.startTime).getTime())
          const intersectEnd = Math.min(new Date(a.endTime).getTime(), new Date(b.endTime).getTime())
          if (intersectEnd > intersectStart) {
            if ((a.duration || 0) <= (b.duration || 0)) toRemove.add(a.id)
            else toRemove.add(b.id)
          }
        }
      }
      this.calculations.history = this.calculations.history.filter(e => !toRemove.has(e.id))
    }
  }

  recalculateTotals() {
    for (const [phase, P] of [['firstHalf', 'FirstHalf'], ['secondHalf', 'SecondHalf']]) {
      this.calculations[phase].substitutions = this.sumByType(P, 'substitution')
      this.calculations[phase].injuries = this.sumByType(P, 'injury')
      this.calculations[phase].varChecks = this.sumByType(P, 'var')
      this.calculations[phase].incidents = this.sumByType(P, 'incident')
      this.calculations[phase].redCards = this.sumByType(P, 'redCard')
      this.calculations[phase].total = this.sumPhaseTime(this.calculations[phase])
    }
  }

  sumByType(phase, type) {
    return this.calculations.history.filter(e => e.phase === phase && e.type === type).reduce((s, e) => s + (e.duration || 0), 0)
  }
}

// ── Adapter: bettrade-engine feed event → calculator MatchEvent ─────────────
// IMPORTANT: psychobet feeds the calculator EVERY match event. Its injury/incident logic snaps a
// stoppage's start to the *nearest non-systemMessage event* and its end to the *next dangerState* —
// so it needs a DENSE event stream. If we pass only the 7 "interesting" types, the nearest-neighbour
// anchors land on far-away events and durations balloon (e.g. 13′ where psychobet reads 6:46). We
// therefore pass ALL timestamped events through: the 7 below get rich detail mapping; every other
// type becomes a bare time-anchor (its type is ignored by the calculators but its timestamp brackets
// the stoppage tightly, exactly as in the live system).
export function toMatchEvent(e) {
  if (!e || !e.type || !e.timestamp) return null // no timestamp → useless as a time anchor
  const base = { id: e.id, timestamp: e.timestamp, phase: e.phase, timeElapsed: e.timeElapsed, team: e.team ?? 'System', details: {} }
  switch (e.type) {
    case 'substitutions':   return { ...base, type: 'substitution' }
    case 'systemMessages':  return { ...base, type: 'systemMessage', details: { message: e.message ?? '' } }
    case 'dangerStateChanges': return { ...base, type: 'dangerState', details: { dangerState: e.dangerState } }
    case 'varStateChanges': {
      const state = e.varState || 'Safe'
      return { ...base, type: 'var', details: { state, isInProgress: state === 'InProgress', reason: e.varReason ?? e.varReasonV2 ?? 'VAR Check', originalOutcome: e.varOutcome ?? e.varOutcomeV2 ?? '' } }
    }
    case 'straightRedCards': return { ...base, type: 'redCard' }
    case 'secondYellowCards': return { ...base, type: 'secondYellow' }
    case 'stoppageTimeAnnouncements': return { ...base, type: 'stoppageTime' }
    // All other events (throw-ins, fouls, shots, corners, goals, phase changes …) — keep them as
    // bare anchors so the nearest-neighbour bracketing matches the live feed.
    default: return { ...base, type: e.type }
  }
}

const _calc = new ExtraTimeCalculator()

/** Run the estimator on already-mapped MatchEvents. Returns the full ExtraTimeCalculation. */
export function estimateFromMatchEvents(matchEvents) {
  return _calc.processEvents(matchEvents ?? [])
}

export { ExtraTimeCalculator }

import { Router } from 'express'
import { getOverlap } from '../services/overlap.service.js'

const router = Router()

/**
 * GET /api/v1/fixtures/overlap
 * Returns the in-memory overlap list instantly.
 */
router.get('/overlap', (req, res) => {
  const data = getOverlap()
  res.json({
    ok: true,
    count: data.fixtures.length,
    lastUpdated: data.lastUpdated,
    fixtures: data.fixtures,
  })
})

export { router as fixturesRoutes }

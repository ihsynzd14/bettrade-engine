import https from 'https'
import fs from 'fs'
import axios from 'axios'

const LOGIN_URL = 'https://identitysso-cert.betfair.com/api/certlogin'
const KEEPALIVE_URL = 'https://identitysso.betfair.com/api/keepAlive'
const KEEPALIVE_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4 hours

let sessionToken = null
let keepAliveTimer = null

/**
 * Perform non-interactive (cert-based) bot login.
 * Sets the module-level sessionToken on success.
 */
export async function login() {
  const certPath = process.env.BETFAIR_CERT_PATH
  const keyPath  = process.env.BETFAIR_KEY_PATH
  const appKey   = process.env.BETFAIR_APP_KEY
  const username = process.env.BETFAIR_USERNAME
  const password = process.env.BETFAIR_PASSWORD

  if (!certPath || !keyPath || !appKey || !username || !password) {
    throw new Error('Missing Betfair env vars: BETFAIR_CERT_PATH, BETFAIR_KEY_PATH, BETFAIR_APP_KEY, BETFAIR_USERNAME, BETFAIR_PASSWORD')
  }

  const httpsAgent = new https.Agent({
    cert: fs.readFileSync(certPath),
    key:  fs.readFileSync(keyPath),
  })

  const params = new URLSearchParams({ username, password })

  const response = await axios.post(LOGIN_URL, params.toString(), {
    httpsAgent,
    headers: {
      'X-Application': appKey,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  })

  if (response.data.loginStatus !== 'SUCCESS') {
    throw new Error(`Betfair login failed: ${response.data.loginStatus}`)
  }

  sessionToken = response.data.sessionToken
  console.log('[betfair-auth] Logged in successfully')

  // Start keep-alive loop
  if (keepAliveTimer) clearInterval(keepAliveTimer)
  keepAliveTimer = setInterval(keepAlive, KEEPALIVE_INTERVAL_MS)
}

/**
 * Returns the current session token.
 * Throws if not yet authenticated.
 */
export function getSessionToken() {
  if (!sessionToken) throw new Error('Betfair session not initialized. Call login() first.')
  return sessionToken
}

/**
 * Calls Betfair keep-alive to extend the session.
 * On failure, re-authenticates from scratch.
 */
async function keepAlive() {
  try {
    const response = await axios.get(KEEPALIVE_URL, {
      headers: {
        'X-Application': process.env.BETFAIR_APP_KEY,
        'X-Authentication': sessionToken,
        Accept: 'application/json',
      },
    })

    if (response.data.status === 'SUCCESS') {
      sessionToken = response.data.token
      console.log('[betfair-auth] Session refreshed via keep-alive')
    } else {
      console.warn('[betfair-auth] Keep-alive failed, re-logging in...')
      await login()
    }
  } catch (err) {
    console.error('[betfair-auth] Keep-alive error, re-logging in:', err.message)
    await login()
  }
}

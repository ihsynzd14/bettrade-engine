/** @type {Set<import('http').ServerResponse>} */
const clients = new Set()

/**
 * Register a new SSE client connection.
 */
export function addClient(res) {
  clients.add(res)
  res.on('close', () => clients.delete(res))
}

/**
 * Broadcast a JSON event to all connected SSE clients.
 * @param {Object} payload
 */
export function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`
  for (const res of clients) {
    try {
      res.write(data)
    } catch {
      clients.delete(res)
    }
  }
}

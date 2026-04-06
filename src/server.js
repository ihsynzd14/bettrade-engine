import express from 'express'
import cors from 'cors'
import { fixturesRoutes } from './routes/fixtures.routes.js'

const app = express()

app.use(cors())
app.use(express.json())

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'bettrade-engine', ts: new Date().toISOString() })
})

app.use('/api/v1/fixtures', fixturesRoutes)

export { app }

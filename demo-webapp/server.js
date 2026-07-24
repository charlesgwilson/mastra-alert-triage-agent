'use strict'

const express = require('express')
const client = require('prom-client')
const { trace } = require('@opentelemetry/api')
const { logs, SeverityNumber } = require('@opentelemetry/api-logs')
const { parseOrder, computeTotal } = require('./orders')

const PORT = Number(process.env.PORT || 18080)

// --- Metrics (Prometheus scrapes /metrics) ---
const registry = new client.Registry()
client.collectDefaultMetrics({ register: registry })
const httpRequests = new client.Counter({
  name: 'http_requests_total',
  help: 'HTTP requests by route and status class',
  labelNames: ['route', 'status'],
  registers: [registry],
})
const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['route'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [registry],
})

// --- Logs (OTLP -> Alloy -> Loki), stamped with the active trace_id ---
const otelLogger = logs.getLogger('demo-webapp')
function log(severityText, severityNumber, body, attributes = {}) {
  const span = trace.getActiveSpan()
  const sc = span && span.spanContext()
  const attrs = { ...attributes, ...(sc ? { trace_id: sc.traceId, span_id: sc.spanId } : {}) }
  otelLogger.emit({ severityText, severityNumber, body, attributes: attrs })
  // also to stdout for local debugging
  console.log(JSON.stringify({ level: severityText, msg: body, ...attrs }))
}

const app = express()

app.use((req, res, next) => {
  const stop = httpDuration.startTimer({ route: req.path })
  res.on('finish', () => {
    httpRequests.inc({ route: req.path, status: `${Math.floor(res.statusCode / 100)}xx` })
    stop()
  })
  next()
})

app.get('/health', (_req, res) => res.json({ ok: true }))

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', registry.contentType)
  res.end(await registry.metrics())
})

// The incident path. On the fault (?broken=1) computeTotal throws a real
// TypeError whose stack names orders.js:<line> — recorded on the span and logged.
app.get('/checkout', (req, res) => {
  log('INFO', SeverityNumber.INFO, 'checkout received', { route: '/checkout' })
  try {
    const order = parseOrder(req)
    const total = computeTotal(order)
    res.json({ order: order.id, total })
  } catch (err) {
    const span = trace.getActiveSpan()
    if (span) {
      span.recordException(err)
      span.setStatus({ code: 2, message: err.message }) // 2 = ERROR
    }
    log('ERROR', SeverityNumber.ERROR, `checkout failed: ${err.message}`, {
      route: '/checkout',
      'exception.type': err.name,
      'exception.message': err.message,
      'exception.stacktrace': err.stack,
    })
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(JSON.stringify({ level: 'INFO', msg: `demo-webapp listening on :${PORT}` }))
})

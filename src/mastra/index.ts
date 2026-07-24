import { Mastra } from '@mastra/core'
import { registerApiRoute } from '@mastra/core/server'
import { mkdirSync, writeFileSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { maybePostSlack } from './slack.ts'
import { seed } from './investigation/seed.ts'
import { runInvestigation } from './investigation/loop.ts'
import { structure } from './investigation/structure.ts'
import { citationGate } from './investigation/gate.ts'
import { renderCard } from './investigation/card.ts'
import { disconnectMcp } from './investigation/backends.ts'

const WEBHOOK_SECRET = process.env.GRAFANA_WEBHOOK_SECRET ?? ''
const SAMPLES = process.env.SAMPLES_DIR || path.resolve(process.cwd(), 'samples')
// A service name is a label value that flows into TraceQL/LogQL — restrict it to a safe
// charset at the trust boundary (defence in depth alongside escapeLabelValue).
const SERVICE_RE = /^[A-Za-z0-9._-]+$/

// Constant-time bearer check: compares full-length Buffers so a byte-by-byte early exit
// can't leak the secret via response timing. Fails closed when no secret is configured.
function authorized(authHeader: string): boolean {
  if (!WEBHOOK_SECRET) return false
  const a = Buffer.from(authHeader)
  const b = Buffer.from(`Bearer ${WEBHOOK_SECRET}`)
  // timingSafeEqual throws on length mismatch, so guard length first (this leaks only the
  // length of the expected header, not its contents).
  return a.length === b.length && timingSafeEqual(a, b)
}

const PORT = Number.isFinite(Number(process.env.MASTRA_PORT)) ? Number(process.env.MASTRA_PORT) : 14111

export const mastra = new Mastra({
  // No agents are registered on the instance: the webhook flow builds its investigator inline
  // (investigation/loop.ts), so nothing is auto-exposed on the unauthenticated /api/agents surface.
  server: {
    port: PORT, // 14111 by default (offset to avoid colliding with a Mastra dev server on 4111)
    apiRoutes: [
      // The Mastra server IS the webhook receiver. Grafana's contact point POSTs here, and the
      // POST drives the agent-driven investigation, not a fixed evidence bundle.
      registerApiRoute('/webhooks/grafana', {
        method: 'POST',
        // Read-only recommender: shared-secret bearer check in route middleware.
        middleware: [
          async (c, next) => {
            const auth = c.req.header('Authorization') ?? ''
            if (!authorized(auth)) return c.json({ error: 'unauthorized' }, 401)
            await next()
          },
        ],
        handler: async (c) => {
          const log = c.get('mastra').getLogger()
          // Parse defensively: a malformed body must be a 400, not an unhandled 500.
          let payload: any
          try {
            payload = await c.req.json()
          } catch {
            return c.json({ error: 'invalid payload' }, 400)
          }
          if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
            return c.json({ error: 'invalid payload' }, 400)
          }
          const service = payload?.commonLabels?.service || payload?.alerts?.[0]?.labels?.service || 'demo-webapp'
          // Reject an attacker-controlled service before it reaches any query string.
          if (typeof service !== 'string' || service.length > 200 || !SERVICE_RE.test(service)) {
            return c.json({ error: 'invalid service' }, 400)
          }
          mkdirSync(SAMPLES, { recursive: true })
          writeFileSync(path.join(SAMPLES, 'last-alert.json'), JSON.stringify(payload, null, 2))

          if (payload?.status !== 'firing') {
            return c.json({ received: true, skipped: `status=${payload?.status}` })
          }

          // Ack immediately, then run the AGENT-DRIVEN investigation async: the seed
          // + ReAct loop + model calls exceed Grafana's webhook notifier timeout, which would
          // otherwise mark the notification failed and retry it every evaluation.
          void (async () => {
            try {
              const s = await seed(service) // deterministic seed: metric breach + error trace -> file:line
              if (s.metric.value == null || !s.trigger.traceId) {
                log?.warn('seed incomplete (no live incident?)', { service })
                writeFileSync(path.join(SAMPLES, 'last-run.json'), JSON.stringify({ service, seed: s, note: 'seed incomplete' }, null, 2))
                return
              }
              const inv = await runInvestigation(s)         // seed-then-explore ReAct (frontier)
              const triage = await structure(inv.text)      // structured verdict (separate pass)
              const gate = citationGate(inv.ledger, triage) // hardened existence + seed-frame gate
              const card = renderCard(inv.ledger, triage, gate)
              const runJson = JSON.stringify({ service, seed: s, investigation: inv.text, stepLog: inv.stepLog, ledger: inv.ledger, triage, gate, model: inv.model }, null, 2)
              // Per-incident copies keyed by the trigger trace id, so two alerts firing close
              // together each keep their own record; last-card.md / last-run.json are the "latest".
              const runTag = (s.trigger.traceId ?? 'unknown').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'unknown'
              writeFileSync(path.join(SAMPLES, `card-${runTag}.md`), card)
              writeFileSync(path.join(SAMPLES, `run-${runTag}.json`), runJson)
              writeFileSync(path.join(SAMPLES, 'last-card.md'), card)
              writeFileSync(path.join(SAMPLES, 'last-run.json'), runJson)
              const slack = await maybePostSlack(card)
              log?.info('agent-driven triage complete', {
                service,
                disposition: triage.disposition,
                recommendation: triage.recommendation,
                gatePassed: gate.passed,
                steps: inv.stepLog.length,
                model: inv.model,
                slack,
              })
            } catch (err) {
              log?.error('triage failed', { service, err: String(err) })
            }
          })()
          return c.json({ received: true, status: 'processing' })
        },
      }),
    ],
  },
})

// Graceful shutdown: tear down the lazily-spawned Grafana MCP child process so a Ctrl-C or
// container SIGTERM doesn't leave it orphaned.
let shuttingDown = false
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, async () => {
    if (shuttingDown) return
    shuttingDown = true
    await disconnectMcp().catch(() => {})
    process.exit(0)
  })
}

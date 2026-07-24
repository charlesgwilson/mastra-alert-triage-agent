# mastra-alert-triage-agent

A self-contained demo of a **read-only SRE agent**. When a Grafana alert fires, a
[Mastra](https://mastra.ai) agent investigates it and posts a cited file-or-close recommendation. It
reads telemetry and source; it changes nothing. A human makes the call.

Everything runs locally: an instrumented demo webapp with a planted bug, its own
Grafana/Prometheus/Tempo/Loki stack, and the agent. No real system is involved. This is the runnable
companion to a post on imawilson.com.

## What it does

A firing Grafana alert POSTs a webhook. A deterministic seed queries Prometheus for the breaching
metric and Tempo for the triggering error trace, and parses the failing `file:line` out of the
exception. From there the agent drives its own investigation over four read-only tools (a baseline
metric read, logs, neighboring traces, and a scoped source read), and a deterministic citation gate
checks every citation against the evidence the tools actually gathered before the card renders.

```
Grafana alert  ->  webhook (Bearer)  ->  deterministic seed  ->  ReAct investigation  ->  citation gate  ->  card
```

## Prerequisites

- **Node 22.23.1** (pinned in `.tool-versions`).
- **Docker** for the observability stack (Grafana, Prometheus, Tempo, Loki, Alloy).
- **`mcp-grafana` v0.17.0** on your `PATH`, the agent's read surface for Prometheus and Loki:
  `go install github.com/grafana/mcp-grafana/cmd/mcp-grafana@v0.17.0` (requires a Go toolchain).
- An **OpenRouter API key** (the models are OpenRouter slugs).

## Setup

1. `cp .env.example .env`, then set `OPENROUTER_API_KEY` and a `GRAFANA_WEBHOOK_SECRET` you choose.
2. `npm install && npm --prefix demo-webapp install`.
3. Bring up the stack (offset ports, so it will not collide with a Grafana already on `:3000`):
   ```bash
   docker compose --env-file .env -f observability/docker-compose.yml up -d
   ```
4. Mint the agent's read-only token once the stack is up: `bin/mint-sa-token`. It writes
   `GRAFANA_SERVICE_ACCOUNT_TOKEN` into `.env`. Re-run it after any `docker compose up`, since the
   demo Grafana has no data volume.

## Run

Three long-running processes, each in its own terminal, from the repo root. Start them in order, and
wait for the agent server to report it is listening before you drive load. The first `npm start` runs
`mastra build` for about 15 seconds before it binds `:14111`.

```bash
npm --prefix demo-webapp start                    # terminal 1: the monitored webapp (planted orders.js:23 bug)
npm start                                          # terminal 2: the triage agent's webhook server on :14111
INCIDENT=1 npm --prefix demo-webapp run load       # terminal 3: drive a sustained incident so the alert fires
```

Grafana's `WebappErrorRatioHigh` rule fires within a minute or two and POSTs the webhook. The
agent investigates and writes the card to `samples/last-card.md` (and posts to Slack if
`SLACK_BOT_TOKEN` and `SLACK_CHANNEL` are set). To run the investigation once from the command line
without waiting on Grafana, use `node --env-file=.env src/mastra/investigation/run.ts`.

## What you get

```
*Alert triage — demo-webapp* :rotating_light:
*Disposition:* actionable  |  *Recommendation:* file_ticket  |  *Confidence:* high

*Root cause hypothesis:* orders.js:23 attempts to calculate item.price * item.qty without
null-checking the item object...

*Investigation:* 5 tool calls (get_baseline, read_source, get_more_logs, get_neighboring_traces, get_neighboring_traces)
*Evidence gathered:* 2 metric points · 12 logs · 16 traces · 1 source reads

*Citations:* metric: error_ratio_5xx · source: orders.js:23 · log: checkout failed... · trace: c43b647b...
*Citation gate:* passed (existence + semantic support)
```

## Read-only, and one thing to know

The agent is read-only by construction: the Grafana MCP runs on a Viewer service account (a write
call returns 403), the source read is scoped to the demo webapp's checkout, and no code path mutates
anything. On the server: the `/webhooks/grafana` route is authenticated with a shared-secret bearer
check, and no agents are registered on the Mastra instance, so there is no auto-exposed
agent-invocation endpoint to reach. Mastra still mounts its API and playground on the same port, so
run `:14111` bound locally rather than exposing it publicly.

## Layout

- `src/mastra/` the agent, the four read-only tools, the deterministic seed and citation gate
- `demo-webapp/` an instrumented Express app with OpenTelemetry traces and logs, a `prom-client`
  metrics endpoint, and a planted `orders.js:23` bug plus a load generator
- `observability/` the docker-compose stack and Grafana provisioning (datasource correlation, the
  alert rule, the webhook contact point)
- `test/` unit tests for the security-critical pieces (`npm test`), plus `npm run typecheck`

## License

MIT. See [LICENSE](LICENSE).

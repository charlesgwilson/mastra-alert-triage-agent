'use strict'

// OTel bootstrap: traces + logs exported over OTLP/HTTP to Alloy; metrics are
// exposed separately via prom-client (/metrics) and scraped by Prometheus.
// Preloaded with `node -r ./otel.js server.js` so instrumentation patches load first.

const { NodeSDK } = require('@opentelemetry/sdk-node')
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node')
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http')
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http')
const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs')
const { resourceFromAttributes } = require('@opentelemetry/resources')
const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions')

const OTLP = process.env.OTLP_HTTP || 'http://localhost:14318'

const sdk = new NodeSDK({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'demo-webapp' }),
  traceExporter: new OTLPTraceExporter({ url: `${OTLP}/v1/traces` }),
  logRecordProcessors: [
    new BatchLogRecordProcessor(new OTLPLogExporter({ url: `${OTLP}/v1/logs` })),
  ],
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
})

sdk.start()
process.on('SIGTERM', () => sdk.shutdown().finally(() => process.exit(0)))

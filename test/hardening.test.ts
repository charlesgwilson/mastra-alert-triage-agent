import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Ledger } from '../src/mastra/investigation/seed.ts'
import type { Triage } from '../src/mastra/investigation/schema.ts'

// Focused unit tests for the security-critical hardening fixes. Pure functions only —
// no Docker, no MCP, no network. Run with: node --test test/hardening.test.ts
//
// ARRANGE (module scope): source.ts reads WEBAPP_SRC at import time, so we build a scoped
// source root on disk and point WEBAPP_SRC at it BEFORE the dynamic import below.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'triage-hardening-'))
const SRC_ROOT = path.join(tmp, 'app-src')
const SIBLING = path.join(tmp, 'app-src-secrets') // shares the "app-src" string prefix on purpose
mkdirSync(SRC_ROOT, { recursive: true })
mkdirSync(SIBLING, { recursive: true })
writeFileSync(
  path.join(SRC_ROOT, 'orders.js'),
  Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'),
)
writeFileSync(path.join(SIBLING, 'secret.txt'), 'TOP SECRET\n')
writeFileSync(path.join(tmp, 'outside.txt'), 'outside the root\n')
process.env.WEBAPP_SRC = SRC_ROOT

const { readSourceSnippet } = await import('../src/mastra/investigation/source.ts')
const { escapeLabelValue, finiteOrNull, findAttributeString } = await import('../src/mastra/investigation/backends.ts')
const { citationGate } = await import('../src/mastra/investigation/gate.ts')

// ---------------------------------------------------------------------------
// B1 — path-scope guard: sibling-dir escape and traversal rejected; in-root allowed.
// ---------------------------------------------------------------------------
test('B1: rejects a sibling directory that shares the root prefix (app-src-secrets)', () => {
  // The old `abs.startsWith(SRC_ROOT)` check accepted this because the string starts with
  // the root; the boundary check (root + path.sep) rejects it.
  const r = readSourceSnippet(path.join(SIBLING, 'secret.txt'), 1)
  assert.equal(r, null)
})

test('B1: rejects path traversal out of the source root', () => {
  assert.equal(readSourceSnippet('../app-src-secrets/secret.txt', 1), null)
  assert.equal(readSourceSnippet('../outside.txt', 1), null)
  assert.equal(readSourceSnippet('../../../../../../etc/passwd', 1), null)
})

test('B1: accepts a real file inside the source root', () => {
  const r = readSourceSnippet('orders.js', 5)
  assert.ok(r, 'expected a snippet for an in-root file')
  assert.equal(r.path, 'orders.js')
  assert.match(r.snippet, /> 5: line 5/)
})

// ---------------------------------------------------------------------------
// B3 — escaping helper neutralizes the quote and backslash that would otherwise let an
// attacker break out of a LogQL/TraceQL "..." literal.
// ---------------------------------------------------------------------------
test('B3: escapeLabelValue escapes a double-quote', () => {
  assert.equal(escapeLabelValue('a"b'), 'a\\"b')
})

test('B3: escapeLabelValue escapes a backslash (before the quote, so \\" stays escaped)', () => {
  assert.equal(escapeLabelValue('a\\b'), 'a\\\\b')
  // input: backslash + quote  ->  \\  +  \"   (backslash-first ordering)
  assert.equal(escapeLabelValue('\\"'), '\\\\\\"')
})

test('B3: an injection attempt leaves no unescaped quote to close the literal', () => {
  const evil = 'demo" or resource.service.name="admin'
  const esc = escapeLabelValue(evil)
  // No double-quote remains that is NOT preceded by a backslash.
  assert.equal(/(?<!\\)"/.test(esc), false)
})

// ---------------------------------------------------------------------------
// S3 — promInstant-style parsing: "NaN"/"+Inf"/"-Inf"/null collapse to the single null
// sentinel; a real numeric string parses to a number.
// ---------------------------------------------------------------------------
test('S3: finiteOrNull returns null for non-finite Prometheus values', () => {
  assert.equal(finiteOrNull('NaN'), null)
  assert.equal(finiteOrNull('+Inf'), null)
  assert.equal(finiteOrNull('-Inf'), null)
  assert.equal(finiteOrNull(null), null)
  assert.equal(finiteOrNull(undefined), null)
})

test('S3: finiteOrNull returns the number for a finite value', () => {
  assert.equal(finiteOrNull('0.0123'), 0.0123)
  assert.equal(finiteOrNull('42'), 42)
  assert.equal(finiteOrNull(0), 0)
})

// ---------------------------------------------------------------------------
// TR1 — OTLP attribute walk: finds exception.* string attributes wherever the trace JSON
// nests them, skips a non-string value, and is null-safe. Guards the trace-parse path that
// recovers the failing file:line from a real Tempo trace.
// ---------------------------------------------------------------------------
const OTLP_TRACE = {
  batches: [
    {
      scopeSpans: [
        {
          spans: [
            {
              name: 'GET /checkout',
              status: { code: 2 },
              events: [
                {
                  name: 'exception',
                  attributes: [
                    { key: 'exception.type', value: { stringValue: 'TypeError' } },
                    { key: 'exception.message', value: { stringValue: "Cannot read properties of undefined (reading 'price')" } },
                    { key: 'exception.stacktrace', value: { stringValue: 'TypeError\n    at /app/demo-webapp/orders.js:23:10' } },
                    { key: 'http.status_code', value: { intValue: 500 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
}

test('TR1: findAttributeString extracts nested OTLP exception attributes by key', () => {
  assert.equal(findAttributeString(OTLP_TRACE, 'exception.type'), 'TypeError')
  assert.equal(
    findAttributeString(OTLP_TRACE, 'exception.message'),
    "Cannot read properties of undefined (reading 'price')",
  )
  assert.match(findAttributeString(OTLP_TRACE, 'exception.stacktrace') ?? '', /orders\.js:23/)
})

test('TR1: findAttributeString returns undefined for a missing key, a non-string value, or a non-object', () => {
  assert.equal(findAttributeString(OTLP_TRACE, 'exception.absent'), undefined)
  assert.equal(findAttributeString(OTLP_TRACE, 'http.status_code'), undefined) // intValue, not stringValue
  assert.equal(findAttributeString(null, 'x'), undefined)
})

// ---------------------------------------------------------------------------
// SF1 — failing-frame lookup: the citation gate identifies the failing frame DIRECTLY
// (basename + line), so a valid citation is not mis-rejected when a second read source
// shares its bare line number. server.js:23 is read FIRST and shares line 23 with the real
// failing frame orders.js:23; the old loose `path OR bare-line` find matched server.js on
// the "23" substring, then failed the file check and wrongly rejected orders.js:23.
// ---------------------------------------------------------------------------
function ledgerWithSharedLine(): Ledger {
  return {
    seed: {
      service: 'demo-webapp',
      metric: { name: 'error_ratio_5xx', value: 0.5, threshold: 0.1 },
      trigger: {
        traceId: 'abc123def456',
        exception: {
          type: 'TypeError',
          message: "Cannot read properties of undefined (reading 'price')",
          file: '/app/demo-webapp/orders.js', // failing frame is orders.js:23
          line: 23,
        },
      },
    },
    metrics: [],
    logs: [],
    traces: [],
    sources: [
      { path: 'server.js', line: 23, snippet: '> 23:   app.listen(3000)' }, // read first, same line
      { path: 'orders.js', line: 23, snippet: "> 23:   const price = item.price" },
    ],
    toolCalls: [],
  }
}

test('SF1: a valid orders.js:23 citation is admitted even when server.js:23 was also read', () => {
  const ledger = ledgerWithSharedLine()
  const valid: Triage = {
    disposition: 'actionable',
    recommendation: 'file_ticket',
    rootCauseHypothesis: 'orders.js:23 dereferences item.price on an undefined item',
    confidence: 'high',
    citations: [{ kind: 'source', ref: 'orders.js:23' }],
  }
  const gate = citationGate(ledger, valid)
  assert.equal(gate.passed, true, `expected admit, got ${JSON.stringify(gate)}`)
  assert.deepEqual(gate.existenceIssues, [])
  assert.deepEqual(gate.semanticIssues, [])

  // Guard the other direction: the real-but-irrelevant server.js:23 (shares the line but is
  // NOT the failing frame) must still be rejected on semantic support.
  const irrelevant: Triage = {
    ...valid,
    rootCauseHypothesis: 'server.js:23',
    citations: [{ kind: 'source', ref: 'server.js:23' }],
  }
  const gIrr = citationGate(ledger, irrelevant)
  assert.equal(gIrr.passed, false)
  assert.ok(gIrr.semanticIssues.length > 0, 'expected a not-failing-frame semantic rejection')
})

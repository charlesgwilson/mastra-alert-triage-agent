'use strict'

// Traffic + fault generator. Steady healthy traffic, with an "incident window"
// where the broken-cart fault rate spikes so the Grafana error-ratio alert fires.
//
//   BASE_URL       default http://localhost:18080
//   RPS            requests/sec (default 5)
//   FAULT_RATE     0..1 fraction of /checkout that sends ?broken=1 (default 0.02)
//   INCIDENT       "1" to run at INCIDENT_FAULT_RATE for INCIDENT_SECS then stop
//   INCIDENT_FAULT_RATE default 0.6
//   INCIDENT_SECS  default 180 (0 = run forever at FAULT_RATE)

const BASE = process.env.BASE_URL || 'http://localhost:18080'
const RPS = Number(process.env.RPS || 5)
const FAULT_RATE = Number(process.env.FAULT_RATE || 0.02)
const INCIDENT = process.env.INCIDENT === '1'
const INCIDENT_FAULT_RATE = Number(process.env.INCIDENT_FAULT_RATE || 0.6)
const INCIDENT_SECS = Number(process.env.INCIDENT_SECS || 180)

let n = 0
const started = Date.now()
const rate = () => (INCIDENT ? INCIDENT_FAULT_RATE : FAULT_RATE)

async function tick() {
  n += 1
  const broken = Math.random() < rate() ? '1' : '0'
  const url = `${BASE}/checkout?broken=${broken}&n=${n}`
  try {
    const r = await fetch(url)
    if (n % 25 === 0) console.log(`sent ${n} (last ${r.status}, faultRate ${rate()})`)
  } catch (e) {
    console.log(`req ${n} failed: ${e.message}`)
  }
  if (INCIDENT && INCIDENT_SECS > 0 && (Date.now() - started) / 1000 > INCIDENT_SECS) {
    console.log(`incident window (${INCIDENT_SECS}s) complete after ${n} requests`)
    process.exit(0)
  }
}

console.log(`loadgen -> ${BASE} at ${RPS} rps, faultRate ${rate()}${INCIDENT ? ` (INCIDENT ${INCIDENT_SECS}s)` : ''}`)
setInterval(tick, Math.max(1, Math.floor(1000 / RPS)))

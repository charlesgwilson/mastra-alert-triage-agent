'use strict'

// The demo webapp's "business logic". The PLANTED BUG lives here so a failing
// request produces a real stack trace naming orders.js:<line> — the file:line
// the triage agent follows into source to form a root-cause hypothesis.

function parseOrder(req) {
  // Normal path: one valid line item.
  const items = [{ sku: 'widget', price: 10, qty: 1 }]
  // Fault path (loadgen sends ?broken=1): inject an undefined line item.
  // This is the bug trigger — a missing validation of the incoming cart.
  if (req.query.broken === '1') {
    items.push(undefined)
  }
  return { id: 'ord_' + Math.floor(Number(req.query.n) || 0), items }
}

function computeTotal(order) {
  let sum = 0
  for (const item of order.items) {
    // BUG: no null-check on `item`. An undefined line item throws
    // "TypeError: Cannot read properties of undefined (reading 'price')" here.
    sum += item.price * item.qty
  }
  return sum
}

module.exports = { parseOrder, computeTotal }

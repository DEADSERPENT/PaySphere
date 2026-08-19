/**
 * Minimal in-process metrics registry exposed at GET /metrics in Prometheus
 * text format. Deliberately dependency-free: the metric surface required by
 * spec section 19 is small enough that pulling in prom-client would be
 * more machinery than value for a modular monolith.
 */

const counters = new Map();
const histograms = new Map();

function counterKey(name, labels) {
  const labelStr = labels
    ? Object.entries(labels)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}="${v}"`)
        .join(',')
    : '';
  return `${name}{${labelStr}}`;
}

function incrementCounter(name, labels = {}, value = 1) {
  const key = counterKey(name, labels);
  const existing = counters.get(key) || { name, labels, value: 0 };
  existing.value += value;
  counters.set(key, existing);
}

function observeHistogram(name, labels = {}, value) {
  const key = counterKey(name, labels);
  const existing = histograms.get(key) || { name, labels, count: 0, sum: 0, max: 0 };
  existing.count += 1;
  existing.sum += value;
  existing.max = Math.max(existing.max, value);
  histograms.set(key, existing);
}

function render() {
  const lines = [];
  for (const { name, labels, value } of counters.values()) {
    const labelStr = Object.entries(labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    lines.push(`${name}{${labelStr}} ${value}`);
  }
  for (const { name, labels, count, sum, max } of histograms.values()) {
    const labelStr = Object.entries(labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    lines.push(`${name}_count{${labelStr}} ${count}`);
    lines.push(`${name}_sum{${labelStr}} ${sum}`);
    lines.push(`${name}_max{${labelStr}} ${max}`);
  }
  return lines.join('\n') + '\n';
}

function reset() {
  counters.clear();
  histograms.clear();
}

module.exports = {
  incrementCounter,
  observeHistogram,
  render,
  reset,

  // Named helpers for the specific signals the spec calls out (section 19),
  // kept centralized so call sites read as intent rather than raw metric names.
  paymentCreated: () => incrementCounter('paysphere_payments_created_total'),
  paymentSucceeded: () => incrementCounter('paysphere_payments_succeeded_total'),
  paymentFailed: () => incrementCounter('paysphere_payments_failed_total'),
  clientReportedFailure: () => incrementCounter('paysphere_client_reported_failures_total'),
  webhookReceived: (eventType) => incrementCounter('paysphere_webhooks_received_total', { event_type: eventType }),
  webhookDuplicate: () => incrementCounter('paysphere_webhooks_duplicate_total'),
  idempotencyConflict: () => incrementCounter('paysphere_idempotency_conflicts_total'),
  idempotencyReplay: () => incrementCounter('paysphere_idempotency_replays_total'),
  retryAttempt: (operation) => incrementCounter('paysphere_retry_attempts_total', { operation }),
  reconciliationRepair: (outcome) => incrementCounter('paysphere_reconciliation_repairs_total', { outcome }),
  stuckPaymentsGauge: (count) => incrementCounter('paysphere_stuck_payments', {}, count),
  apiLatency: (route, ms) => observeHistogram('paysphere_api_latency_ms', { route }, ms),
  gatewayLatency: (operation, ms) => observeHistogram('paysphere_gateway_latency_ms', { operation }, ms),
  webhookLatency: (ms) => observeHistogram('paysphere_webhook_processing_latency_ms', {}, ms),
};

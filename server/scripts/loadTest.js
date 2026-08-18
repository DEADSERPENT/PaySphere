#!/usr/bin/env node
/**
 * Minimal concurrency/load test (spec section 20.4). Fires a configurable
 * number of concurrent create-payment requests — a mix of unique
 * idempotency keys and deliberately repeated ones — against a running
 * PaySphere instance and reports throughput, latency percentiles, and
 * duplicate-request behavior. No external load-testing dependency: this is
 * meant to be a quick local sanity check, not a substitute for a dedicated
 * tool (k6/autocannon) in a real performance-testing pass.
 *
 * Usage: node scripts/loadTest.js [--url http://localhost:3000] [--concurrency 50] [--duplicateRate 0.2]
 */

function parseArgs(argv) {
  const args = { url: 'http://localhost:3000', concurrency: 50, duplicateRate: 0.2 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url') args.url = argv[++i];
    if (argv[i] === '--concurrency') args.concurrency = parseInt(argv[++i], 10);
    if (argv[i] === '--duplicateRate') args.duplicateRate = parseFloat(argv[++i]);
  }
  return args;
}

function percentile(sortedLatencies, p) {
  if (sortedLatencies.length === 0) return 0;
  const idx = Math.min(sortedLatencies.length - 1, Math.floor((p / 100) * sortedLatencies.length));
  return sortedLatencies[idx];
}

async function fireOne(baseUrl, idempotencyKey) {
  const start = Date.now();
  const res = await fetch(`${baseUrl}/api/v1/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ orderId: `LOADTEST-${idempotencyKey}`, amount: 10000, currency: 'INR' }),
  });
  const durationMs = Date.now() - start;
  return { status: res.status, durationMs };
}

async function main() {
  const { url, concurrency, duplicateRate } = parseArgs(process.argv.slice(2));
  console.log(`Load test: ${concurrency} concurrent requests against ${url} (duplicateRate=${duplicateRate})`);

  const sharedKey = `loadtest-shared-${Date.now()}`;
  const requests = Array.from({ length: concurrency }, (_, i) => {
    const isDuplicate = Math.random() < duplicateRate;
    return fireOne(url, isDuplicate ? sharedKey : `loadtest-${Date.now()}-${i}`);
  });

  const started = Date.now();
  const results = await Promise.allSettled(requests);
  const totalDurationMs = Date.now() - started;

  const latencies = [];
  const statusCounts = {};
  let failures = 0;

  for (const result of results) {
    if (result.status === 'fulfilled') {
      latencies.push(result.value.durationMs);
      statusCounts[result.value.status] = (statusCounts[result.value.status] || 0) + 1;
    } else {
      failures += 1;
    }
  }
  latencies.sort((a, b) => a - b);

  console.log('--- Results ---');
  console.log(`Total wall time: ${totalDurationMs}ms`);
  console.log(`Throughput: ${((concurrency / totalDurationMs) * 1000).toFixed(1)} req/s`);
  console.log(`Status codes:`, statusCounts);
  console.log(`Network-level failures: ${failures}`);
  console.log(`Latency p50/p95/p99/max (ms): ${percentile(latencies, 50)}/${percentile(latencies, 95)}/${percentile(latencies, 99)}/${latencies[latencies.length - 1] || 0}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

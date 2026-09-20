# Load testing and micro-benchmarks

Versions checked 2026-09: autocannon 8.0, k6 2.2 (v2 removed long-deprecated commands and the
`externally-controlled` executor), oha 1.16, hyperfine 1.20, tinybench 6.2, Vitest 5.

## Ground rules

- Only load-test systems you own. Never point load at Discord, payment providers or other third-party APIs;
  mock them (or use their sandbox with its documented limits).
- Test a production build with production-like data volume (same indexes, similar document counts).
- Warm up first; run each scenario at least 3 times; report p50/p95/p99, throughput and error rate, never averages alone.
- Watch the server while testing: CPU, RSS, event-loop delay p99 and ELU, DB pool wait, DB slow-op log.
  The load generator must not share the CPU with the server if you want meaningful numbers.
- Prefer **open-model** load (fixed arrival rate) for latency SLOs. Closed-model tools (fixed connections) slow
  down with the server and hide queueing ("coordinated omission").

## Quick HTTP checks

```bash
# autocannon (Node): 50 connections for 30 s
npx autocannon -c 50 -d 30 http://localhost:3000/api/health
# authenticated route: pass a test token via env, never a real user's token
npx autocannon -c 20 -d 30 -H "Authorization=Bearer $LOADTEST_TOKEN" http://localhost:3000/api/guilds/123/tickets

# oha: fixed rate of 200 req/s with latency correction (open model)
oha -z 30s -c 50 -q 200 --latency-correction http://localhost:3000/api/health
```

## k6 scenario with thresholds (CI-friendly)

```js
// load/tickets.js   run: k6 run -e BASE_URL=http://localhost:3000 load/tickets.js
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    list_tickets: {
      executor: 'constant-arrival-rate',   // open model
      rate: 100, timeUnit: '1s',            // 100 req/s
      duration: '2m',
      preAllocatedVUs: 50, maxVUs: 200,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<300', 'p(99)<800'],
  },
};

export default function () {
  const res = http.get(`${__ENV.BASE_URL}/api/guilds/123/tickets?limit=50`, {
    headers: { Authorization: `Bearer ${__ENV.LOADTEST_TOKEN}` },
  });
  check(res, { 'status 200': (r) => r.status === 200 });
}
```

A failed threshold makes `k6 run` exit non-zero, so the script doubles as a CI performance gate. k6 also
exposes `dropped_iterations`: if it is non-zero, the system (or `maxVUs`) could not keep up with the target rate.

## Scripts, jobs and CLIs

```bash
hyperfine --warmup 3 --runs 10 'node scripts/export-v1.js' 'node scripts/export-v2.js'
```

For long jobs (migrations, imports) log elapsed time per batch and docs/s; compare on the same dataset snapshot.

## Micro-benchmarks

```js
// bench/serialize.bench.js   run: node bench/serialize.bench.js
import { Bench } from 'tinybench';

const payload = makePayload(10_000);
const bench = new Bench({ name: 'serialize', time: 500 });
bench
  .add('JSON.stringify', () => JSON.stringify(payload))
  .add('fast-json-stringify', () => stringifyWithSchema(payload));
await bench.run();
console.table(bench.table());
```

- Vitest benchmarks exist too, but the API changed in Vitest 5 (`bench` became a test-context fixture);
  follow the installed version's docs.
- A micro-benchmark proves a function got faster, not that the endpoint did. Confirm with an HTTP run.

## Reading results

| Observation | Likely meaning |
|---|---|
| p50 fine, p99 terrible | Queueing: pool exhaustion, event-loop stalls, GC pauses, lock contention |
| Throughput plateaus while CPU < 60 % | Waiting on I/O: DB pool, upstream API, libuv threadpool, rate limits |
| CPU at 100 % on one core | Event-loop bound: profile (`node --cpu-prof`) or move work to workers |
| Errors appear before latency rises | Timeouts/limits too tight, or connection limits (ulimit, DB `maxPoolSize`) |
| Latency grows over the run | Leak or unbounded queue/cache: check RSS and heap over time |

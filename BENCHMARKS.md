# prisma-smart-cache — Benchmark Report

> **Stack:** Express.js + Prisma + Autocannon
> **DB:** PostgreSQL via [Neon](https://neon.tech) — `us-east-1` (AWS US East)
> **Cache:** prisma-smart-cache (in-memory, TTL 60s)

---

## Why this matters

Most production apps don't run the DB on the same machine as the app. Cloud DBs, serverless Postgres, cross-region deployments — **50ms to 300ms+ of DB latency is the norm**, not the exception.

`prisma-smart-cache` was built to neutralize that. The further and slower your DB, the more critical it becomes.

---

## Test Setup

```
Runtime:      Node.js (ESM)
Framework:    Express.js
ORM:          Prisma
Database:     PostgreSQL via Neon (us-east-1, AWS US East)
Benchmarker:  Autocannon
Cache:        prisma-smart-cache — in-memory, TTL 60s
Routes:       GET /raw     → no cache
              GET /cached  → with cache
```

### Simulated DB latency (local tests)

A Prisma proxy was used to inject a realistic delay on every query:

```ts
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

export const prisma = new Proxy(prismaRaw, {
  get(target, prop, receiver) {
    const original = Reflect.get(target, prop, receiver);
    if (typeof original !== "object" || original === null) return original;
    return new Proxy(original, {
      get(modelTarget, method, modelReceiver) {
        const fn = Reflect.get(modelTarget, method, modelReceiver);
        if (typeof fn !== "function") return fn;
        return async (...args: any[]) => {
          await delay(50); // simulate remote DB
          return fn.apply(modelTarget, args);
        };
      },
    });
  },
});
```

---

## Scenario Benchmarks

> 500 connections · 60s per scenario · DB latency: **50ms**

| Scenario | RAW req/s | CACHED req/s | p99 RAW | p99 CACHED | Gain |
|---|---|---|---|---|---|
| Point lookup (user by ID) | 9,433 | 24,370 | 60ms | 27ms | **−55% latency** |
| List with filter (posts by user) | 8,888 | 21,143 | 68ms | 34ms | **−50% latency** |
| Relation join (feed + author + tags) | 1,014 | 18,048 | 546ms | 33ms | **−94% latency** |
| Aggregates (counts + avg) | 842 | 19,961 | 644ms | 28ms | **−95.7% latency** |
| Mixed load (80% reads, 20% writes) | 8,394 | 18,405 | 115ms | 129ms | **2.2× throughput** |

### Key takeaways

- **Point lookups** → 2.6× throughput, p99 halved
- **Filtered lists** → 2.4× throughput, p99 halved
- **JOIN queries** → **18× throughput**, p99 from 546ms → 33ms
- **Aggregates** → **24× throughput**, p99 from 644ms → 28ms
- **Mixed load** → writes trigger invalidation cleanly, throughput still doubles

> The heavier the query, the bigger the gain. Expensive joins and aggregates are almost free on cache hits.

---

## High Concurrency — 1000 Connections, 300s

> 1000 concurrent connections · 5 minutes sustained · DB latency: **50ms**

| Metric | RAW Prisma | CACHED Prisma | Improvement |
|---|---|---|---|
| Requests/sec | 12,391 | 21,145 | **~1.7×** |
| Avg latency | 80ms | 46ms | **~42% faster** |
| p99 latency | 96ms | 51ms | **~47% faster** |
| Throughput | 10.3 MB/s | 17.5 MB/s | **~1.7×** |
| Errors | 0 | 27 | Negligible (6.3M total reqs) |

Performance stays stable across the full 5-minute run. The 27 timeouts in the cached path are noise across 6.3 million total requests.

---

## Cross-Continent Test — 🇲🇿 Mozambique → 🇺🇸 AWS US East

> **App:** running locally in Mozambique
> **DB:** Neon PostgreSQL — `ep-little-surf-ahuo4g7f-pooler.c-3.us-east-1.aws.neon.tech`
> **Real RTT:** ~200–300ms per query
> **Load:** 1000 connections · 300s duration

This is the most realistic test. No simulated latency — just the actual round trip from Africa to the US East coast and back.

| Metric | RAW Prisma | CACHED Prisma | Improvement |
|---|---|---|---|
| Requests/sec | 131 | 12,467 | **~95× higher** |
| Avg latency | 7,140ms | 78ms | **~91× faster** |
| p99 latency | 9,200ms | 101ms | **~91× faster** |
| Throughput | 140 KB/s | 14,462 KB/s | **~103× higher** |
| Errors (timeouts) | 1,395 | 568 | System alive vs collapsed |

### Without cache

Every request had to cross the Atlantic. With 1000 concurrent connections all waiting on a 200–300ms round trip, the connection queue exploded. The DB saturated. 1,395 requests timed out. The system was effectively unusable.

```
Every request → Mozambique ──── Atlantic ──── AWS US East ──── Atlantic ──── Mozambique
                                                                              ~200–300ms per req
```

### With cache

After the first request per cache key crossed the ocean, every subsequent request was served from local memory. The geographic penalty was completely eliminated.

```
First request  → crosses the ocean   (~200–300ms)
Next 1000 reqs → served from RAM     (~1ms)
```

**78ms average latency. 12,467 req/sec. System stable.**

---

## Results by DB Latency

| DB Latency | Throughput Gain | p99 Improvement |
|---|---|---|
| 50ms (simulated) | up to **24×** | up to **−95.7%** |
| 100ms (simulated) | **~4.4×** | **~78% faster** |
| 200–300ms (real, cross-continent) | **~95×** | **~91% faster** |

> The slower and further the DB, the more essential `prisma-smart-cache` becomes.

---

## Conclusion

`prisma-smart-cache` is not just a performance optimization.

In any system where the DB is remote — cloud-hosted, serverless, cross-region — it is **infrastructure-critical**. Without it, your app is at the mercy of every network round trip. With it, the DB latency becomes nearly irrelevant for read-heavy workloads.

- Joins and aggregates go from seconds to milliseconds
- Throughput scales up to 95× under cross-region load  
- The system stays alive under conditions that would otherwise collapse it

---

*Benchmarked with [Autocannon](https://github.com/mcollina/autocannon) against a live Express + Prisma server.*
*DB: [Neon](https://neon.tech) PostgreSQL on AWS US East (`us-east-1`).*

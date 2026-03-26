<div align="center">

# Prisma Smart Cache

**The missing persistence layer for Prisma.**

[![npm version](https://img.shields.io/npm/v/prisma-smart-cache.svg?style=flat-square)](https://www.npmjs.com/package/prisma-smart-cache)
[![license](https://img.shields.io/npm/l/prisma-smart-cache.svg?style=flat-square)](./LICENSE)
[![node](https://img.shields.io/node/v/prisma-smart-cache.svg?style=flat-square)](https://nodejs.org)

A high-performance, **relation-aware** caching proxy for Prisma — powered by [BentoCache](https://bentocache.dev).  
Drop it in. No schema changes. No boilerplate. Your queries get faster immediately.

</div>

---

## Quick start

```bash
npm install prisma-smart-cache bentocache
```

```ts
import { PrismaClient } from "@prisma/client";
import { BentoCache, bentostore } from "bentocache";
import { memoryDriver } from "bentocache/drivers/memory";
import { smartCache } from "prisma-smart-cache";

const bento = new BentoCache({
  default: "fast",
  stores: {
    fast: bentostore().useL1Layer(memoryDriver()),
  },
});

// Wrap your client. That's it.
const prisma = smartCache(new PrismaClient(), bento, { ttl: 60 });

// All your existing queries work as-is — and are now cached.
const users = await prisma.user.findMany();
```

No migrations. No schema changes. Works with your existing Prisma setup.

---

## The problem

In production, your database is never on the same machine as your app. Cloud hosting, serverless Postgres, cross-region deployments — **50ms to 300ms+ of round-trip latency per query is the norm**.

Without a cache, every request pays that cost. Every time.

```
User request → App → ───── network ────── → DB → ───── network ────── → App → response
                                              ~50–300ms per query
```

With `prisma-smart-cache`:

```
User request → App → RAM  →  response      (cache hit, ~1ms)
                     ↓
              first miss only → DB         (then cached for next N seconds)
```

---

## Why this is different

Most Prisma caches are dumb — they nuke the entire model cache when anything changes. This library uses **field-level diffing** and **relation-aware invalidation**.

### Granular invalidation

```ts
// This query selects only 'email' — that's what gets cached.
await prisma.user.findUnique({
  where: { id: 1 },
  select: { email: true },
});

// This update only touches 'bio'.
// The cache above is NOT invalidated — 'bio' wasn't part of the query shape.
await prisma.user.update({
  where: { id: 1 },
  data: { bio: "New bio" },
});
```

### Relation-aware invalidation

```ts
// This cached query includes the Author relation.
await prisma.post.findMany({
  where: { published: true },
  include: { author: true },
});

// Updating the author triggers surgical invalidation of the Post cache above.
// No stale data. No manual tags required.
await prisma.author.update({
  where: { id: 42 },
  data: { name: "New Name" },
});
```

### Stampede protection

When a cache key expires under heavy traffic, thousands of requests don't all hit the database at once. BentoCache's underlying lock mechanism ensures only one request rehydrates the cache — the rest wait and get served from it.

---

## Per-query control

Add a `cache` option to any read operation to override the global config:

```ts
const posts = await prisma.post.findMany({
  where: { published: true },
  cache: {
    ttl: 300,              // override TTL for this query
    tags: ["homepage"],    // tag for manual invalidation
    disable: false,        // set true to force a live DB hit
  },
});
```

---

## Production setup — L1 + L2 (Redis)

For production, combine in-memory (L1) and Redis (L2). Hot data stays in local RAM. Redis keeps everything consistent across instances.

```ts
import { redisDriver } from "bentocache/drivers/redis";

const bento = new BentoCache({
  default: "production",
  stores: {
    production: bentostore()
      .useL1Layer(memoryDriver())
      .useL2Layer(redisDriver({ connection: { host: "localhost" } })),
  },
});

const prisma = smartCache(new PrismaClient(), bento, { ttl: 60 });
```

L1 handles the hot path at ~1ms. L2 handles cross-instance consistency and survivability.

---

## How it compares

| Feature | Prisma Accelerate | prisma-redis-cache | Hibernate L2 | prisma-smart-cache |
|---|---|---|---|---|
| Transparent proxy | ✅ | ✅ | ❌ (annotations) | ✅ |
| Field-level diffing | ❌ | ❌ | ❌ | ✅ |
| Relation-aware invalidation | ❌ | ❌ | partial | ✅ |
| Self-hostable | ❌ | ✅ | ✅ | ✅ |
| Multi-tier (L1 + L2) | ✅ (managed) | ❌ | ✅ | ✅ |
| Stampede protection | ✅ | ❌ | ✅ | ✅ |

> Prisma Accelerate is the closest competitor — but it's a paid managed service, routes your DB traffic through Prisma's infrastructure, and has no field-level or relation-aware invalidation. `prisma-smart-cache` is self-hosted, more intelligent about invalidation, and free.

---

## Benchmarks

> Tested with **Express + Prisma + Autocannon** against a real Neon PostgreSQL DB on **AWS US East**.

### At 50ms DB latency — 500 connections, 60s

| Scenario | RAW p99 | CACHED p99 | Gain |
|---|---|---|---|
| Point lookup (by ID) | 60ms | 27ms | **−55%** |
| Filtered list | 68ms | 34ms | **−50%** |
| Relation join (with includes) | 546ms | 33ms | **−94%** |
| Aggregates | 644ms | 28ms | **−95.7%** |
| Mixed load (80% reads, 20% writes) | 115ms | 129ms | **2.2× throughput** |

### Cross-continent — 🇲🇿 Mozambique → 🇺🇸 AWS US East

Real round-trip latency of ~200–300ms. 1000 connections. 300 seconds.

| Metric | RAW | CACHED |
|---|---|---|
| Requests/sec | 131 | **12,467** |
| Avg latency | 7,140ms | **78ms** |
| p99 latency | 9,200ms | **101ms** |
| Timeouts | 1,395 | 568 |

Without cache, the system collapsed under cross-region load. With cache, it served **12,467 req/sec at 78ms average latency** — despite a DB thousands of miles away.

→ **[Full benchmark report](./BENCHMARKS.md)**

---

## API reference

### `smartCache(client, bento, options)`

| Parameter | Type | Description |
|---|---|---|
| `client` | `PrismaClient` | Your existing Prisma client instance |
| `bento` | `BentoCache` | A configured BentoCache instance |
| `options.ttl` | `number` | Global TTL in seconds (default: `60`) |
| `options.tags` | `string[]` | Tags applied to every cache entry |

### Per-query `cache` option

| Option | Type | Description |
|---|---|---|
| `ttl` | `number` | TTL override for this query |
| `tags` | `string[]` | Tags for manual invalidation |
| `disable` | `boolean` | Skip cache and go straight to DB |

---

## Requirements

- **Node.js** 18.x or higher
- **Prisma** 5.0+ (requires DMMF access)
- **BentoCache** 1.0+

---

## License

MIT

<div align="center">

Built with ❤️ by [Uanela Como](https://github.com/uanela)

</div>

# Prisma Cache

Automatic relation-aware caching for Prisma, powered by BentoCache.

Wraps your PrismaClient with a transparent proxy. Read operations are cached. Write operations run normally and automatically invalidate affected cache entries — including entries from related models, down to the field level.

No configuration required beyond setup. It reads your Prisma schema at runtime via DMMF.

---

## Install

```bash
npm install prismacache bentocache
# or
pnpm add prismacache bentocache
```

---

## Setup

```ts
import { withCache } from "prismacache";
import { PrismaClient } from "@prisma/client";
import { BentoCache, bentostore } from "bentocache";
import { memoryDriver } from "bentocache/drivers/memory";

const bento = new BentoCache({
  default: "memory",
  stores: {
    memory: bentostore().useL1Layer(memoryDriver()),
  },
});

const prisma = withCache(new PrismaClient(), bento, { ttl: 120 });
```

That's it. Use `prisma` exactly as you normally would.

---

## Usage

### Basic cached query

```ts
const users = await prisma.user.findMany({
  where: { active: true },
});
```

Cached automatically. Same args on the next call returns from cache.

### Per-query options

```ts
const users = await prisma.user.findMany({
  where: { active: true },
  cache: {
    ttl: 30, // override TTL in seconds
    tags: ["active-users"], // custom tags for manual invalidation
    key: "active-users", // custom cache key
  },
});
```

### Skip cache for a specific query

```ts
const fresh = await prisma.user.findMany({
  cache: { disable: true },
});
```

### Writes invalidate automatically

```ts
await prisma.user.update({
  where: { id: 1 },
  data: { name: "Uanela" },
});
// All cached queries involving `user` are invalidated.
// Related model caches (e.g. posts that included user) are evaluated
// and only invalidated if they selected the mutated fields.
```

---

## How invalidation works

When a write happens on a model:

1. All cached entries tagged with that model are invalidated immediately.
2. For related models, prismacache walks the stored query shapes and checks which fields were selected.
3. If the mutated fields overlap with the selected fields, the entry is invalidated. Otherwise it is left untouched.

Example: a `user.update` that only changes `birthday` will not invalidate a cached `post.findMany` that only included `user: { select: { name: true } }`.

This logic is entirely automatic. It uses Prisma's runtime DMMF to build the relation graph — no manual model registration needed.

---

## Global options

| Option | Type       | Default | Description                               |
| ------ | ---------- | ------- | ----------------------------------------- |
| `ttl`  | `number`   | `60`    | Default TTL in seconds for all queries    |
| `tags` | `string[]` | `[]`    | Default tags applied to every cache entry |

---

## Per-query cache options

| Option    | Type       | Description                                 |
| --------- | ---------- | ------------------------------------------- |
| `ttl`     | `number`   | TTL in seconds, overrides global default    |
| `tags`    | `string[]` | Additional tags for this entry              |
| `key`     | `string`   | Custom cache key, auto-generated if omitted |
| `disable` | `boolean`  | Skip cache entirely for this query          |

---

## Using Redis

```ts
import { BentoCache, bentostore } from "bentocache";
import { memoryDriver } from "bentocache/drivers/memory";
import { redisDriver } from "bentocache/drivers/redis";

const bento = new BentoCache({
  default: "multitier",
  stores: {
    multitier: bentostore()
      .useL1Layer(memoryDriver())
      .useL2Layer(
        redisDriver({ connection: { host: "localhost", port: 6379 } })
      ),
  },
});

const prisma = withCache(new PrismaClient(), bento);
```

prismacache delegates all storage, TTL, stampede protection, and grace periods to BentoCache. Any driver BentoCache supports works here.

---

## Requirements

- Node.js >= 18
- Prisma >= 5
- BentoCache >= 1.0

---

## License

MIT

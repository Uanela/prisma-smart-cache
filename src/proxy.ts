import type { BentoCache } from "bentocache";
import type { WithCacheOptions } from "./types.js";
import { PrismaCache } from "./prisma-cache.js";

type PrismaClient = Record<string, any>;

/**
 * Wrap a PrismaClient instance with automatic caching powered by BentoCache.
 *
 * - Read operations (findMany, findUnique, etc.) are cached automatically.
 * - Write operations (create, update, delete, etc.) run normally then invalidate
 *   affected cache entries using relation-aware field-level diffing.
 * - The `cache` option on any query accepts: ttl, tags, key, disable.
 *
 * @example
 * ```ts
 * import { withCache } from 'prisma-caching'
 * import { BentoCache, bentostore } from 'bentocache'
 * import { memoryDriver } from 'bentocache/drivers/memory'
 *
 * const bento = new BentoCache({
 *   default: 'memory',
 *   stores: { memory: bentostore().useL1Layer(memoryDriver()) }
 * })
 *
 * const prisma = withCache(new PrismaClient(), bento, { ttl: 120 })
 *
 * // cached query
 * const users = await prisma.user.findMany({
 *   where: { active: true },
 *   cache: { ttl: 60, tags: ['active-users'] }
 * })
 *
 * // skip cache for this query
 * const fresh = await prisma.user.findMany({
 *   cache: { disable: true }
 * })
 *
 * // write — cache invalidated automatically
 * await prisma.user.update({
 *   where: { id: 1 },
 *   data: { name: 'Uanela' }
 * })
 * ```
 */
export function withCache<T extends PrismaClient>(
  prismaClient: T,
  bentoCache: BentoCache<any>,
  options: WithCacheOptions = {}
): T {
  const handler = new PrismaCache(bentoCache, options);

  return new Proxy(prismaClient, {
    get(target, modelName) {
      const modelDelegate = (target as any)[modelName];

      // only intercept model delegates — skip $connect, $disconnect, _baseDmmf, etc.
      if (
        typeof modelName !== "string" ||
        modelName.startsWith("$") ||
        modelName.startsWith("_") ||
        typeof modelDelegate !== "object" ||
        modelDelegate === null
      ) {
        return modelDelegate;
      }

      // second-level proxy: intercept operations on the model delegate
      return new Proxy(modelDelegate, {
        get(modelTarget, operation) {
          const originalFn = (modelTarget as any)[operation];

          if (
            typeof operation !== "string" ||
            typeof originalFn !== "function"
          ) {
            return originalFn;
          }

          if (handler.isReadOperation(operation)) {
            return (args: any) =>
              handler.handleRead(modelName, operation, args, (cleanArgs: any) =>
                originalFn.call(modelTarget, cleanArgs)
              );
          }

          if (handler.isWriteOperation(operation)) {
            return (args: any) =>
              handler.handleWrite(modelName, operation, args, (cleanArgs) =>
                originalFn.call(modelTarget, cleanArgs)
              );
          }

          return originalFn.bind(modelTarget);
        },
      });
    },
  }) as T;
}

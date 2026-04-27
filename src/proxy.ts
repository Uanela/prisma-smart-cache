import type { BentoCache } from "bentocache";
import type { CacheMutation, PrismaArgsWithCache, WithCacheOptions } from "./types";
import { PrismaSmartCache } from "./prisma-smart-cache";

type PrismaClient = Record<string, any>;

interface SmartCacheTransactionOptions {
  smartCache?: {
    enabled?: boolean;
  };
}

interface ProxyRuntimeOptions {
  deferInvalidation?: (mutation: CacheMutation) => void;
}

/**
 * Extends a Prisma operation function to include our custom cache options.
 */
type CacheableFunction<F> = F extends (...args: infer A) => infer R
  ? (
      args: A[0] extends undefined
        ? PrismaArgsWithCache
        : A[0] & PrismaArgsWithCache
    ) => R
  : F;

/**
 * Maps over a Prisma Model (e.g., prisma.user) and wraps its methods.
 */
type CachedModel<M> = {
  [K in keyof M]: CacheableFunction<M[K]>;
};

type CachedTransaction<T> = T extends {
  $transaction: (...args: infer A) => infer R;
}
  ? ((...args: A) => R) &
      (<TResult>(
        fn: (tx: PrismaWithCache<any>) => Promise<TResult>,
        options?: SmartCacheTransactionOptions & Record<string, any>
      ) => Promise<TResult>)
  : never;

/**
 * The final Result Type that adds .cache to every model method
 */
export type PrismaWithCache<T> = {
  [K in keyof T]: T[K] extends Record<string, any>
    ? K extends `\$${string}` // Skip internal $connect, $queryRaw, etc.
      ? T[K]
      : CachedModel<T[K]>
    : T[K];
} & {
  $raw: T;
  $transaction: CachedTransaction<T>;
};

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
 * import { smartCache } from 'prisma-smart-cache'
 * import { BentoCache, bentostore } from 'bentocache'
 * import { memoryDriver } from 'bentocache/drivers/memory'
 *
 * const bento = new BentoCache({
 *   default: 'memory',
 *   stores: { memory: bentostore().useL1Layer(memoryDriver()) }
 * })
 *
 * const prisma = smartCache(new PrismaClient(), bento, { ttl: 120 })
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
export function smartCache<T extends PrismaClient>(
  prismaClient: T,
  bentoCache: BentoCache<any>,
  options: WithCacheOptions = {}
): PrismaWithCache<T> {
  const handler = new PrismaSmartCache(bentoCache, options);

  const wrapClient = <TClient extends PrismaClient>(
    client: TClient,
    runtimeOptions: ProxyRuntimeOptions = {}
  ): PrismaWithCache<TClient> =>
    new Proxy(client, {
      get(target, modelName) {
        const modelDelegate = (target as any)[modelName];

        // expose the original client for operations that must preserve PrismaPromise
        if (modelName === "$raw") {
          return new Proxy(target, {
            get(rawTarget, rawModelName) {
              const rawModelDelegate = (rawTarget as any)[rawModelName];

              // skip internal properties on the raw passthrough client
              if (
                typeof rawModelName !== "string" ||
                rawModelName.startsWith("$") ||
                rawModelName.startsWith("_") ||
                typeof rawModelDelegate !== "object" ||
                rawModelDelegate === null
              ) {
                return rawModelDelegate;
              }

              return new Proxy(rawModelDelegate, {
                get(rawModelTarget, rawOperation) {
                  const rawOriginalFn = (rawModelTarget as any)[rawOperation];

                  // raw operations bypass cache but strip our custom cache option
                  if (
                    typeof rawOperation !== "string" ||
                    typeof rawOriginalFn !== "function"
                  ) {
                    return rawOriginalFn;
                  }

                  return (args: any) => {
                    const { cache: _cacheOpts, ...prismaArgs } = (args ??
                      {}) as PrismaArgsWithCache;

                    return rawOriginalFn.call(rawModelTarget, prismaArgs);
                  };
                },
              });
            },
          });
        }

        // wrap interactive transactions so tx can use smart cache and defer invalidation
        if (modelName === "$transaction" && typeof modelDelegate === "function") {
          return (firstArg: any, transactionOptions?: any) => {
            // array transactions must receive PrismaPromise instances unchanged
            if (typeof firstArg !== "function") {
              return modelDelegate.call(target, firstArg, transactionOptions);
            }

            const useSmartCache = transactionOptions?.smartCache?.enabled !== false;
            const {
              smartCache: _smartCache,
              ...prismaTransactionOptions
            } = (transactionOptions ?? {}) as SmartCacheTransactionOptions &
              Record<string, any>;
            const mutations: CacheMutation[] = [];

            return modelDelegate
              .call(
                target,
                async (tx: PrismaClient) => {
                  // allow opting out when user needs Prisma's raw transaction client
                  if (!useSmartCache) {
                    return firstArg(tx);
                  }

                  return firstArg(
                    wrapClient(tx, {
                      deferInvalidation: (mutation) => mutations.push(mutation),
                    })
                  );
                },
                prismaTransactionOptions
              )
              .then(async (result: unknown) => {
                // flush transaction invalidations only after commit succeeds
                if (useSmartCache && mutations?.length) {
                  await Promise.all(
                    mutations.map((mutation) =>
                      handler.invalidate(
                        mutation.model,
                        mutation.operation,
                        mutation.args
                      )
                    )
                  );
                }

                return result;
              });
          };
        }

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
                handler.handleWrite(
                  modelName,
                  operation,
                  args,
                  (cleanArgs) => originalFn.call(modelTarget, cleanArgs),
                  runtimeOptions
                );
            }

            return originalFn.bind(modelTarget);
          },
        });
      },
    }) as PrismaWithCache<TClient>;

  return wrapClient(prismaClient);
}

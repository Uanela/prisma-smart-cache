import type { BentoCache } from "bentocache";
import type {
  CacheQueryOptions,
  CacheMutation,
  HandleWriteOptions,
  WithCacheOptions,
  PrismaArgsWithCache,
} from "./types";
import { buildCacheKey } from "./utils/key";
import { RelationGraph } from "./utils/relation-graph";
import { toKebab } from "./utils/casing";

const READ_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);

const WRITE_OPERATIONS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
]);

export class PrismaSmartCache {
  private readonly cache: BentoCache<any>;
  private readonly defaultTtl: number;
  private readonly defaultTags: string[];
  private readonly relationGraph: RelationGraph;

  /** inverted index: modelName → Set<cacheKey> */
  private readonly index = new Map<string, Set<string>>();

  constructor(bentoCache: BentoCache<any>, options: WithCacheOptions = {}) {
    this.cache = bentoCache;
    this.defaultTtl = options.ttl ?? 60;
    this.defaultTags = options.tags ?? [];
    this.relationGraph = new RelationGraph();
  }

  async handleRead<TArgs extends PrismaArgsWithCache, TResult>(
    model: string,
    operation: string,
    args: TArgs | undefined,
    originalFn: (args: Omit<TArgs, "cache">) => Promise<TResult>
  ): Promise<TResult> {
    const { cache: cacheOpts, ...prismaArgs } = (args ??
      {}) as PrismaArgsWithCache;

    // cache: false or cache: { disable: true } → bypass
    if (
      cacheOpts === false ||
      (cacheOpts as CacheQueryOptions)?.disable === true
    ) {
      return originalFn(prismaArgs as Omit<TArgs, "cache">);
    }

    const opts = cacheOpts as CacheQueryOptions | undefined;
    const ttl = opts?.ttl ?? this.defaultTtl;
    const userTags = opts?.tags ?? [];
    const customKey = opts?.key ?? null;

    const relationTags = this.relationGraph.getIncludedModels(
      model,
      prismaArgs as Record<string, unknown>
    );

    const tags = [
      toKebab(model),
      ...relationTags,
      ...this.defaultTags,
      ...userTags,
    ];

    const key = customKey ?? buildCacheKey(model, operation, prismaArgs);

    // register key in inverted index for all touched models
    for (const tag of [toKebab(model), ...relationTags]) {
      if (!this.index.has(tag)) this.index.set(tag, new Set());
      this.index.get(tag)!.add(key);
    }

    const cached = await this.cache.get<TResult>({ key });
    if (cached !== undefined && cached !== null) {
      return cached;
    }

    const result = await originalFn(prismaArgs as Omit<TArgs, "cache">);

    await this.cache.set({
      key,
      value: result,
      ttl: ttl * 1000,
      tags,
    });

    return result;
  }

  async handleWrite<TArgs extends PrismaArgsWithCache, TResult>(
    model: CacheMutation['model'],
    operation: CacheMutation['operation'],
    args: TArgs | undefined,
    originalFn: (args: Omit<TArgs, "cache">) => Promise<TResult>,
    options: HandleWriteOptions = {}
  ): Promise<TResult> {
    const { cache: _cacheOpts, ...prismaArgs } = (args ??
      {}) as PrismaArgsWithCache;

    const result = await originalFn(prismaArgs as Omit<TArgs, "cache">);
    const mutation: CacheMutation = {
      model,
      operation,
      args: prismaArgs as Record<string, unknown>,
    };

    if (options.deferInvalidation) {
      options.deferInvalidation(mutation);
    } else {
      await this.invalidate(mutation.model, mutation.operation, mutation.args);
    }

    return result;
  }

  async invalidate(
    model: CacheMutation['model'],
    operation: CacheMutation['operation'],
    args: CacheMutation['args']
  ): Promise<void> {
    const modelKey = toKebab(model);

    // always invalidate direct model entries
    await this.cache.deleteByTag({ tags: [modelKey] });

    const mutatedFields = this.getMutatedFields(operation, args);

    if (!mutatedFields) {
      // can't determine fields (e.g. deleteMany) — invalidate all related models
      const relatedModels = this.relationGraph.getRelatedModels(modelKey);
      if (relatedModels.length > 0) {
        await this.cache.deleteByTag({ tags: relatedModels });
      }
      return;
    }

    // field-level: only invalidate related cache entries that selected mutated fields
    const keysToCheck = this.index.get(modelKey) ?? new Set<string>();

    for (const key of keysToCheck) {
      const entry = await this.cache.get<any>({ key });
      if (!entry) {
        this.index.get(modelKey)?.delete(key);
        continue;
      }

      const queryShape = entry?.__queryShape as
        | Record<string, unknown>
        | undefined;
      if (!queryShape) {
        await this.cache.delete({ key });
        continue;
      }

      const selectedFields = this.getSelectedFields(queryShape);
      const overlaps =
        selectedFields.has("*") ||
        mutatedFields.some((f) => selectedFields.has(f));

      if (overlaps) {
        await this.cache.delete({ key });
        this.index.get(modelKey)?.delete(key);
      }
    }
  }

  private getMutatedFields(
    operation: CacheMutation['operation'],
    args: CacheMutation['args']
  ): string[] | null {
    if (operation === "delete" || operation === "deleteMany") return null;

    const data = args?.data;
    if (!data || typeof data !== "object") return null;

    return Object.keys(data as object);
  }

  private getSelectedFields(queryShape: Record<string, unknown>): Set<string> {
    const select = queryShape?.select as Record<string, unknown> | undefined;

    if (!select) return new Set(["*"]);

    return new Set(Object.keys(select));
  }

  isReadOperation(op: string): boolean {
    return READ_OPERATIONS.has(op);
  }

  isWriteOperation(op: string): boolean {
    return WRITE_OPERATIONS.has(op);
  }
}

export interface CacheQueryOptions {
  /** TTL in seconds for this specific query. Overrides global default. */
  ttl?: number;

  /**
   * Tags to associate with this cache entry.
   * Model tags are added automatically — these are for custom groups.
   * @example tags: ['dashboard', 'public']
   */
  tags?: string[];

  /**
   * Custom cache key. If omitted, built automatically from
   * model + operation + serialized args.
   */
  key?: string;

  /**
   * Set to true to skip cache entirely for this query.
   * Useful for debugging or forcing a fresh fetch.
   */
  disable?: boolean;
}

export interface WithCacheOptions {
  /** Default TTL in seconds applied to all queries. Default: 60 */
  ttl?: number;

  /**
   * Default tags applied to every cache entry globally.
   * @example tags: ['tenant-123']
   */
  tags?: string[];
}

/** Prisma DMMF field shape (subset we care about) */
export interface DMMFField {
  name: string;
  type: string;
  relationName?: string;
}

/** Prisma DMMF model shape (subset we care about) */
export interface DMMFModel {
  name: string;
  fields: DMMFField[];
}

export interface DMMFDatamodel {
  models: DMMFModel[];
}

/** Prisma args extended with optional cache option */
export type PrismaArgsWithCache<T extends object = object> = T & {
  cache?: CacheQueryOptions | false;
};

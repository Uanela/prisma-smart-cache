/**
 * Build a deterministic, stable cache key from model + operation + args.
 * Args are serialized as sorted JSON to avoid key mismatches
 * from different property orderings.
 */
export function buildCacheKey(
  model: string,
  operation: string,
  args: object
): string {
  const serialized = args ? sortedStringify(args) : "";
  return `prisma-cache:${model}:${operation}:${serialized}`;
}

/**
 * JSON.stringify with keys sorted recursively for deterministic output.
 */
function sortedStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(sortedStringify).join(",") + "]";
  }

  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as object).sort();
    const pairs = keys.map(
      (k) =>
        `${JSON.stringify(k)}:${sortedStringify((value as Record<string, unknown>)[k])}`
    );
    return "{" + pairs.join(",") + "}";
  }

  return JSON.stringify(value);
}

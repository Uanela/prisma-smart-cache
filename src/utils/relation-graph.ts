import type { DMMFDatamodel } from "../types";

export class RelationGraph {
  /** modelName → Set<relatedModelName> */
  private readonly graph: Map<string, Set<string>>;

  /** modelName → Map<fieldName, relatedModelName> */
  private readonly fieldMap: Map<string, Map<string, string>>;

  constructor(prismaClient: { _baseDmmf?: { datamodel: DMMFDatamodel } }) {
    const datamodel = prismaClient._baseDmmf?.datamodel ?? { models: [] };
    const { graph, fieldMap } = this.build(datamodel);
    this.graph = graph;
    this.fieldMap = fieldMap;
  }

  private build(datamodel: DMMFDatamodel): {
    graph: Map<string, Set<string>>;
    fieldMap: Map<string, Map<string, string>>;
  } {
    const graph = new Map<string, Set<string>>();
    const fieldMap = new Map<string, Map<string, string>>();

    for (const model of datamodel.models) {
      const name = model.name.toLowerCase();

      if (!graph.has(name)) graph.set(name, new Set());
      if (!fieldMap.has(name)) fieldMap.set(name, new Map());

      for (const field of model.fields) {
        if (field.relationName) {
          const relatedModel = field.type.toLowerCase();
          graph.get(name)!.add(relatedModel);
          fieldMap.get(name)!.set(field.name, relatedModel);
        }
      }
    }

    return { graph, fieldMap };
  }

  /** Get all model names directly related to a given model */
  getRelatedModels(model: string): string[] {
    return [...(this.graph.get(model.toLowerCase()) ?? [])];
  }

  /**
   * Walk the include/select tree of a prisma query and collect
   * all model names that are transitively included.
   */
  getIncludedModels(model: string, args?: Record<string, unknown>): string[] {
    const included = new Set<string>();
    const includeOrSelect =
      (args?.include as Record<string, unknown> | undefined) ??
      (args?.select as Record<string, unknown> | undefined);

    this.walkIncludes(model.toLowerCase(), includeOrSelect, included);
    return [...included];
  }

  private walkIncludes(
    currentModel: string,
    includeOrSelect: Record<string, unknown> | undefined,
    acc: Set<string>
  ): void {
    if (!includeOrSelect) return;

    const modelFieldMap = this.fieldMap.get(currentModel);
    if (!modelFieldMap) return;

    for (const [field, value] of Object.entries(includeOrSelect)) {
      const relatedModel = modelFieldMap.get(field);
      if (!relatedModel) continue;

      acc.add(relatedModel);

      // recurse into nested include/select
      if (value && typeof value === "object" && (value as unknown) !== true) {
        const nested = value as Record<string, unknown>;
        const nestedInclude =
          (nested.include as Record<string, unknown> | undefined) ??
          (nested.select as Record<string, unknown> | undefined);

        this.walkIncludes(relatedModel, nestedInclude, acc);
      }
    }
  }
}

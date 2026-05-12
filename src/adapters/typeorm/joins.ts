import type { ParsedInclude, ParsedQuery, ParsedSearchBy } from "../../parsed";
import {
  type Schema,
  getEntity,
  getRelation,
} from "../../schema";
import type { AliasRegistry } from "./aliases";

export type JoinPlan = {
  /** Dot-joined relation chain from the root entity, e.g. "posts.comments". */
  path: string;
  /** Property path on the parent alias, e.g. "rootAlias.posts". */
  propertyPath: string;
  /** Generated alias used by the query builder for this relation. */
  alias: string;
  /** Entity name of the joined target. */
  targetEntity: string;
  /** Selection strategy. */
  selection:
    | { kind: "none" }
    | { kind: "all" }
    | { kind: "fields"; fields: string[] };
};

/**
 * Walks the parsed query and produces an ordered list of joins. Parent joins
 * always come before their descendants so the QueryBuilder can resolve the
 * source alias.
 */
export function planJoins(
  query: ParsedQuery,
  schema: Schema,
  aliases: AliasRegistry,
): JoinPlan[] {
  const plans: JoinPlan[] = [];
  const byPath = new Map<string, JoinPlan>();

  const upsert = (
    path: string,
    propertyPath: string,
    targetEntity: string,
    selection: JoinPlan["selection"],
  ): JoinPlan => {
    const existing = byPath.get(path);
    if (existing) {
      // Selection upgrade rules: explicit selections win over "none".
      if (existing.selection.kind === "none" && selection.kind !== "none") {
        existing.selection = selection;
      } else if (
        existing.selection.kind === "fields" &&
        selection.kind === "all"
      ) {
        existing.selection = selection;
      } else if (
        existing.selection.kind === "fields" &&
        selection.kind === "fields"
      ) {
        const set = new Set([
          ...existing.selection.fields,
          ...selection.fields,
        ]);
        existing.selection = { kind: "fields", fields: [...set] };
      }
      return existing;
    }
    const alias = aliases.register(path);
    const plan: JoinPlan = {
      path,
      propertyPath,
      alias,
      targetEntity,
      selection,
    };
    byPath.set(path, plan);
    plans.push(plan);
    return plan;
  };

  // 1. Includes (single level per spec).
  applyIncludeJoins(query.include, query.rootEntity, schema, aliases, upsert);

  // 2. SearchBy relation joins (recursive).
  if (query.searchBy) {
    walkSearchBy(
      query.searchBy,
      query.rootEntity,
      schema,
      aliases.root(),
      "",
      upsert,
    );
  }

  return plans;
}

function applyIncludeJoins(
  include: ParsedInclude,
  rootEntity: string,
  schema: Schema,
  aliases: AliasRegistry,
  upsert: (
    path: string,
    propertyPath: string,
    targetEntity: string,
    selection: JoinPlan["selection"],
  ) => JoinPlan,
): void {
  const entity = getEntity(schema, rootEntity);
  const rootAlias = aliases.root();
  if (include.kind === "none") return;

  if (include.kind === "all") {
    for (const [relName, relDef] of Object.entries(entity.relations ?? {})) {
      upsert(
        relName,
        `${rootAlias}.${relName}`,
        relDef.target,
        { kind: "all" },
      );
    }
    return;
  }

  for (const [relName, spec] of Object.entries(include.relations)) {
    const relDef = getRelation(schema, rootEntity, relName);
    if (!relDef) continue;
    const selection: JoinPlan["selection"] =
      spec.kind === "all"
        ? { kind: "all" }
        : { kind: "fields", fields: spec.fields };
    upsert(relName, `${rootAlias}.${relName}`, relDef.target, selection);
  }
}

function walkSearchBy(
  searchBy: ParsedSearchBy,
  currentEntity: string,
  schema: Schema,
  parentAlias: string,
  parentPath: string,
  upsert: (
    path: string,
    propertyPath: string,
    targetEntity: string,
    selection: JoinPlan["selection"],
  ) => JoinPlan,
): void {
  for (const cond of searchBy.conditions) {
    if (cond.kind !== "relation") continue;
    const path = parentPath ? `${parentPath}.${cond.field}` : cond.field;
    const plan = upsert(
      path,
      `${parentAlias}.${cond.field}`,
      cond.targetEntity,
      { kind: "none" },
    );
    walkSearchBy(
      cond.nested,
      cond.targetEntity,
      schema,
      plan.alias,
      path,
      upsert,
    );
  }
  for (const sub of searchBy.or) {
    walkSearchBy(sub, currentEntity, schema, parentAlias, parentPath, upsert);
  }
}

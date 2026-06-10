import { QueryValidationError } from "../../errors";
import type {
  ParsedDateSearch,
  ParsedFieldCondition,
  ParsedNumberSearch,
  ParsedSearchBy,
  ParsedStringSearch,
} from "../../parsed";
import { getEntity, getRelation, type Schema } from "../../schema";
import type { PrismaWhere } from "./types";

interface WhereCtx {
  schema: Schema;
  /** Entity name at the current scope. */
  currentEntity: string;
  /** Dot path from root, used for error messages. */
  path: string;
}

/**
 * Build a Prisma `where` filter from a parsed searchBy. Conditions AND
 * together; the `or` array becomes a Prisma `OR` clause AND-ed with the
 * conditions.
 *
 * `nativeregex` is rejected — Prisma has no portable regex operator in `where`
 * (postgres supports it via `$queryRaw` only). Use `exact` or `splitword`.
 */
export function buildWhere(
  searchBy: ParsedSearchBy,
  schema: Schema,
  rootEntity: string,
): PrismaWhere {
  return buildSearchBy(searchBy, {
    schema,
    currentEntity: rootEntity,
    path: "searchBy",
  });
}

function buildSearchBy(searchBy: ParsedSearchBy, ctx: WhereCtx): PrismaWhere {
  const ands: PrismaWhere[] = [];
  for (const cond of searchBy.conditions) {
    const w = buildCondition(cond, ctx);
    if (w !== undefined) ands.push(w);
  }
  const ors = searchBy.or
    .map((sub) => buildSearchBy(sub, ctx))
    .filter((w) => Object.keys(w).length > 0);

  if (ands.length === 1 && ors.length === 0) return ands[0];
  if (ands.length === 0 && ors.length === 0) return {};
  const out: PrismaWhere = {};
  if (ands.length > 0) out.AND = ands;
  if (ors.length > 0) out.OR = ors;
  return out;
}

function buildCondition(
  cond: ParsedFieldCondition,
  ctx: WhereCtx,
): PrismaWhere | undefined {
  switch (cond.kind) {
    case "string": {
      const filter = buildStringFilter(cond.search, `${ctx.path}.${cond.field}`);
      if (filter === undefined) return undefined;
      if (isMultiWordOr(filter)) {
        // Multi-word splitword: distribute the field onto each branch.
        return {
          OR: (filter.OR as object[]).map((leaf) => ({
            [cond.field]: leaf,
          })),
        };
      }
      return { [cond.field]: filter };
    }
    case "number":
      return { [cond.field]: buildNumberFilter(cond.search) };
    case "bool":
      return { [cond.field]: cond.search.value };
    case "date":
      return { [cond.field]: buildDateFilter(cond.search) };
    case "enum":
      return { [cond.field]: cond.search.value };
    case "id":
      return { [cond.field]: cond.search.value };
    case "in":
      return { [cond.field]: { in: cond.values } };
    case "null":
      return {
        [cond.field]: cond.check.isNull ? null : { not: null },
      };
    case "empty":
      return cond.check.isEmpty
        ? { OR: [{ [cond.field]: null }, { [cond.field]: "" }] }
        : {
            AND: [
              { [cond.field]: { not: null } },
              { [cond.field]: { not: "" } },
            ],
          };
    case "relation":
      return buildRelation(cond, ctx);
  }
}

interface PrismaStringFilter {
  equals?: string;
  contains?: string;
  mode?: "insensitive";
  /**
   * Internal sentinel: a splitword search that produced multiple per-word
   * branches. Lifted into a top-level OR by the caller so the field key is
   * distributed correctly. Never reaches Prisma.
   */
  OR?: PrismaStringFilter[];
}

function isMultiWordOr(
  f: PrismaStringFilter | string,
): f is PrismaStringFilter & { OR: PrismaStringFilter[] } {
  return typeof f === "object" && Array.isArray((f as PrismaStringFilter).OR);
}

function buildStringFilter(
  search: ParsedStringSearch,
  path: string,
): PrismaStringFilter | string | undefined {
  if (search.mode === "nativeregex") {
    throw new QueryValidationError(
      "String search mode 'nativeregex' is not supported by the Prisma adapter. " +
        "Use 'exact' or 'splitword'.",
      path,
    );
  }

  if (search.mode === "splitword") {
    const words = splitWords(search.value);
    if (words.length === 0) return undefined;
    if (words.length === 1) {
      return singleWordFilter(words[0], search.contained, search.caseSensitive);
    }
    const branches: PrismaStringFilter[] = words.map((w) => {
      const leaf = singleWordFilter(w, search.contained, search.caseSensitive);
      return typeof leaf === "string" ? { equals: leaf } : leaf;
    });
    return { OR: branches };
  }

  // exact
  return singleWordFilter(search.value, search.contained, search.caseSensitive);
}

function singleWordFilter(
  value: string,
  contained: boolean,
  caseSensitive: boolean,
): PrismaStringFilter | string {
  const mode: { mode?: "insensitive" } = caseSensitive ? {} : { mode: "insensitive" };
  if (contained) return { contains: value, ...mode };
  if (caseSensitive) return value; // shorthand: `{ field: "x" }` ≡ `{ equals: "x" }`
  return { equals: value, ...mode };
}

function splitWords(s: string): string[] {
  return s.split(/\s+/).filter((w) => w.length > 0);
}

function buildNumberFilter(
  search: ParsedNumberSearch,
): { equals: number } | { gt: number } | { lt: number } | { gte: number } | { lte: number } {
  switch (search.op) {
    case "==":
      return { equals: search.value };
    case ">":
      return { gt: search.value };
    case "<":
      return { lt: search.value };
    case ">=":
      return { gte: search.value };
    case "<=":
      return { lte: search.value };
  }
}

function buildDateFilter(
  search: ParsedDateSearch,
):
  | { equals: Date }
  | { gt?: Date; lt?: Date } {
  if (search.kind === "exact") return { equals: search.value };
  const out: { gt?: Date; lt?: Date } = {};
  if (search.after) out.gt = search.after;
  if (search.before) out.lt = search.before;
  return out;
}

function buildRelation(
  cond: Extract<ParsedFieldCondition, { kind: "relation" }>,
  ctx: WhereCtx,
): PrismaWhere {
  const relDef = getRelation(ctx.schema, ctx.currentEntity, cond.field);
  // `relDef` must exist — the parser only emits relation conditions for known
  // relations. If it doesn't, the schema diverged from what was parsed.
  if (!relDef) {
    throw new Error(
      `genquery/prisma: missing relation '${cond.field}' on '${ctx.currentEntity}'`,
    );
  }
  const targetEntity = getEntity(ctx.schema, cond.targetEntity);
  const isMany = (relDef.kind ?? "many") === "many";
  const nestedCtx: WhereCtx = {
    schema: ctx.schema,
    currentEntity: targetEntity.name,
    path: `${ctx.path}.${cond.field}.${cond.op}`,
  };
  const nested = buildSearchBy(cond.nested, nestedCtx);

  if (isMany) {
    return { [cond.field]: { [cond.op]: nested } };
  }

  // To-one relation: Prisma uses `is` / `isNot`. Map:
  //   some/every → is (existence + match; vacuous-truth differs from many's
  //                    `every`, documented as a known approximation)
  //   none       → isNot
  if (cond.op === "none") {
    return { [cond.field]: { isNot: nested } };
  }
  return { [cond.field]: { is: nested } };
}

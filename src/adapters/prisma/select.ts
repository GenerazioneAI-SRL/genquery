import type {
  ParsedInclude,
  ParsedIncludeRelation,
  ParsedQuery,
  ParsedSelect,
} from "../../parsed";
import {
  type EntityDefinition,
  type Schema,
  getEntity,
  primaryKeyOf,
} from "../../schema";
import type { PrismaFindManyArgs, PrismaInclude, PrismaSelect } from "./types";

/**
 * Translate ParsedSelect + ParsedInclude into Prisma's `select` / `include`
 * args, mutating `args` in place.
 *
 * Rules:
 *  - select=all + include=none/all/map → use `include` (or omit when no
 *    relations). Prisma defaults to all scalar fields when neither is set.
 *  - select≠all → must use `select`; relations from include are nested into
 *    `select` (Prisma forbids using both `select` and `include` at the same
 *    level).
 *  - Selected fields always include the primary key, so hydration works and
 *    later relation joins line up.
 */
export function applySelectAndInclude(
  args: PrismaFindManyArgs,
  query: ParsedQuery,
  schema: Schema,
): void {
  const rootEntity = getEntity(schema, query.rootEntity);
  const select = query.select;
  const include = query.include;

  if (select.kind === "all") {
    const inc = buildIncludeOnly(include, rootEntity, schema);
    if (inc) args.include = inc;
    return;
  }

  args.select = buildSelectFromBoth(select, include, rootEntity, schema);
}

function buildIncludeOnly(
  include: ParsedInclude,
  rootEntity: EntityDefinition,
  schema: Schema,
): PrismaInclude | undefined {
  if (include.kind === "none") return undefined;
  if (include.kind === "all") {
    const rels = rootEntity.relations ?? {};
    const keys = Object.keys(rels);
    if (keys.length === 0) return undefined;
    const out: PrismaInclude = {};
    for (const k of keys) out[k] = true;
    return out;
  }
  // map
  const out: PrismaInclude = {};
  for (const [relName, spec] of Object.entries(include.relations)) {
    const relDef = rootEntity.relations?.[relName];
    if (!relDef) continue;
    out[relName] = relationToSpec(spec, relDef.target, schema);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function buildSelectFromBoth(
  select: Exclude<ParsedSelect, { kind: "all" }>,
  include: ParsedInclude,
  rootEntity: EntityDefinition,
  schema: Schema,
): PrismaSelect {
  const pk = primaryKeyOf(rootEntity);
  const out: PrismaSelect = {};

  if (select.kind === "none") {
    out[pk] = true;
  } else {
    const set = new Set<string>(select.fields);
    set.add(pk);
    for (const f of set) out[f] = true;
  }

  // Nest relations into `select`.
  if (include.kind === "all") {
    for (const [relName, relDef] of Object.entries(rootEntity.relations ?? {})) {
      void relDef;
      out[relName] = true;
    }
  } else if (include.kind === "map") {
    for (const [relName, spec] of Object.entries(include.relations)) {
      const relDef = rootEntity.relations?.[relName];
      if (!relDef) continue;
      out[relName] = relationToSpec(spec, relDef.target, schema);
    }
  }

  return out;
}

function relationToSpec(
  spec: ParsedIncludeRelation,
  targetEntityName: string,
  schema: Schema,
): boolean | { select: PrismaSelect } {
  if (spec.kind === "all") return true;
  const target = getEntity(schema, targetEntityName);
  const pk = primaryKeyOf(target);
  const set = new Set(spec.fields);
  set.add(pk);
  const sel: PrismaSelect = {};
  for (const f of set) sel[f] = true;
  return { select: sel };
}

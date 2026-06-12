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
import type {
  PrismaFindManyArgs,
  PrismaInclude,
  PrismaOmit,
  PrismaSelect,
} from "./types";

/**
 * Translate ParsedSelect + ParsedInclude into Prisma's `select` / `include` /
 * `omit` args, mutating `args` in place.
 *
 * Rules:
 *  - select=all + include=none/all/map → use `include` (or omit when no
 *    relations). Prisma defaults to all scalar fields when neither is set.
 *  - select≠all → must use `select`; relations from include are nested into
 *    `select` (Prisma forbids using both `select` and `include` at the same
 *    level).
 *  - Selected fields always include the primary key, so hydration works and
 *    later relation joins line up.
 *  - Secret-strip: when the entity has policy-denied fields (`selectable:
 *    false` — DEFAULT_SECRET_FIELDS / policy deny / selectable allowlist),
 *    select=all gets a Prisma `omit` of the denied names, so they never leave
 *    the database layer while every OTHER column — including ones the genquery
 *    schema doesn't model (Json, scalar arrays, ...) — keeps Prisma's default
 *    selection. Relations included without an explicit field list get the same
 *    treatment against their target entity.
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
    const omit = deniedOmit(rootEntity);
    if (omit) args.omit = omit;
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
    for (const k of keys) out[k] = defaultRelationSpec(rels[k].target, schema);
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
      out[relName] = defaultRelationSpec(relDef.target, schema);
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
):
  | boolean
  | { select: PrismaSelect }
  | { omit: PrismaOmit }
  | { omit?: PrismaOmit; include: PrismaInclude } {
  if (spec.kind === "all") return defaultRelationSpec(targetEntityName, schema);
  const target = getEntity(schema, targetEntityName);
  const nested = spec.relations ?? {};
  const nestedKeys = Object.keys(nested);

  // No explicit field selection: use `include` (Prisma returns all scalars)
  // with the recursive relation includes, plus an `omit` of the target's
  // policy-denied fields (secret-strip) when it has any.
  if (spec.fields.length === 0) {
    if (nestedKeys.length === 0) {
      return defaultRelationSpec(targetEntityName, schema);
    }
    const inc: PrismaInclude = {};
    for (const [relName, child] of Object.entries(nested)) {
      const relDef = target.relations?.[relName];
      if (relDef) inc[relName] = relationToSpec(child, relDef.target, schema);
    }
    const omit = deniedOmit(target);
    return omit ? { omit, include: inc } : { include: inc };
  }

  // Explicit fields selected: use `select` (+ nested relations under select).
  const pk = primaryKeyOf(target);
  const set = new Set(spec.fields);
  set.add(pk);
  const sel: PrismaSelect = {};
  for (const f of set) sel[f] = true;
  for (const [relName, child] of Object.entries(nested)) {
    const relDef = target.relations?.[relName];
    if (relDef) sel[relName] = relationToSpec(child, relDef.target, schema);
  }
  return { select: sel };
}

// ── Secret-strip helpers ─────────────────────────────────────────────────────

/**
 * Prisma `omit` of the entity's policy-denied names: schema fields with
 * `selectable: false` plus unmapped columns the policy denied (Json / Bytes /
 * scalar lists the schema doesn't model — see `EntityDefinition.
 * unmappedColumns`). Returns `undefined` when nothing is denied — the common
 * case, which must keep emitting no `omit` key at all. The primary key is
 * never omitted (same invariant as explicit selects).
 */
function deniedOmit(entity: EntityDefinition): PrismaOmit | undefined {
  const pk = primaryKeyOf(entity);
  const out: PrismaOmit = {};
  for (const [name, def] of Object.entries(entity.fields)) {
    if (name !== pk && def.selectable === false) out[name] = true;
  }
  for (const [name, def] of Object.entries(entity.unmappedColumns ?? {})) {
    if (def.selectable === false) out[name] = true;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Spec for a relation included WITHOUT an explicit field list. Normally `true`
 * (Prisma returns all the target's scalars); when the target has policy-denied
 * fields they're stripped via `omit`.
 */
function defaultRelationSpec(
  targetEntityName: string,
  schema: Schema,
): true | { omit: PrismaOmit } {
  const omit = deniedOmit(getEntity(schema, targetEntityName));
  return omit ? { omit } : true;
}

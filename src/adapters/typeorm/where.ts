import { Brackets, type DataSource, type WhereExpressionBuilder } from "typeorm";
import { QueryValidationError } from "../../errors";
import type {
  ParsedDateSearch,
  ParsedFieldCondition,
  ParsedNumberSearch,
  ParsedSearchBy,
  ParsedStringSearch,
} from "../../parsed";
import type { Schema } from "../../schema";
import type { AliasRegistry } from "./aliases";
import { escapeLike, splitWords } from "./escape";
import type { ParamCounter } from "./params";

export interface WhereCtx {
  schema: Schema;
  aliases: AliasRegistry;
  params: ParamCounter;
  /** Bag of parameters collected for the outer QueryBuilder. */
  paramBag: Record<string, unknown>;
  /** Alias of the entity at the current scope. */
  currentAlias: string;
  /** Logical path from root, used to look up nested relation aliases. */
  currentPath: string;
  /** Entity name (as known to TypeORM metadata) at the current scope. */
  currentEntity: string;
  /** TypeORM DataSource / Connection — used to resolve relation metadata for every/none subqueries. */
  connection: DataSource;
}

interface Fragment {
  sql: string;
  params: Record<string, unknown>;
}

function qualify(alias: string, field: string): string {
  return `"${alias}"."${field}"`;
}

function buildString(
  alias: string,
  field: string,
  search: ParsedStringSearch,
  params: ParamCounter,
): Fragment {
  const col = qualify(alias, field);
  const like = search.caseSensitive ? "LIKE" : "ILIKE";
  switch (search.mode) {
    case "exact": {
      const p = params.next();
      if (search.contained) {
        return {
          sql: `${col} ${like} :${p}`,
          params: { [p]: `%${escapeLike(search.value)}%` },
        };
      }
      if (search.caseSensitive) {
        return {
          sql: `${col} = :${p}`,
          params: { [p]: search.value },
        };
      }
      // Case-insensitive equality via ILIKE on the escaped literal (no wildcards).
      return {
        sql: `${col} ILIKE :${p}`,
        params: { [p]: escapeLike(search.value) },
      };
    }
    case "nativeregex": {
      const p = params.next();
      const op = search.caseSensitive ? "~" : "~*";
      return {
        sql: `${col} ${op} :${p}`,
        params: { [p]: search.value },
      };
    }
    case "splitword": {
      const words = splitWords(search.value);
      if (words.length === 0) {
        return { sql: "1=1", params: {} };
      }
      const parts: string[] = [];
      const out: Record<string, unknown> = {};
      for (const w of words) {
        const p = params.next();
        const pattern = search.contained
          ? `%${escapeLike(w)}%`
          : escapeLike(w);
        parts.push(`${col} ${like} :${p}`);
        out[p] = pattern;
      }
      return { sql: `(${parts.join(" OR ")})`, params: out };
    }
  }
}

function buildNumber(
  alias: string,
  field: string,
  search: ParsedNumberSearch,
  params: ParamCounter,
): Fragment {
  const col = qualify(alias, field);
  const p = params.next();
  const op = search.op === "==" ? "=" : search.op;
  return { sql: `${col} ${op} :${p}`, params: { [p]: search.value } };
}

function buildDate(
  alias: string,
  field: string,
  search: ParsedDateSearch,
  params: ParamCounter,
): Fragment {
  const col = qualify(alias, field);
  if (search.kind === "exact") {
    const p = params.next();
    return { sql: `${col} = :${p}`, params: { [p]: search.value } };
  }
  // range
  const clauses: string[] = [];
  const out: Record<string, unknown> = {};
  if (search.after) {
    const p = params.next();
    clauses.push(`${col} > :${p}`);
    out[p] = search.after;
  }
  if (search.before) {
    const p = params.next();
    clauses.push(`${col} < :${p}`);
    out[p] = search.before;
  }
  return { sql: clauses.join(" AND "), params: out };
}

function buildLeaf(
  cond: Exclude<ParsedFieldCondition, { kind: "relation" }>,
  ctx: WhereCtx,
): Fragment {
  switch (cond.kind) {
    case "string":
      return buildString(ctx.currentAlias, cond.field, cond.search, ctx.params);
    case "number":
      return buildNumber(ctx.currentAlias, cond.field, cond.search, ctx.params);
    case "bool": {
      const p = ctx.params.next();
      return {
        sql: `${qualify(ctx.currentAlias, cond.field)} = :${p}`,
        params: { [p]: cond.search.value },
      };
    }
    case "date":
      return buildDate(ctx.currentAlias, cond.field, cond.search, ctx.params);
    case "enum": {
      const p = ctx.params.next();
      return {
        sql: `${qualify(ctx.currentAlias, cond.field)} = :${p}`,
        params: { [p]: cond.search.value },
      };
    }
    case "null": {
      const col = qualify(ctx.currentAlias, cond.field);
      return {
        sql: `${col} IS ${cond.check.isNull ? "" : "NOT "}NULL`,
        params: {},
      };
    }
    case "empty": {
      const col = qualify(ctx.currentAlias, cond.field);
      const sql = cond.check.isEmpty
        ? `(${col} IS NULL OR ${col} = '')`
        : `(${col} IS NOT NULL AND ${col} <> '')`;
      return { sql, params: {} };
    }
  }
}

function joinPath(parent: string, child: string): string {
  return parent ? `${parent}.${child}` : child;
}

function applyCondition(
  qb: WhereExpressionBuilder,
  cond: ParsedFieldCondition,
  ctx: WhereCtx,
  isFirst: boolean,
): void {
  if (cond.kind === "relation") {
    if (cond.op === "some") {
      const path = joinPath(ctx.currentPath, cond.field);
      const relAlias = ctx.aliases.get(path);
      if (!relAlias) {
        throw new Error(
          `genquery/typeorm: missing join for relation path '${path}'`,
        );
      }
      const subCtx: WhereCtx = {
        ...ctx,
        currentAlias: relAlias,
        currentPath: path,
        currentEntity: cond.targetEntity,
      };
      const brackets = new Brackets((sub) =>
        applySearchByInside(sub, cond.nested, subCtx),
      );
      if (isFirst) qb.where(brackets);
      else qb.andWhere(brackets);
      return;
    }
    // every / none → EXISTS / NOT EXISTS subquery
    const fragment = buildExistsSubquery(cond, ctx);
    Object.assign(ctx.paramBag, fragment.params);
    if (isFirst) qb.where(fragment.sql, fragment.params);
    else qb.andWhere(fragment.sql, fragment.params);
    return;
  }
  const fragment = buildLeaf(cond, ctx);
  Object.assign(ctx.paramBag, fragment.params);
  if (isFirst) qb.where(fragment.sql, fragment.params);
  else qb.andWhere(fragment.sql, fragment.params);
}

/**
 * Build a `[NOT] EXISTS (SELECT 1 FROM target WHERE ...)` fragment for
 * `every` / `none` relation conditions. Resolves FK columns through TypeORM's
 * own EntityMetadata so we don't reinvent relation introspection.
 *
 * Restrictions (Phase 1):
 *  - One-to-many and many-to-one (and one-to-one) relations are supported.
 *  - Many-to-many goes through a junction table and isn't supported here yet.
 *  - The nested `searchBy` must contain only leaf conditions and OR — nested
 *    relation filters inside `every`/`none` are not yet supported.
 */
function buildExistsSubquery(
  cond: Extract<ParsedFieldCondition, { kind: "relation" }>,
  ctx: WhereCtx,
): Fragment {
  const parentMeta = ctx.connection.getMetadata(ctx.currentEntity);
  const relMeta = parentMeta.relations.find(
    (r) => r.propertyName === cond.field,
  );
  if (!relMeta) {
    throw new Error(
      `genquery/typeorm: no TypeORM relation metadata for '${ctx.currentEntity}.${cond.field}'`,
    );
  }
  if (relMeta.isManyToMany) {
    throw new QueryValidationError(
      `Relation '${cond.field}' is many-to-many; '${cond.op}' filtering isn't supported yet for M2M relations`,
      cond.field,
    );
  }

  const targetMeta = relMeta.inverseEntityMetadata;
  const targetTable = targetMeta.tableName;
  const subAlias = `${ctx.currentAlias}__${cond.field}__sub`;

  // Determine the join condition between parent alias and the subquery alias.
  let joinSql: string;
  if (relMeta.joinColumns.length > 0) {
    // Owning side (many-to-one / owning one-to-one): FK column lives on the
    // parent table, references target's referenced column.
    const fk = relMeta.joinColumns[0];
    const parentCol = fk.databaseName;
    const targetCol = fk.referencedColumn?.databaseName
      ?? targetMeta.primaryColumns[0].databaseName;
    joinSql = `"${subAlias}"."${targetCol}" = "${ctx.currentAlias}"."${parentCol}"`;
  } else if (relMeta.inverseRelation) {
    // Inverse side (one-to-many / inverse one-to-one): FK lives on the target.
    const fk = relMeta.inverseRelation.joinColumns[0];
    if (!fk) {
      throw new Error(
        `genquery/typeorm: cannot resolve foreign key for relation '${cond.field}'`,
      );
    }
    const targetFk = fk.databaseName;
    const parentPk = fk.referencedColumn?.databaseName
      ?? parentMeta.primaryColumns[0].databaseName;
    joinSql = `"${subAlias}"."${targetFk}" = "${ctx.currentAlias}"."${parentPk}"`;
  } else {
    throw new Error(
      `genquery/typeorm: cannot resolve join columns for relation '${cond.field}'`,
    );
  }

  const subCtx: WhereCtx = {
    ...ctx,
    currentAlias: subAlias,
    currentPath: joinPath(ctx.currentPath, cond.field),
    currentEntity: cond.targetEntity,
  };
  const nestedFrag = buildSearchByFragment(cond.nested, subCtx);

  let whereContent = joinSql;
  if (nestedFrag.sql) {
    const inner =
      cond.op === "every" ? `NOT (${nestedFrag.sql})` : nestedFrag.sql;
    whereContent = `${joinSql} AND ${inner}`;
  } else if (cond.op === "every") {
    // every(no conditions) ≡ "no related rows that violate nothing", i.e. true.
    // Special-case: no WHERE on the nested side means `every` is trivially
    // satisfied (no row can violate an empty predicate).
    return { sql: "1=1", params: {} };
  }

  const exists = cond.op === "some" ? "EXISTS" : "NOT EXISTS";
  const sql = `${exists} (SELECT 1 FROM "${targetTable}" "${subAlias}" WHERE ${whereContent})`;
  return { sql, params: nestedFrag.params };
}

/**
 * Build a SQL fragment representing an entire ParsedSearchBy (conditions
 * AND-ed together, with the OR group AND-ed in). Used inside EXISTS
 * subqueries where we need raw SQL rather than a builder mutation.
 *
 * Throws if a nested relation appears — those need their own EXISTS subquery
 * with metadata resolution, which Phase 1 doesn't support inside every/none.
 */
function buildSearchByFragment(
  searchBy: ParsedSearchBy,
  ctx: WhereCtx,
): Fragment {
  const andParts: string[] = [];
  const params: Record<string, unknown> = {};

  for (const cond of searchBy.conditions) {
    if (cond.kind === "relation") {
      throw new QueryValidationError(
        `Nested relation filter '${cond.field}' inside 'every'/'none' is not supported in this version`,
        joinPath(ctx.currentPath, cond.field),
      );
    }
    const frag = buildLeaf(cond, ctx);
    andParts.push(frag.sql);
    Object.assign(params, frag.params);
  }

  if (searchBy.or.length > 0) {
    const orParts: string[] = [];
    for (const sub of searchBy.or) {
      const subFrag = buildSearchByFragment(sub, ctx);
      if (subFrag.sql) orParts.push(`(${subFrag.sql})`);
      Object.assign(params, subFrag.params);
    }
    if (orParts.length > 0) andParts.push(`(${orParts.join(" OR ")})`);
  }

  return { sql: andParts.join(" AND "), params };
}

/**
 * Apply a `ParsedSearchBy` inside a TypeORM `Brackets` callback. Caller is
 * responsible for wrapping with `qb.andWhere(new Brackets(b => applySearchByInside(b, ..., ctx)))`.
 */
export function applySearchByInside(
  qb: WhereExpressionBuilder,
  searchBy: ParsedSearchBy,
  ctx: WhereCtx,
): void {
  let first = true;
  for (const cond of searchBy.conditions) {
    applyCondition(qb, cond, ctx, first);
    first = false;
  }
  if (searchBy.or.length > 0) {
    const orBrackets = new Brackets((orQb) => {
      let orFirst = true;
      for (const sub of searchBy.or) {
        const sub_brackets = new Brackets((b) =>
          applySearchByInside(b, sub, ctx),
        );
        if (orFirst) orQb.where(sub_brackets);
        else orQb.orWhere(sub_brackets);
        orFirst = false;
      }
    });
    if (first) qb.where(orBrackets);
    else qb.andWhere(orBrackets);
    first = false;
  }
}

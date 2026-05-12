import { Brackets, type WhereExpressionBuilder } from "typeorm";
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
    };
    const brackets = new Brackets((sub) =>
      applySearchByInside(sub, cond.nested, subCtx),
    );
    if (isFirst) qb.where(brackets);
    else qb.andWhere(brackets);
    return;
  }
  const fragment = buildLeaf(cond, ctx);
  Object.assign(ctx.paramBag, fragment.params);
  if (isFirst) qb.where(fragment.sql, fragment.params);
  else qb.andWhere(fragment.sql, fragment.params);
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

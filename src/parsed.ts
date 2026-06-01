/**
 * Normalized, validated form of a GenQuery. Adapters operate on these types,
 * which means each adapter only sees one canonical shape per concept (no more
 * "string or object" unions).
 */

import type { NumericOp, SortOrder, StringSearchMode } from "./types";

export interface ParsedStringSearch {
  mode: StringSearchMode;
  contained: boolean;
  caseSensitive: boolean;
  value: string;
}

export interface ParsedNumberSearch {
  op: NumericOp;
  value: number;
}

export type ParsedDateSearch =
  | { kind: "exact"; value: Date }
  | { kind: "range"; before?: Date; after?: Date };

export interface ParsedBoolSearch {
  value: boolean;
}

export interface ParsedEnumSearch {
  value: string;
}

export interface ParsedIdSearch {
  value: string;
}

export interface ParsedNullCheck {
  /** `true` → IS NULL, `false` → IS NOT NULL. */
  isNull: boolean;
}

export interface ParsedEmptyCheck {
  /** `true` → IS NULL OR = '', `false` → IS NOT NULL AND <> ''. String-only. */
  isEmpty: boolean;
}

export type RelationOp = "some" | "every" | "none";

export type ParsedFieldCondition =
  | { kind: "string"; field: string; search: ParsedStringSearch }
  | { kind: "number"; field: string; search: ParsedNumberSearch }
  | { kind: "bool"; field: string; search: ParsedBoolSearch }
  | { kind: "date"; field: string; search: ParsedDateSearch }
  | { kind: "enum"; field: string; search: ParsedEnumSearch }
  | { kind: "id"; field: string; search: ParsedIdSearch }
  | { kind: "null"; field: string; check: ParsedNullCheck }
  | { kind: "empty"; field: string; check: ParsedEmptyCheck }
  | {
      kind: "relation";
      field: string;
      targetEntity: string;
      op: RelationOp;
      nested: ParsedSearchBy;
    };

export interface ParsedSearchBy {
  /** Conditions joined by AND. */
  conditions: ParsedFieldCondition[];
  /**
   * Each element is itself a full searchBy; elements are OR-ed together, and
   * the resulting OR group is AND-ed with `conditions`.
   */
  or: ParsedSearchBy[];
}

export interface ParsedOrderBy {
  field: string;
  order: SortOrder;
}

export type ParsedSelect =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "fields"; fields: string[] };

export type ParsedIncludeRelation =
  | { kind: "all" }
  | {
      kind: "fields";
      fields: string[];
      /** Nested relations to include recursively (multi-level include). */
      relations?: Record<string, ParsedIncludeRelation>;
    };

export type ParsedInclude =
  | { kind: "none" }
  | { kind: "all" }
  | { kind: "map"; relations: Record<string, ParsedIncludeRelation> };

export type ParsedPagination =
  | { kind: "all"; showNumber: boolean; showTotal: boolean }
  | { kind: "first"; showNumber: boolean; showTotal: boolean }
  | {
      kind: "page";
      page: number;
      perPage: number;
      showNumber: boolean;
      showTotal: boolean;
    };

/**
 * Shape returned by `engine.run` on executable adapters (e.g. TypeORM).
 * `current` / `total` are populated according to `pagination.showNumber` /
 * `pagination.showTotal` on the parsed query (both default to `true`).
 */
export interface PaginatedResult<T> {
  data: T[];
  /** Rows in this page. Present when `pagination.showNumber` is true. */
  current?: number;
  /**
   * Rows matching the query without pagination. Present when
   * `pagination.showTotal` is true. Sourced from `getManyAndCount`.
   */
  total?: number;
}

export interface ParsedQuery {
  rootEntity: string;
  orderBy?: ParsedOrderBy;
  searchBy?: ParsedSearchBy;
  include: ParsedInclude;
  select: ParsedSelect;
  pagination: ParsedPagination;
  /**
   * Server-side raw adapter args, merged by the adapter into the final query.
   * NOT from the wire — set by the backend (e.g. a repository) to run native
   * ORM filters/includes the DSL doesn't model, while still paginating through
   * the engine. For Prisma: `{ where, orderBy, include, select }`. `where` is
   * AND-merged with the parsed where; `orderBy`/`include`/`select` are used when
   * the parsed query doesn't set them.
   */
  baseArgs?: {
    where?: unknown;
    orderBy?: unknown;
    include?: unknown;
    select?: unknown;
  };
}

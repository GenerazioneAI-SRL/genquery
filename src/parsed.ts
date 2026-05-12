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

export type RelationOp = "some" | "every" | "none";

export type ParsedFieldCondition =
  | { kind: "string"; field: string; search: ParsedStringSearch }
  | { kind: "number"; field: string; search: ParsedNumberSearch }
  | { kind: "bool"; field: string; search: ParsedBoolSearch }
  | { kind: "date"; field: string; search: ParsedDateSearch }
  | { kind: "enum"; field: string; search: ParsedEnumSearch }
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
  | { kind: "fields"; fields: string[] };

export type ParsedInclude =
  | { kind: "none" }
  | { kind: "all" }
  | { kind: "map"; relations: Record<string, ParsedIncludeRelation> };

export type ParsedPagination =
  | { kind: "all" }
  | { kind: "first" }
  | { kind: "page"; page: number; perPage: number };

export interface ParsedQuery {
  rootEntity: string;
  orderBy?: ParsedOrderBy;
  searchBy?: ParsedSearchBy;
  include: ParsedInclude;
  select: ParsedSelect;
  pagination: ParsedPagination;
}

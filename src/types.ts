/**
 * Raw input types as accepted from the wire.
 *
 * These mirror the spec literally. Anything received from the frontend should
 * conform to `GenQueryInput`. Use the parser to validate + normalize into the
 * `Parsed*` types defined in `./parsed.ts`.
 *
 * The input types are generic on an entity type `T`. With `T = unknown`
 * (default) you get the loose, untyped form. Pass a concrete entity class
 * (`GenQueryInput<User>`) to get autocomplete and value-shape checking for
 * fields and relations.
 */

export type SortOrder = "asc" | "desc";
export type StringSearchMode = "splitword" | "exact" | "nativeregex";
export type NumericOp = ">" | "<" | ">=" | "<=" | "==";

/** Timezone offset. "Z" (UTC) or "+HH:MM" / "-HH:MM" (also "+HHMM" / "+HH"). */
export type OffsetInput = string;

export interface DateTimeObjectInput {
  year?: number;
  month?: number;
  day?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
  offset?: OffsetInput;
}

export type DateTimeInput = string | DateTimeObjectInput;

export interface NumericComparisonInput {
  operation?: NumericOp;
  value: number;
}

/**
 * Null-presence check, valid on any primitive field type (string, number,
 * boolean, date, enum).
 *
 *   { isNull: true }  → IS NULL
 *   { isNull: false } → IS NOT NULL
 */
export interface NullCheckInput {
  isNull: boolean;
}

/**
 * Empty-presence check, valid only on string fields. "Empty" means NULL or
 * the empty string `''`.
 *
 *   { isEmpty: true }  → (col IS NULL OR col = '')
 *   { isEmpty: false } → (col IS NOT NULL AND col <> '')
 */
export interface EmptyCheckInput {
  isEmpty: boolean;
}

export interface StringSearchObjectInput {
  mode?: StringSearchMode;
  contained?: boolean;
  /** Case-sensitive comparison. Defaults to `false` (case-insensitive). */
  caseSensitive?: boolean;
  value: string;
}

export type StringSearchInput =
  | string
  /** Membership: `field: [v1, v2, ...]` → IN. Empty arrays are rejected. */
  | readonly string[]
  | StringSearchObjectInput
  | NullCheckInput
  | EmptyCheckInput;

export interface DateRangeInput {
  before?: DateTimeInput;
  after?: DateTimeInput;
}

export type DateSearchInput = DateTimeInput | DateRangeInput | NullCheckInput;

export type NumberSearchInput =
  | number
  /** Membership: `field: [v1, v2, ...]` → IN. Empty arrays are rejected. */
  | readonly number[]
  | NumericComparisonInput
  | NullCheckInput;

export type BoolSearchInput = boolean | NullCheckInput;

// ----------------------------------------------------------------------------
// Type-level helpers: distinguish primitive fields from relation properties on
// an entity class, and map each field's TS type to the right search shape.
// ----------------------------------------------------------------------------

/** Detects the `any` type, which otherwise satisfies every conditional. */
type IsAny<T> = 0 extends 1 & T ? true : false;

/** True iff T is `unknown` or `any` — i.e. caller didn't constrain. */
type IsLoose<T> = IsAny<T> extends true
  ? true
  : unknown extends T
    ? true
    : false;

type Prim = string | number | boolean | Date;

/**
 * Picks the right search value shape for a single property's TS type.
 *
 * For string literal unions (enum-style), the value is strictly constrained
 * to the union members — both the enum member form (`UserRoles.admin`) and the
 * matching string literal (`"admin"`) compile. Arbitrary `string` variables
 * are rejected at compile time; cast them if you really need to pass them.
 */
type SearchValueFor<V> =
  [NonNullable<V>] extends [Date] ? DateSearchInput :
  [NonNullable<V>] extends [string]
    ? [string] extends [NonNullable<V>]
      ? StringSearchInput                                                 // V is exactly `string`
      : NonNullable<V> | `${NonNullable<V> & string}` | NullCheckInput   // enum literals (no isEmpty: enums are not empty-stringable)
    :
  [NonNullable<V>] extends [number] ? NumberSearchInput :
  [NonNullable<V>] extends [boolean] ? BoolSearchInput :
  [NonNullable<V>] extends [(infer U)[]] ? RelationFilterInput<NonNullable<U>> :
  [NonNullable<V>] extends [object] ? RelationFilterInput<NonNullable<V>> :
  unknown;

/**
 * Wrapper for relation filters with explicit cardinality operators. The short
 * form (a plain `SearchByInput`) is treated as implicit `some`.
 *
 *   posts: { title: "x" }                           // implicit some
 *   posts: { some:  { title: "x" } }                // explicit some
 *   posts: { every: { published: true } }
 *   posts: { none:  { draft: true } }
 *   posts: { some: { ... }, none: { ... } }         // multiple ops, AND-ed
 */
export type RelationFilterInput<T = unknown> =
  | SearchByInput<T>
  | {
      some?: SearchByInput<T>;
      every?: SearchByInput<T>;
      none?: SearchByInput<T>;
    };

/** Keys of T whose value is a primitive (string/number/boolean/Date). */
type FieldKeysOf<T> = {
  [K in keyof T]-?: [NonNullable<T[K]>] extends [Prim] ? K : never;
}[keyof T];

/** Keys of T whose value is a relation (array of object, or object). */
type RelationKeysOf<T> = {
  [K in keyof T]-?: [NonNullable<T[K]>] extends [Prim]
    ? never
    : [NonNullable<T[K]>] extends [object]
      ? K
      : never;
}[keyof T];

/** Strips relation arrays down to their element type. */
type RelationTargetOf<T, K extends keyof T> =
  [NonNullable<T[K]>] extends [(infer U)[]] ? NonNullable<U> :
  [NonNullable<T[K]>] extends [object] ? NonNullable<T[K]> :
  never;

// ----------------------------------------------------------------------------
// searchBy
// ----------------------------------------------------------------------------

/**
 * `searchBy` is a recursive object whose keys are field names of the current
 * entity, relation names of the current entity, or the literal `OR`.
 *
 * Values depend on the kind of field:
 *  - string field: `StringSearchInput`
 *  - number field: `NumberSearchInput`
 *  - boolean field: `BoolSearchInput`
 *  - date field:   `DateSearchInput`
 *  - relation:     a nested `SearchByInput` against the related entity
 *
 * The `OR` key is special: it takes an array of full `SearchByInput`s; matches
 * if any of them matches. All non-`OR` entries combine with AND.
 */
export type SearchByInput<T = unknown> = IsLoose<T> extends true
  ? LooseSearchByInput
  : TypedSearchByInput<T>;

export type LooseSearchByInput = {
  OR?: LooseSearchByInput[];
  [field: string]: unknown;
};

export type TypedSearchByInput<T> = {
  OR?: TypedSearchByInput<T>[];
} & {
  [K in Exclude<keyof T, "OR"> as [NonNullable<T[K]>] extends [Prim | object]
    ? K
    : never]?: SearchValueFor<T[K]>;
};

// ----------------------------------------------------------------------------
// orderBy
// ----------------------------------------------------------------------------

export interface OrderByObjectInput<TField extends string = string> {
  field: TField;
  order?: SortOrder;
}

export type OrderByInput<T = unknown> = IsLoose<T> extends true
  ? string | OrderByObjectInput<string>
  : FieldKeysOf<T> & string extends infer F extends string
    ? F | OrderByObjectInput<F>
    : never;

// ----------------------------------------------------------------------------
// include
// ----------------------------------------------------------------------------

export type IncludeFieldSpec = boolean;

// Tolleranza Prisma-style (0.12.1): boolean ammessi ovunque — true ≡ 'all',
// false ≡ omesso ('none' al top-level). Grammatica canonica: 'all'/'none'/oggetto.
export type IncludeRelationSpec<U = unknown> = IsLoose<U> extends true
  ? "all" | boolean | { [fieldOrRelation: string]: IncludeFieldSpec | IncludeRelationSpec }
  :
      | "all"
      | boolean
      | { [K in FieldKeysOf<U>]?: IncludeFieldSpec };

export type IncludeInput<T = unknown> = IsLoose<T> extends true
  ? "none" | "all" | boolean | { [relation: string]: IncludeRelationSpec }
  :
      | "none"
      | "all"
      | boolean
      | { [K in RelationKeysOf<T>]?: IncludeRelationSpec<RelationTargetOf<T, K>> };

// ----------------------------------------------------------------------------
// select
// ----------------------------------------------------------------------------

export type SelectInput<T = unknown> = IsLoose<T> extends true
  ? "none" | "all" | { [field: string]: boolean }
  :
      | "none"
      | "all"
      | { [K in FieldKeysOf<T>]?: boolean };

// ----------------------------------------------------------------------------
// pagination
// ----------------------------------------------------------------------------

export interface PaginationObjectInput {
  page?: number;
  perPage?: number;
  /** Include `current` (rows in this page) in the executed result. Default `true`. */
  showNumber?: boolean;
  /** Include `total` (rows matching the query without pagination) in the executed result. Default `true`. */
  showTotal?: boolean;
}
export type PaginationInput = "all" | "first" | PaginationObjectInput;

// ----------------------------------------------------------------------------
// Top-level
// ----------------------------------------------------------------------------

export interface GenQueryInput<T = unknown> {
  orderBy?: OrderByInput<T>;
  searchBy?: SearchByInput<T>;
  include?: IncludeInput<T>;
  select?: SelectInput<T>;
  pagination?: PaginationInput;
}

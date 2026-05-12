# Writing a genquery query

This document explains how to construct a `GenQueryInput` — the JSON object a client passes to a genquery-backed server. Read it end-to-end before generating client code.

## Top-level shape

```typescript
interface GenQueryInput {
  searchBy?:  SearchBy;
  orderBy?:   OrderBy;
  select?:    Select;
  include?:   Include;
  pagination?: Pagination;
}
```

All keys optional. `{}` is a valid query (returns all root-entity rows with defaults).

Defaults: `select = "all"`, `include = "none"`, `pagination = "all"`, `searchBy` / `orderBy` absent means no filter / no sort.

## searchBy

Recursive object. Keys are field names, relation names, or the literal `"OR"`. Non-`OR` siblings combine with AND. Value shape depends on the field type.

### String fields

Short form (default mode `splitword`, case-insensitive):

```json
{ "firstName": "mario rossi" }
```

`splitword` splits on whitespace and OR-matches each word (case-insensitive). Above matches rows whose `firstName` contains `"mario"` or `"rossi"`.

Object form:

```json
{
  "firstName": {
    "mode": "splitword" | "exact" | "nativeregex",
    "contained": false,
    "caseSensitive": false,
    "value": "mario"
  }
}
```

- `value` (required) — the search string
- `mode` (default `"splitword"`) — `"exact"` is equality, `"nativeregex"` passes value as a DB regex (PostgreSQL `~*` / `~`)
- `contained` (default `false`) — if `true`, wraps the value as a substring (`%value%`) for `splitword` and `exact`
- `caseSensitive` (default `false`) — applies to all modes including `nativeregex`

### Number fields

Short form (equality):

```json
{ "age": 30 }
```

Object form (comparison):

```json
{ "age": { "operation": ">=", "value": 18 } }
```

`operation` ∈ `">"`, `"<"`, `">="`, `"<="`, `"=="` (default). Sending the legacy `"type"` key is a hard error.

### Boolean fields

```json
{ "active": true }
```

### Date fields

Exact (ISO 8601 string):

```json
{ "createdAt": "2024-01-01T00:00:00Z" }
```

Or object form (all fields optional, default to epoch):

```json
{
  "createdAt": {
    "year": 2024, "month": 1, "day": 1,
    "hours": 0, "minutes": 0, "seconds": 0,
    "offset": "Z"
  }
}
```

`offset`: `"Z"`, `"+HH"`, `"+HHMM"`, `"+HH:MM"`, or negatives.

Range (`before` and/or `after`, at least one):

```json
{
  "createdAt": {
    "after":  "2024-01-01T00:00:00Z",
    "before": "2024-12-31T23:59:59Z"
  }
}
```

`after` is exclusive `>`, `before` is exclusive `<`.

### Enum fields

A single string matching the allowlist:

```json
{ "role": "admin" }
```

Anything outside the allowlist is rejected. No object form. For "any of N", use `OR`.

### Relation fields

Nested `searchBy` against the related entity. Matches rows with at least one related record satisfying the filter:

```json
{
  "posts": {
    "published": true,
    "title": "typescript"
  }
}
```

The nested object follows all the same rules — including further nested relations and OR.

### OR

Array of full `searchBy` objects, OR-combined, then AND-combined with siblings at the same level:

```json
{
  "searchBy": {
    "active": true,
    "OR": [
      { "firstName": "mario" },
      { "firstName": "luigi" }
    ]
  }
}
```

Translates to: `active = true AND (firstName ≈ mario OR firstName ≈ luigi)`. OR can nest inside relations and inside other OR branches.

## orderBy

Single primitive field. Short form defaults to `"desc"`:

```json
{ "orderBy": "createdAt" }
```

Object form:

```json
{ "orderBy": { "field": "lastName", "order": "asc" } }
```

Only root-entity primitive fields (string, number, boolean, date, enum) are sortable. One field per query.

## select

| Value | Behavior |
|-------|----------|
| `"all"` (default) | All declared fields |
| `"none"` | Primary key only |
| `{ field: true, ... }` | Only the listed fields (primary key always included) |

```json
{ "select": { "firstName": true, "email": true } }
```

Controls root-entity fields. Use `include` for relations.

## include

| Value | Behavior |
|-------|----------|
| `"none"` (default) | No relations |
| `"all"` | All relations, all their fields |
| `{ relation: spec, ... }` | Per-relation |

Per-relation spec: `"all"` or `{ field: true, ... }`.

```json
{
  "include": {
    "posts": { "title": true, "publishedAt": true },
    "tags": "all"
  }
}
```

Relations used in `searchBy` are joined for filtering automatically; `include` controls whether their rows are also returned.

## pagination

| Value | Behavior |
|-------|----------|
| `"all"` (default) | No limit |
| `"first"` | First match (`skip 0, take 1`) |
| `{ page, perPage }` | Page-based |

```json
{ "pagination": { "page": 2, "perPage": 25 } }
```

`page` is zero-indexed, defaults to `0`. `perPage` defaults to `20`, must be a positive integer.

## Validation errors

The parser throws `QueryValidationError` with a `message` and a dot-`path` to the offending location, e.g. `searchBy.posts.title.value`, `pagination.perPage`, `searchBy.role`.

Common messages:

- `Numeric comparison: 'operation' must be one of >, <, >=, <=, ==`
- `Numeric comparison: 'type' is not a valid key. Use 'operation' instead.`
- `Field 'role' must be one of: admin, moderator, user`
- `Unknown field or relation 'foo' on entity 'User'`
- `Date range must contain at least one of 'before' or 'after'`
- `String search: 'value' must be a string`
- `pagination.perPage must be a positive integer`

## Things to avoid

- Don't send `null` for unset filters — omit the key entirely.
- Don't send `"type"` for numeric comparison — use `"operation"`.
- Don't send unknown field/relation keys — the parser rejects them.
- Don't supply multiple sort fields — `orderBy` is single-field.
- Don't assume `caseSensitive: true` — string searches default to case-insensitive.

## Minimal client-side TypeScript

Paste this into the client to get autocomplete without depending on the server package:

```typescript
export type SortOrder = "asc" | "desc";
export type StringSearchMode = "splitword" | "exact" | "nativeregex";
export type NumericOp = ">" | "<" | ">=" | "<=" | "==";

export type DateTimeInput =
  | string
  | { year?: number; month?: number; day?: number;
      hours?: number; minutes?: number; seconds?: number;
      offset?: string };

export type StringSearchInput =
  | string
  | { mode?: StringSearchMode; contained?: boolean;
      caseSensitive?: boolean; value: string };

export type NumberSearchInput = number | { operation?: NumericOp; value: number };

export type DateSearchInput =
  | DateTimeInput
  | { before?: DateTimeInput; after?: DateTimeInput };

export type SearchByInput = { OR?: SearchByInput[]; [field: string]: unknown };

export type OrderByInput = string | { field: string; order?: SortOrder };
export type SelectInput  = "none" | "all" | { [field: string]: boolean };
export type IncludeInput =
  | "none" | "all"
  | { [relation: string]: "all" | { [field: string]: boolean } };
export type PaginationInput = "all" | "first" | { page?: number; perPage?: number };

export interface GenQueryInput {
  orderBy?:    OrderByInput;
  searchBy?:   SearchByInput;
  include?:    IncludeInput;
  select?:     SelectInput;
  pagination?: PaginationInput;
}
```

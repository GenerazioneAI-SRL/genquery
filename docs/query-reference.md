# Query reference

A `GenQueryInput` object has five optional top-level keys. All are optional; an empty object `{}` is a valid query that returns all records with default pagination.

```typescript
interface GenQueryInput {
  searchBy?:  SearchByInput;
  orderBy?:   OrderByInput;
  select?:    SelectInput;
  include?:   IncludeInput;
  pagination?: PaginationInput;
}
```

---

## searchBy

Filter conditions. All keys within a `searchBy` object are ANDed together. Use the special `OR` key for OR conditions.

### String fields

```json
{ "searchBy": { "firstName": "mario" } }
```

Short form (string) uses the default mode: `splitword`.

Object form to control the mode:

```json
{
  "searchBy": {
    "firstName": {
      "mode": "exact",
      "value": "Mario",
      "contained": false,
      "caseSensitive": false
    }
  }
}
```

Both `mode` and `type` are accepted as the key name (the spec uses both).

#### Search modes

| Mode | Behavior |
|------|----------|
| `splitword` (default) | Splits value on whitespace, matches any word; uses `LIKE` or `ILIKE` per `caseSensitive` |
| `exact` | Exact string match. With `contained: true`, uses `LIKE '%value%'` pattern. Operator picked per `caseSensitive` |
| `nativeregex` | Passes value to the DB regex operator (`~` if `caseSensitive: true`, `~*` otherwise) on PostgreSQL |

#### Flags

| Flag | Default | Effect |
|------|---------|--------|
| `contained` | `false` | If `true`, value is wrapped in `%...%` for substring match (applies to `splitword` and `exact`) |
| `caseSensitive` | `false` | If `true`, comparison is case-sensitive. Applies to all modes including `nativeregex` (switches `~*` → `~`) |

### Number fields

```json
{ "searchBy": { "age": 30 } }
```

Object form with comparison operator:

```json
{
  "searchBy": {
    "age": { "operation": ">=", "value": 18 }
  }
}
```

Operators: `">"`, `"<"`, `">="`, `"<="`, `"=="` (default).

### Boolean fields

```json
{ "searchBy": { "active": true } }
```

### Enum fields

A field declared as `{ type: "enum", values: [...] }` in the schema accepts only string values from the allowlist. Anything else is rejected by the parser with a friendly error.

```json
{ "searchBy": { "role": "admin" } }
```

Sending `{ "role": "invalid" }` errors with `Field 'role' must be one of: admin, moderator, user`. No object form — enums are exact equality only. With `schemaFromTypeORM`, columns declared as `@Column({ type: "enum", enum: SomeEnum })` are auto-detected and their allowed values extracted.

### Date fields

Exact date (ISO 8601 string):

```json
{ "searchBy": { "createdAt": "2024-01-01T00:00:00Z" } }
```

Object form for the date value:

```json
{
  "searchBy": {
    "createdAt": {
      "year": 2024,
      "month": 1,
      "day": 1,
      "offset": "Z"
    }
  }
}
```

All fields in the object form are optional; unspecified fields default to the epoch (`1970-01-01T00:00:00Z`). Offset accepts `"Z"`, `"±HH"`, `"±HHMM"`, `"±HH:MM"`.

Date range (`before` and/or `after`, both optional):

```json
{
  "searchBy": {
    "createdAt": {
      "after":  "2024-01-01T00:00:00Z",
      "before": "2024-12-31T23:59:59Z"
    }
  }
}
```

### Presence checks

Two presence-check forms are available as alternative values to a normal comparison:

**`isNull`** — any primitive field (string, number, boolean, date, enum) **that is declared nullable in the schema** (`{ type: ..., nullable: true }`). With `schemaFromTypeORM`, this is auto-populated from the column's `isNullable` metadata. Sending `isNull` on a non-nullable field is rejected at parse time.

```json
{ "searchBy": { "deletedAt": { "isNull": true } } }
{ "searchBy": { "phone":     { "isNull": false } } }
```

| Form | SQL |
|------|-----|
| `{ "isNull": true }`  | `IS NULL` |
| `{ "isNull": false }` | `IS NOT NULL` |

**`isEmpty`** — string fields only. "Empty" means NULL or the empty string `''`:

```json
{ "searchBy": { "phone": { "isEmpty": true } } }
```

| Form | SQL |
|------|-----|
| `{ "isEmpty": true }`  | `(col IS NULL OR col = '')` |
| `{ "isEmpty": false }` | `(col IS NOT NULL AND col <> '')` |

`isEmpty` on a non-string field is rejected at parse time. Unlike `isNull`, it works on non-nullable strings too — there it simply reduces to `= ''`.

Both keys may appear in the same object and are AND-ed (this requires the field to be nullable, since `isNull` does). The useful combination is "not null but blank":

```json
{ "searchBy": { "phone": { "isNull": false, "isEmpty": true } } }
```

→ `phone IS NOT NULL AND (phone IS NULL OR phone = '')` ≡ `phone = ''`.

### Relation fields

Filter by fields on a related entity. The short form is "at least one related row matches" (implicit `some`):

```json
{
  "searchBy": {
    "posts": {
      "title": "typescript"
    }
  }
}
```

Use explicit cardinality operators (`some` / `every` / `none`) for finer control. Multiple operators on the same relation are AND-ed:

```json
{
  "searchBy": {
    "posts": {
      "some":  { "title": "typescript" },
      "every": { "published": true },
      "none":  { "draft": true }
    }
  }
}
```

| Operator | SQL | Meaning |
|----------|-----|---------|
| `some` (or short form) | `EXISTS` via leftJoin | At least one related row matches |
| `every` | `NOT EXISTS (... AND NOT (condition))` | All related rows match (vacuously true if no rows) |
| `none` | `NOT EXISTS (... AND condition)` | No related row matches |

The relation must be declared in the schema. The nested object follows the same rules as a top-level `searchBy` — including further nested `some` for the implicit-some path.

**Limitations (Phase 1):**
- `every` / `none` support one-to-many, many-to-one, and one-to-one relations. Many-to-many isn't supported yet — use `some` (short form) for M2M filtering.
- Nested relation filters inside `every` or `none` (e.g. `posts.every(tags.some(...))`) are not yet supported; the parser will reject them with a clear error.

### OR conditions

```json
{
  "searchBy": {
    "OR": [
      { "firstName": "mario" },
      { "lastName":  "rossi" }
    ]
  }
}
```

Each element of `OR` is a full `searchBy` object. All elements are OR-ed. The `OR` array can coexist with other conditions at the same level; those conditions are ANDed with the result of the OR group.

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

This matches active users whose first name is "mario" or "luigi".

---

## orderBy

Sort by a field:

```json
{ "orderBy": "lastName" }
```

String shorthand defaults to `"desc"` order.

Object form:

```json
{ "orderBy": { "field": "createdAt", "order": "asc" } }
```

`order` defaults to `"desc"`.

---

## select

Control which root-entity fields are returned.

| Value | Behavior |
|-------|----------|
| `"all"` (default) | All fields |
| `"none"` | No fields (useful when you only want relations) |
| `{ field: true }` | Only the specified fields (primary key always included) |

```json
{ "select": { "firstName": true, "email": true } }
```

---

## include

Control which relations are joined and returned.

| Value | Behavior |
|-------|----------|
| `"none"` (default) | No relations |
| `"all"` | All declared relations, all their fields |
| `{ relation: spec }` | Per-relation control |

Per-relation spec:

```json
{
  "include": {
    "posts": { "title": true },
    "tags":  "all"
  }
}
```

- Object `{ field: true }` — only those fields from the relation
- `"all"` — all fields from the relation

Relations referenced in `searchBy` are automatically joined (for filtering); `include` controls what is selected in the result.

---

## pagination

| Value | Behavior |
|-------|----------|
| `"all"` (default) | No limit |
| `"first"` | Returns first match (skip 0, take 1) |
| `{ page, perPage }` | Page-based |

```json
{ "pagination": { "page": 2, "perPage": 25 } }
```

`page` defaults to `0`, `perPage` defaults to `20`.

`"first"` is equivalent to `{ page: 0, perPage: 1 }`. It sets `skip(0).take(1)` on the builder — whether you call `.getOne()` or `.getMany()` after is up to you.

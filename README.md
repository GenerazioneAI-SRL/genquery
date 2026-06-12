# genquery

ORM-agnostic JSON query language with a pluggable Prisma adapter.

Frontends send a `GenQueryInput` object. The backend validates it against a `Schema` and an adapter translates the result into ORM operations. The shipped adapter targets Prisma.

## Install

```bash
npm install @generazioneai/genquery
# Prisma client (peer; you almost certainly already have it)
npm install @prisma/client
```

## Quick start (Prisma)

```typescript
import { Prisma, PrismaClient } from "@prisma/client";
import { createPrismaEngine } from "@generazioneai/genquery/prisma";

const prisma = new PrismaClient();

// 1. One line to set up the schema (from the DMMF), adapter, and engine
const engine = createPrismaEngine(Prisma.dmmf.datamodel);

// 2. Run a query from a request body against a model delegate
const { data, current, total } = await engine.run(
  {
    searchBy: { firstName: "mario" },
    orderBy:  "createdAt",
    pagination: { page: 0, perPage: 20 },
  },
  "User",        // root entity name — Prisma delegates don't expose it
  prisma.user,   // target model delegate; entity type flows from this
);
// data:    User[]
// current: data.length   (omitted if pagination.showNumber === false)
// total:   match count   (via a parallel count; omitted if pagination.showTotal === false)
```

`engine.run` is async and returns `{ data, current?, total? }`. `current` and `total` are populated according to `pagination.showNumber` / `pagination.showTotal` (both default to `true`); setting `showTotal: false` skips the extra `count`.

`createPrismaEngine` is a thin wrapper around `schemaFromPrisma` → `new PrismaAdapter` → `new GenQueryEngine`. The root entity (`"User"`) must be passed explicitly — Prisma delegates don't expose their model name on a stable public API. The TS entity type is read from the delegate's `findMany` return.

If you only want the Prisma args object (custom chaining, transactions, your own `findMany` call), parse separately and call `runParsed`, which returns the args without executing:

```typescript
const parsed = engine.parse(input, "User");
const args   = engine.runParsed(parsed, prisma.user);   // { where, orderBy, skip, take, include, ... }
const rows   = await prisma.user.findMany(args);
```

Need fine-grained control? You can still build it manually:

```typescript
const schema  = schemaFromPrisma(Prisma.dmmf.datamodel, { overrides: { User: { meta: "string" } } });
const adapter = new PrismaAdapter(schema, { parallelCount: false });
const engine  = new GenQueryEngine({ adapter });   // schema is read from the adapter
```

Or pass the same options to `createPrismaEngine`:

```typescript
const engine = createPrismaEngine(Prisma.dmmf.datamodel, {
  schema:  { overrides: { User: { meta: "string" } } },
  adapter: { parallelCount: false },
});
```

## Core concepts

### Schema

The `Schema` describes your data model independently of any ORM. The parser uses it to reject unknown fields; the adapter uses it to know which fields are dates vs strings vs relations.

With Prisma, derive it from the generated DMMF — no duplication:

```typescript
import { schemaFromPrisma } from "@generazioneai/genquery/prisma";

const schema = schemaFromPrisma(Prisma.dmmf.datamodel);
// optional: restrict to specific models
const schema = schemaFromPrisma(Prisma.dmmf.datamodel, { models: ["User", "Post"] });
// optional: override fields with non-standard column types
const schema = schemaFromPrisma(Prisma.dmmf.datamodel, {
  overrides: { User: { preferences: "string" } },
});
```

Or declare one explicitly (no ORM, or fine-grained control):

```typescript
const schema: Schema = {
  entities: {
    EntityName: {
      name: "EntityName",
      primaryKey: "id",           // optional, defaults to "id"
      fields: {
        fieldName: { type: "string" | "number" | "boolean" | "date" },
      },
      relations: {
        relationName: { target: "OtherEntity", kind: "one" | "many" },
      },
    },
  },
};
```

### Query input

A `GenQueryInput` is a plain JSON object with five optional top-level keys.

The entity type is inferred automatically from the `target` argument when it has a recognizable shape (a Prisma model delegate exposes `findMany(args?): Promise<T[]>`). No explicit generic is required — autocomplete and value-shape checking flow from the delegate's entity type:

```typescript
// prisma.user is Prisma.UserDelegate — entity type flows into the call below
await engine.run(
  {
    searchBy: {
      firstName: "mario",                              // OK
      age: { operation: ">=", value: 18 },             // OK — number → comparison
      birthDate: { after: "2000-01-01T00:00:00Z" },    // OK — date → range
      posts: { title: "typescript" },                  // OK — relation → recursive
      // age: "x",       // ✗ type error: number field can't take a string
      // nope: "x",      // ✗ type error: 'nope' isn't a field on User
    },
    orderBy: { field: "lastName", order: "asc" },     // ✓ field constrained to User keys
    select:  { firstName: true },                      // ✓ only primitive fields
    include: { posts: "all" },                         // ✓ only relations
  },
  "User",
  prisma.user,
);
```

The inference distinguishes fields (primitives → searchable / selectable) from relations (objects/arrays → includable / recursive search), and picks the right value shape per field type (string/number/boolean/Date/enum).

If your target type doesn't expose the entity, the input falls back to a loose form where any key/value is accepted — the runtime parser still validates everything against the schema.

Top-level keys:

| Key | Default | Purpose |
|-----|---------|---------|
| `searchBy` | — | Filter conditions (AND + OR) |
| `orderBy` | — | Sort field and direction |
| `select` | `"all"` | Which fields to return (policy-denied fields are stripped from `"all"`) |
| `include` | `"none"` | Which relations to join |
| `pagination` | `"all"` | Page / limit |

Full query language reference: [docs/query-reference.md](docs/query-reference.md)

### Engine

`GenQueryEngine` is the public entry point. It reads the schema from the adapter — there is one source of truth.

```typescript
const engine = new GenQueryEngine({ adapter });   // schema comes from the adapter

// parse + apply + execute → Promise<{ data, current?, total? }>
await engine.run(input, rootEntity, target);

// parse only (requires explicit rootEntity)
const parsed = engine.parse(input, rootEntity);

// apply a previously parsed query without executing (returns the raw args object)
engine.runParsed(parsed, target);
```

### Policy (allowlist)

By default every field/relation that *exists* in the schema is queryable. A policy
restricts that surface per entity, so a frontend can read a field but not filter/sort on it,
not include an expensive relation, or not over-fetch a huge page. Enforced by the parser
(throws `QueryValidationError`); `maxPerPage` is *clamped*, not rejected.

As of 0.14.0, fields denied for `select` are also stripped from the *default* selection:
a query without an explicit `select` (i.e. `select: "all"`) gets a Prisma `omit` of the
denied fields, at the root and inside included relations — denied/secret fields never
come back, even unasked, while every other column (including ones the genquery schema
doesn't model, like `Json` or scalar arrays) keeps Prisma's default selection.

Low-level: optional flags on the schema (`filterable` / `sortable` / `selectable` on fields,
`includable` / `filterable` on relations, `maxPerPage` on entities — all default to allowed).

Ergonomic: declare allowlists by name and project them with `applyPolicy` (ORM-agnostic) or
the `policy` option of `schemaFromPrisma`.

```typescript
import { applyPolicy } from "@generazioneai/genquery";

const restricted = applyPolicy(schema, {
  User: {
    filterable: ["name", "email"],   // only these allowed in searchBy
    sortable:   ["createdAt"],        // only this in orderBy
    includable: ["posts"],            // only this relation in include
    maxPerPage: 100,                  // perPage > 100 is clamped to 100
  },
});
// per axis: array omitted = unrestricted · present = only-listed · empty = none
```

```typescript
// Prisma: build + restrict in one call
const schema = schemaFromPrisma(Prisma.dmmf.datamodel, {
  policy: { User: { filterable: ["name"], includable: ["posts"], maxPerPage: 100 } },
});
```

### Errors

Parse failures throw `QueryValidationError` with a `path` field pointing to the offending location in the input (e.g. `"searchBy.posts.title.value"`).

```typescript
import { QueryValidationError } from "@generazioneai/genquery";

try {
  await engine.run(input, "User", prisma.user);
} catch (e) {
  if (e instanceof QueryValidationError) {
    console.error(e.path, e.message);
  }
}
```

## Examples

See [docs/examples.md](docs/examples.md) for full worked examples covering:
- String search modes (splitword, exact — `nativeregex` is rejected by the Prisma adapter)
- Date ranges
- Numeric comparisons
- OR conditions
- Relation filtering and inclusion
- Pagination and sorting

## Architecture

Three layers, strictly separated:

```
Wire types (types.ts)
  └─ Parser validates + normalizes → Parsed types (parsed.ts)
       └─ Adapter consumes ParsedQuery + Schema → ORM output
```

Adapters never see wire types. New adapters implement `Adapter<TTarget, TResult>` (re-exported from the package root).

See [docs/custom-adapter.md](docs/custom-adapter.md) for instructions.

## Documentation

| File | Contents |
|------|----------|
| [docs/getting-started.md](docs/getting-started.md) | Installation, setup, first query |
| [docs/query-reference.md](docs/query-reference.md) | Full query language reference |
| [docs/prisma-adapter.md](docs/prisma-adapter.md) | Prisma adapter options and internals |
| [docs/custom-adapter.md](docs/custom-adapter.md) | Building a custom adapter |
| [docs/examples.md](docs/examples.md) | End-to-end examples |
| [spec.md](spec.md) | Source-of-truth wire format spec |

## License

[BSD 3-Clause](LICENSE)

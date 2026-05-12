# genquery

ORM-agnostic JSON query language with pluggable adapters.

Frontends send a `GenQueryInput` object. The backend validates it against a `Schema` and an adapter translates the result into ORM operations. The first adapter targets TypeORM (PostgreSQL-flavored SQL).

## Install

```bash
npm install @generazioneai/genquery
# TypeORM adapter (optional)
npm install typeorm
```

## Quick start (TypeORM)

```typescript
import "reflect-metadata";
import { DataSource } from "typeorm";
import { createTypeORMEngine } from "@generazioneai/genquery/typeorm";

// 1. Initialize TypeORM with your entity classes
const dataSource = new DataSource({ /* ... */ entities: [User, Post] });
await dataSource.initialize();

// 2. One line to set up the schema, adapter, and engine
const engine = createTypeORMEngine(dataSource);

// 3. Run a query from a request body
const qb = dataSource.getRepository(User).createQueryBuilder("User");

const result = engine.run(
  {
    searchBy: { firstName: "mario" },
    orderBy:  "createdAt",
    pagination: { page: 0, perPage: 20 },
  },
  qb,   // target QueryBuilder — entity name + entity type both read from this
);

const users = await result.getMany();
```

`createTypeORMEngine` is a thin wrapper around `schemaFromTypeORM` → `new TypeORMAdapter` → `new GenQueryEngine`. The root entity (`"User"` in this case) is derived from `qb.expressionMap.mainAlias.metadata.name` at runtime, and the TS entity type is read from `SelectQueryBuilder<User>`. If you need to override or your adapter can't introspect, the 3-arg form still works: `engine.run(input, "User", qb)`.

Need fine-grained control? You can still build it manually:

```typescript
const schema  = schemaFromTypeORM(dataSource, { overrides: { User: { meta: "string" } } });
const adapter = new TypeORMAdapter(schema, { paramPrefix: "q" });
const engine  = new GenQueryEngine({ adapter });   // schema is read from the adapter
```

Or pass the same options to `createTypeORMEngine`:

```typescript
const engine = createTypeORMEngine(dataSource, {
  schema:  { overrides: { User: { meta: "string" } } },
  adapter: { paramPrefix: "q" },
});
```

## Core concepts

### Schema

The `Schema` describes your data model independently of any ORM. The parser uses it to reject unknown fields; the adapter uses it to know which fields are dates vs strings vs relations.

With TypeORM, derive it from the DataSource — no duplication:

```typescript
import { schemaFromTypeORM } from "@generazioneai/genquery/typeorm";

const schema = schemaFromTypeORM(dataSource);
// optional: restrict to specific entities
const schema = schemaFromTypeORM(dataSource, { entities: [User, Post] });
// optional: override fields with non-standard column types
const schema = schemaFromTypeORM(dataSource, {
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

The entity type is inferred automatically from the `target` argument when it has a recognizable shape (e.g. a TypeORM `SelectQueryBuilder<User>`). No explicit generic is required — autocomplete and value-shape checking flow from the QueryBuilder's entity type:

```typescript
const qb = dataSource.getRepository(User).createQueryBuilder("User");
// qb is SelectQueryBuilder<User> — entity type flows into the call below

engine.run(
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
  qb,
);
```

The inference distinguishes fields (primitives → searchable / selectable) from relations (objects/arrays → includable / recursive search), and picks the right value shape per field type (string/number/boolean/Date/enum).

If your target type doesn't expose the entity (e.g. an adapter whose target is `undefined`), the input falls back to a loose form where any key/value is accepted — the runtime parser still validates everything against the schema.

Top-level keys:

| Key | Default | Purpose |
|-----|---------|---------|
| `searchBy` | — | Filter conditions (AND + OR) |
| `orderBy` | — | Sort field and direction |
| `select` | `"all"` | Which fields to return |
| `include` | `"none"` | Which relations to join |
| `pagination` | `"all"` | Page / limit |

Full query language reference: [docs/query-reference.md](docs/query-reference.md)

### Engine

`GenQueryEngine` is the public entry point. It asserts that the schema passed to it and the schema held by the adapter are the same instance.

```typescript
const engine = new GenQueryEngine({ adapter });   // schema comes from the adapter

// parse + apply (rootEntity derived from target when the adapter supports it)
engine.run(input, target);
// or explicit rootEntity:
engine.run(input, rootEntity, target);

// parse only (requires explicit rootEntity — no target to infer from)
const parsed = engine.parse(input, rootEntity);

// apply a previously parsed query
engine.runParsed(parsed, target);
```

### Errors

Parse failures throw `QueryValidationError` with a `path` field pointing to the offending location in the input (e.g. `"searchBy.posts.title.value"`).

```typescript
import { QueryValidationError } from "@generazioneai/genquery";

try {
  engine.run(input, "User", qb);
} catch (e) {
  if (e instanceof QueryValidationError) {
    console.error(e.path, e.message);
  }
}
```

## Examples

See [docs/examples.md](docs/examples.md) for full worked examples covering:
- String search modes (splitword, exact, nativeregex)
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
| [docs/typeorm-adapter.md](docs/typeorm-adapter.md) | TypeORM adapter options and internals |
| [docs/custom-adapter.md](docs/custom-adapter.md) | Building a custom adapter |
| [docs/examples.md](docs/examples.md) | End-to-end examples |
| [spec.md](spec.md) | Source-of-truth wire format spec |

## License

[BSD 3-Clause](LICENSE)

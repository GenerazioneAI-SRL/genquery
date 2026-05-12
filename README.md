# genquery

ORM-agnostic JSON query language with pluggable adapters.

Frontends send a `GenQueryInput` object. The backend validates it against a `Schema` and an adapter translates the result into ORM operations. The first adapter targets TypeORM (PostgreSQL-flavored SQL).

## Install

```bash
npm install genquery
# TypeORM adapter (optional)
npm install typeorm
```

## Quick start (TypeORM)

```typescript
import "reflect-metadata";
import { DataSource } from "typeorm";
import { GenQueryEngine } from "genquery";
import { TypeORMAdapter, schemaFromTypeORM } from "genquery/typeorm";

// 1. Initialize TypeORM with your entity classes (decorators do the work)
const dataSource = new DataSource({ /* ... */ entities: [User, Post] });
await dataSource.initialize();

// 2. Derive the genquery schema directly from TypeORM metadata
const schema  = schemaFromTypeORM(dataSource);
const adapter = new TypeORMAdapter(schema);
const engine  = new GenQueryEngine({ schema, adapter });

// 3. Run a query from a request body
const qb = dataSource.getRepository(User).createQueryBuilder("User");

const result = engine.run(
  {
    searchBy: { firstName: "mario" },
    orderBy:  "createdAt",
    pagination: { page: 0, perPage: 20 },
  },
  "User",  // root entity name (matches the TypeORM entity class name)
  qb,      // target QueryBuilder
);

const users = await result.getMany();
```

No separate schema definition — `schemaFromTypeORM` walks the DataSource's entity metadata (columns, relations, primary keys) and produces a `Schema` for you. You can still write one by hand if you need fine-grained control or don't use TypeORM.

## Core concepts

### Schema

The `Schema` describes your data model independently of any ORM. The parser uses it to reject unknown fields; the adapter uses it to know which fields are dates vs strings vs relations.

With TypeORM, derive it from the DataSource — no duplication:

```typescript
import { schemaFromTypeORM } from "genquery/typeorm";

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

By default the input is loosely typed (anything goes — useful when forwarding a request body straight through). Pass your TypeORM entity class as a generic parameter to get autocomplete and value-shape checking:

```typescript
const input: GenQueryInput<User> = {
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
};

engine.run<User>(input, "User", qb);  // same generic on run()
```

The generic distinguishes fields (primitives → searchable / selectable) from relations (objects/arrays → includable / recursive search), and picks the right value shape per field type (string/number/boolean/Date).

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
const engine = new GenQueryEngine({ schema, adapter });

// parse + apply in one step
engine.run(input, rootEntity, target);

// parse only
const parsed = engine.parse(input, rootEntity);

// apply a previously parsed query
engine.runParsed(parsed, target);
```

### Errors

Parse failures throw `QueryValidationError` with a `path` field pointing to the offending location in the input (e.g. `"searchBy.posts.title.value"`).

```typescript
import { QueryValidationError } from "genquery";

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

Adapters never see wire types. New adapters implement `Adapter<TTarget, TResult>` from `genquery/adapters/base`.

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

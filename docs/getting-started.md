# Getting started

## Prerequisites

- Node.js 18+
- TypeScript 5+

## Install

```bash
npm install genquery
```

If you use the TypeORM adapter, add it as a peer dependency:

```bash
npm install typeorm reflect-metadata
```

## Setup

### 1. Enable decorators in tsconfig.json

Required only for TypeORM entities, not for genquery itself:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

### 2. Derive the Schema from TypeORM

If you use TypeORM, you don't write a schema — `schemaFromTypeORM` reads your entity classes' metadata (columns, relations, primary keys) and produces one:

```typescript
import "reflect-metadata";
import { DataSource } from "typeorm";
import { schemaFromTypeORM } from "genquery/typeorm";

const dataSource = new DataSource({
  type: "postgres",
  // ...
  entities: [User, Post],
});

await dataSource.initialize();   // required before deriving

const schema = schemaFromTypeORM(dataSource);
```

Restrict to specific entities:

```typescript
const schema = schemaFromTypeORM(dataSource, { entities: [User, Post] });
```

Override fields whose column type isn't auto-detected (e.g. `jsonb`, custom transformers):

```typescript
const schema = schemaFromTypeORM(dataSource, {
  overrides: { User: { preferences: "string" } },
});
```

Type mapping (default):

| TypeORM column type | genquery `FieldType` |
|---|---|
| `String`, `varchar`, `text`, `char`, `uuid`, … | `string` |
| `Number`, `int`, `bigint`, `numeric`, `decimal`, `float`, `double`, … | `number` |
| `Boolean`, `bool` | `boolean` |
| `Date`, `timestamp`, `timestamptz`, `datetime`, `date`, `time`, … | `date` |
| `enum` / `simple-enum` with string members | `enum` (with `values` extracted) |
| anything else | skipped (use `overrides` or `fallback`) |

#### Declaring a schema by hand

If you don't use TypeORM, or want full control, declare a schema literal instead:

```typescript
import { Schema } from "genquery";

const schema: Schema = {
  entities: {
    User: {
      name: "User",
      primaryKey: "id",
      fields: {
        id:        { type: "number" },
        firstName: { type: "string" },
        // ...
      },
      relations: {
        posts: { target: "Post", kind: "many" },
      },
    },
    // ...
  },
};
```

### 3. Create the adapter and engine

```typescript
import { GenQueryEngine } from "genquery";
import { TypeORMAdapter } from "genquery/typeorm";

const adapter = new TypeORMAdapter(schema);
const engine  = new GenQueryEngine({ schema, adapter });
```

The `schema` passed to the engine and the `schema` held by the adapter **must be the same object instance**. The engine asserts this at construction time.

### 4. Wire it to a request handler

```typescript
import type { Request, Response } from "express";
import { QueryValidationError } from "genquery";

export async function listUsers(req: Request, res: Response) {
  const qb = userRepository.createQueryBuilder("User");

  try {
    const result = engine.run(req.body, "User", qb);
    res.json(await result.getMany());
  } catch (e) {
    if (e instanceof QueryValidationError) {
      res.status(400).json({ error: e.message, path: e.path });
    } else {
      throw e;
    }
  }
}
```

The `req.body` is the `GenQueryInput` the frontend sends. The engine validates it, rejects unknown fields, and builds the query.

## First query

Send this JSON body from the frontend:

```json
{
  "searchBy": {
    "firstName": "mario"
  },
  "orderBy": "lastName",
  "pagination": { "page": 0, "perPage": 10 }
}
```

The default string search mode is `splitword`, which splits the string on whitespace and matches any word case-insensitively (ILIKE). So `"mario rossi"` matches rows where the field contains `"mario"` OR `"rossi"`.

## Next steps

- [Query reference](query-reference.md) — all search modes, date ranges, OR conditions, include, select
- [TypeORM adapter](typeorm-adapter.md) — adapter options, execution order, debugging
- [Examples](examples.md) — realistic end-to-end examples

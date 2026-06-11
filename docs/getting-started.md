# Getting started

## Prerequisites

- Node.js 18+
- TypeScript 5+

## Install

```bash
npm install @generazioneai/genquery
```

If you use the Prisma adapter, add `@prisma/client` as a peer dependency:

```bash
npm install @prisma/client
```

## Setup

### 1. Derive the Schema from Prisma

If you use Prisma, you don't write a schema — `schemaFromPrisma` reads your Prisma DMMF datamodel (models, fields, relations, primary keys) and produces one:

```typescript
import { Prisma } from "@prisma/client";
import { schemaFromPrisma } from "@generazioneai/genquery/prisma";

const schema = schemaFromPrisma(Prisma.dmmf.datamodel);
```

Restrict to specific models:

```typescript
const schema = schemaFromPrisma(Prisma.dmmf.datamodel, { models: ["User", "Post"] });
```

Override fields whose scalar type isn't auto-detected (e.g. `Json`, `Bytes`):

```typescript
const schema = schemaFromPrisma(Prisma.dmmf.datamodel, {
  overrides: { User: { preferences: "string" } },
});
```

Type mapping (default):

| Prisma scalar type | genquery `FieldType` |
|---|---|
| `String` | `string` |
| `Int`, `BigInt`, `Float`, `Decimal` | `number` |
| `Boolean` | `boolean` |
| `DateTime` | `date` |
| an `enum` type | `enum` (with `values` extracted) |
| anything else (`Json`, `Bytes`, …) | skipped (use `overrides`) |

#### Declaring a schema by hand

If you don't use Prisma, or want full control, declare a schema literal instead:

```typescript
import { Schema } from "@generazioneai/genquery";

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

### 2. Create the adapter and engine

```typescript
import { GenQueryEngine } from "@generazioneai/genquery";
import { PrismaAdapter } from "@generazioneai/genquery/prisma";

const adapter = new PrismaAdapter(schema);
const engine  = new GenQueryEngine({ adapter });   // schema is read from the adapter
```

There's only one source of truth — the schema lives on the adapter, and the engine reads it from there.

#### One-line shortcut

`createPrismaEngine` does all three steps (`schemaFromPrisma` → `new PrismaAdapter` → `new GenQueryEngine`) in one call:

```typescript
import { Prisma } from "@prisma/client";
import { createPrismaEngine } from "@generazioneai/genquery/prisma";

const engine = createPrismaEngine(Prisma.dmmf.datamodel, {
  schema:  { models: ["User", "Post"] },   // schemaFromPrisma options
  adapter: { parallelCount: false },        // PrismaAdapter options
});
```

### 3. Wire it to a request handler

The Prisma adapter needs to know the root entity, and you pass it a Prisma **model delegate** (`prisma.user`):

```typescript
import type { Request, Response } from "express";
import { QueryValidationError } from "@generazioneai/genquery";

export async function listUsers(req: Request, res: Response) {
  try {
    const { data, current, total } = await engine.run(req.body, "User", prisma.user);
    res.json({ data, current, total });
  } catch (e) {
    if (e instanceof QueryValidationError) {
      res.status(400).json({ error: e.message, path: e.path });
    } else {
      throw e;
    }
  }
}
```

The `req.body` is the `GenQueryInput` the frontend sends. The engine validates it, rejects unknown fields, builds the Prisma args, executes `findMany`, and returns `{ data, current?, total? }`. `current` / `total` are included when `pagination.showNumber` / `pagination.showTotal` are `true` (both default to `true`); set `showTotal: false` in the input to skip the extra parallel `count` round-trip.

> The `rootEntity` string (`"User"`) is **required** for the Prisma adapter — a delegate doesn't expose its model name, so there is no 2-argument form of `engine.run`.

Need the raw Prisma args instead (custom `findFirst`, transactions, merging with hand-written options)? Use `runParsed`, which builds the args object without executing:

```typescript
const parsed = engine.parse(req.body, "User");
const args   = engine.runParsed(parsed, prisma.user);
// args === { where, orderBy, skip, take, include, select }
res.json(await prisma.user.findMany(args));
```

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

The default string search mode is `splitword`, which splits the string on whitespace and matches any word case-insensitively (`contains` + `mode: "insensitive"`). So `"mario rossi"` matches rows where the field contains `"mario"` OR `"rossi"`.

## Next steps

- [Query reference](query-reference.md) — all search modes, date ranges, OR conditions, include, select
- [Prisma adapter](prisma-adapter.md) — adapter options, build order, baseArgs, debugging
- [Examples](examples.md) — realistic end-to-end examples

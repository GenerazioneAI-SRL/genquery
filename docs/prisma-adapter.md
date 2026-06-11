# Prisma adapter

## Import

```typescript
import { createPrismaEngine, schemaFromPrisma, PrismaAdapter } from "@generazioneai/genquery/prisma";
```

`@prisma/client` must be installed as an optional peer dependency (`npm install @prisma/client`).

## One-line setup

`createPrismaEngine(datamodel, options?)` wires everything together: it derives the schema from your Prisma DMMF, builds a `PrismaAdapter`, and returns a ready `GenQueryEngine`.

```typescript
import { Prisma } from "@prisma/client";

const engine = createPrismaEngine(Prisma.dmmf.datamodel);
```

### Options

`options` forwards to the two stages it wraps:

| Option | Type | Description |
|--------|------|-------------|
| `schema` | `SchemaFromPrismaOptions` | Passed to `schemaFromPrisma` (`models`, `overrides`, `policy`) |
| `adapter` | `PrismaAdapterOptions` | Passed to `new PrismaAdapter` (`parallelCount`) |

```typescript
const engine = createPrismaEngine(Prisma.dmmf.datamodel, {
  schema: {
    models: ["User", "Post"],
    overrides: { User: { preferences: "string" } },
  },
  adapter: { parallelCount: false },
});
```

## Deriving the Schema

`schemaFromPrisma(datamodel, options?)` walks the DMMF datamodel and returns a genquery `Schema`: it indexes enums, builds an entity per model, maps scalar types, and derives each model's primary key.

```typescript
const schema = schemaFromPrisma(Prisma.dmmf.datamodel);
```

### Options

| Option | Type | Description |
|--------|------|-------------|
| `models` | `string[]` | Restrict to specific model names (by default all models are included) |
| `overrides` | `Record<Model, Record<field, FieldType>>` | Per-field type overrides; also adds fields that don't exist as Prisma columns |
| `policy` | `SchemaPolicy` | Default allow/deny policy baked into the schema (see `applyPolicy`) |

```typescript
const schema = schemaFromPrisma(Prisma.dmmf.datamodel, {
  models: ["User", "Post"],
  overrides: { User: { preferences: "string" } },
});
```

> The option that restricts which models are exposed is named `models` (not `entities`).

Relation kind mapping:

| Prisma relation | genquery `kind` |
|---|---|
| to-one (`User`, `User?`) | `"one"` |
| to-many (`User[]`) | `"many"` |

Scalar type mapping (default):

| Prisma scalar | genquery `FieldType` |
|---|---|
| `String` | `string` |
| `Int`, `BigInt`, `Float`, `Decimal` | `number` |
| `Boolean` | `boolean` |
| `DateTime` | `date` |
| an `enum` type | `enum` (with `values` extracted from the DMMF) |
| anything else (e.g. `Json`, `Bytes`) | skipped (use `overrides`) |

## Constructor

```typescript
const adapter = new PrismaAdapter(schema, options?);
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `parallelCount` | `boolean` | `true` | When `pagination.showTotal`, run the `count` query in parallel with `findMany`. Set `false` to run it sequentially. |

```typescript
const adapter = new PrismaAdapter(schema, { parallelCount: false });
```

Set `parallelCount: false` when your connection pool is small and you'd rather not hold two connections for a single request — the count then runs after the rows are fetched instead of alongside them.

> The adapter builds plain Prisma argument objects rather than raw SQL, so there are no SQL-parameter-naming options to configure.

## Target and result types

```typescript
Adapter<PrismaModelDelegate, PrismaFindManyArgs>
```

The target is a Prisma **model delegate** — `prisma.user`, `prisma.post`, etc. The entity type is inferred from the delegate's `findMany(args?): Promise<T[]>` signature.

The adapter implements both `apply` (sync, builds the args object) and `execute` (async, builds + runs the query). `engine.run` delegates to `execute` and returns `{ data, current?, total? }`:

```typescript
const { data, current, total } = await engine.run(input, "User", prisma.user);
```

### `rootEntity` is required

`getRootEntity` is **not implemented** for Prisma: a delegate doesn't expose its model name on a stable public API, so there's no way to infer it. You must always pass the `rootEntity` string explicitly — there is no 2-argument form of `engine.run` for this adapter:

```typescript
await engine.run(input, "User", prisma.user);   // ✅
await engine.run(input, prisma.user);            // ❌ throws — rootEntity missing
```

The result shape follows `pagination.showNumber` / `pagination.showTotal` (both default to `true`). When `showTotal` is `true`, the adapter runs a parallel `count` (one extra round-trip) and populates `total`; otherwise no count is issued and `total` is omitted.

## Getting the raw args object

If you need the raw Prisma args — to call `findFirst`, run inside a transaction, merge with hand-written options, or just inspect the query before executing — use `runParsed`, which builds the args without touching the database:

```typescript
const parsed = engine.parse(input, "User");
const args   = engine.runParsed(parsed, prisma.user);
// args === { where, orderBy, skip, take, include, select }
const users  = await prisma.user.findMany(args);
```

`runParsed` returns the plain object you'd hand to `prisma.user.findMany(args)` (or `findFirst`, a transaction client, etc.). It does **not** execute and does **not** issue the count query.

## Build order

`apply` / `buildArgs` assembles the args object in a fixed order:

1. **WHERE** — `buildWhere` builds the `where` clause (conditions AND-ed, the `or` array becomes a Prisma `OR` AND-ed with them)
2. **ORDER BY** — `{ [field]: order }`
3. **Pagination** — `skip` / `take`
4. **SELECT / INCLUDE** — `applySelectAndInclude` sets `select` / `include`
5. **`baseArgs` merge** — native Prisma options the DSL doesn't model (see below)

## baseArgs (raw native Prisma)

`query.baseArgs` lets the server inject native Prisma options the DSL doesn't express — typically a tenant/ownership filter or a forced relation include. It is merged **after** the DSL-derived args, with these rules:

| Key | Merge rule |
|-----|------------|
| `where` | **AND-merged** with the parsed where (`{ AND: [parsedWhere, baseArgs.where] }`) — the caller's filter cannot be dropped by user input |
| `orderBy` | Used **only when** the DSL didn't set an `orderBy` |
| `include` | Used **only when** the DSL didn't set an `include` |
| `select` | Used **only when** the DSL didn't set a `select` |

This makes `baseArgs.where` the safe place to put server-enforced scoping: a malicious client query can't override or remove it, because it's AND-ed on top.

## SELECT and INCLUDE

`applySelectAndInclude` translates the DSL's `select` and `include` into Prisma's `select` / `include` keys:

- `select: "all"` → no `select` key (Prisma returns all scalar fields)
- `select: "none"` / `{ field: true }` → a Prisma `select` object. **The primary key is always added** (`primaryKeyOf`), so relation hydration and id-keyed consumers keep working even when the caller asked for a narrow field set.
- `include: "none"` → no `include` key
- `include: "all"` / `{ relation: ... }` → a Prisma `include` object; per-relation field selection becomes a nested `select` on that relation.

Relations referenced in `searchBy` are joined for filtering via Prisma relation filters (`some` / `every` / `none`); `include` is what controls whether (and which of) their fields come back in the result.

## String search modes

| Mode | `contained` | Prisma `where` fragment |
|------|-------------|--------------------------|
| `splitword` | false | per word: `{ contains: word, mode: "insensitive" }`, OR-ed |
| `splitword` | true  | same — `contains` is already a substring match |
| `exact`     | false | `{ equals: value }` (`mode: "insensitive"` unless case-sensitive) |
| `exact`     | true  | `{ contains: value }` (`mode: "insensitive"` unless case-sensitive) |
| `nativeregex` | n/a | **rejected — see below** |

`splitword` splits the value on whitespace and OR-s each word; multi-word searches are lifted to a top-level `OR` by the caller so the field key isn't duplicated. `exact` uses `equals` (or `contains` when `contained`). Case-insensitivity is the default (`mode: "insensitive"`); request case-sensitive matching to drop the `mode` flag.

A string `{ isNull }` presence check expands to `{ OR: [{ field: null }, { field: "" }] }`.

### nativeregex is rejected

The Prisma adapter **throws** when it encounters `mode: "nativeregex"`:

> Prisma has no portable regex operator inside a `where` clause (PostgreSQL exposes it only through `$queryRaw`). Use `exact` or `splitword` instead.

This is deliberate, not a gap. The **parser** still accepts `nativeregex` so a hypothetical future executable-SQL adapter could support it, but the Prisma adapter rejects it at apply time with a clear error.

## Debugging

To inspect the args Prisma would receive before running anything, use `runParsed` (which doesn't execute) instead of `run`:

```typescript
const parsed = engine.parse(input, "User");
const args   = engine.runParsed(parsed, prisma.user);
console.log(JSON.stringify(args, null, 2));
// { where, orderBy, skip, take, include, select }
```

You can also enable Prisma's own query logging (`new PrismaClient({ log: ["query"] })`) to see the SQL the args compile to.

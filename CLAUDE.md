# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`genquery` is an ORM-agnostic JSON query language with pluggable adapters. Frontends send a `GenQueryInput` (defined by `spec.md`); the backend validates it against a `Schema` and an adapter translates the result into ORM operations. The shipped adapter targets Prisma (it produces `findMany` / `findFirst` argument objects and can execute them).

`spec.md` is the source of truth for the wire format. When changing parsing or adapter semantics, re-read it — `@` marks defaults and `*` marks required fields, and the `searchBy.OR` key is special-cased.

## Commands

- `npm run build` — `tsc` → emits to `dist/`
- `npm run typecheck` — `tsc --noEmit`, no emit
- `npm test` — `npm run build && node --test 'dist/tests/*.test.js'`. Tests live in `src/tests/` and run against the built output.

`@prisma/client` is an **optional peerDependency**. Anything under `src/adapters/prisma/` may reference Prisma's DMMF / client types; the rest of the library (parser, schema, engine) must stay ORM-agnostic and not import it.

## Architecture

Three layers, kept strictly separated:

1. **Wire types** (`src/types.ts`) — mirror `spec.md` literally, including unions like `string | { ... }`. Only the parser consumes these.
2. **Parsed types** (`src/parsed.ts`) — normalized tagged unions (`{ kind: "string" | "number" | "date" | "bool" | "relation", ... }`). Every default is materialized here so adapters see exactly one shape per concept. **Adapters must never look at wire types.**
3. **Adapters** (`src/adapters/*`) — consume `ParsedQuery` + `Schema`, produce ORM-specific output. The `Adapter<TTarget, TResult>` interface in `src/adapters/base.ts` is intentionally generic in both directions so different ORMs can have radically different signatures (the Prisma adapter takes a model delegate and returns a `findMany` arg object; another ORM could mutate a query builder instead).

The `Schema` (`src/schema.ts`) is required by both parser and adapter — it's what makes the JSON DSL safe (the parser rejects unknown fields/relations) and what tells the adapter which fields are dates vs strings vs relations. It can be declared by hand or derived from a Prisma DMMF datamodel via `schemaFromPrisma`.

`GenQueryEngine` (`src/engine.ts`) is the public glue. It reads the schema from the adapter, so the two cannot diverge. `run` parses + applies + executes (when the adapter implements `execute`); `runParsed` parses + applies only and returns the raw args object.

### Prisma adapter internals

`src/adapters/prisma/adapter.ts` — `PrismaAdapter` (`name = "prisma"`) implements `Adapter<PrismaModelDelegate, PrismaFindManyArgs>`:

- **`apply` / `buildArgs`** build a Prisma args object from a parsed query without touching the database. `build()` runs in a fixed order: WHERE (`buildWhere`), ORDER BY (`{ [field]: order }`), pagination, then SELECT/INCLUDE (`applySelectAndInclude`), and finally merges `query.baseArgs` — server-side raw native Prisma filters the DSL doesn't model. `baseArgs.where` is **AND-merged** with the parsed where; `orderBy` / `include` / `select` are only used when the parsed query didn't set them. The secret-strip `omit` never occupies `select` / `include`, so baseArgs precedence is identical to pre-0.14; a merged `baseArgs.select` (trusted, server-side) drops the `omit` (Prisma forbids `select`+`omit` at the same level).
- **`execute`** runs `findMany` (or `findFirst` for `pagination.kind === "first"`) and, when `pagination.showTotal`, a `count`. The count runs in parallel by default (`PrismaAdapterOptions.parallelCount`, set `false` to serialize when the client pools poorly).
- **`getRootEntity` is not implemented** — Prisma delegates don't expose their model name on a stable public API, so the `rootEntity` string must always be passed to `engine.run(input, rootEntity, delegate)`.

`src/adapters/prisma/where.ts` — `buildWhere` is the recursive core: conditions AND together, the `or` array becomes a Prisma `OR` clause AND-ed with the conditions. String search modes (`buildStringFilter`):
- `splitword` → words split on whitespace, each compared with `contains` + `mode: "insensitive"`, OR-ed. Multi-word searches produce a per-word OR that is lifted to a top-level `OR` by the caller (so the field key isn't duplicated).
- `exact` → `equals` (case-sensitive) or `contains` if `contained`; `mode: "insensitive"` unless case-sensitive.
- `nativeregex` → **rejected** with a clear error: Prisma has no portable regex operator in `where` (postgres supports it only via `$queryRaw`). Use `exact` or `splitword`.

A string `{ isNull }` presence check expands to `{ OR: [{ field: null }, { field: "" }] }`.

`src/adapters/prisma/select.ts` — `applySelectAndInclude` sets `args.select` / `args.include` / `args.omit`. Selected fields **always include the primary key** (`primaryKeyOf`) so hydration and relation joins work even when the caller asked for a narrow field set. As of 0.14.0, `select: "all"` on an entity with policy-denied fields (`selectable: false` — DEFAULT_SECRET_FIELDS / deny / allowlist) gets a Prisma `omit` of the denied names (`deniedOmit`) instead of relying on Prisma's default selection — every other column, including ones the schema doesn't model (Json / scalar arrays, tracked as `unmappedColumns`), is left untouched; relations included without an explicit field list get the same per-target stripping. Entities with no denied fields keep the historical behavior (no `omit` key emitted).

`src/adapters/prisma/schema-from-prisma.ts` — `schemaFromPrisma(datamodel, options)` derives a `Schema` from a Prisma DMMF datamodel: indexes enums, builds an entity per model, maps scalar types (skipped columns — Json/Bytes/scalar lists/unknown — are recorded as `unmappedColumns` so `applyPolicy` can still deny them for selection), and derives each model's primary key (`derivePrimaryKey`).

`src/adapters/prisma/create.ts` — `createPrismaEngine(datamodel, options)` is the one-line setup: read the schema from the DMMF, build the adapter, build the engine.

### Adding a new adapter

Create `src/adapters/<orm>/`, implement `Adapter<TTarget, TResult>` from `src/adapters/base.ts`, export it through a new package.json `exports` entry (and a matching `typesVersions` map), and add the ORM as an **optional** peerDependency. Do not import the new ORM from anywhere outside its adapter directory.

## Parser conventions

- `QueryValidationError` includes a dot-path to the offending location (e.g. `searchBy.posts.title.value`). Preserve this when adding new checks.
- The parser accepts both `mode` and `type` keys for string-search objects — `spec.md`'s example uses `type` while the prose uses `mode`. Don't "fix" this without updating the spec.
- `parseDateTime` (in `datetime.ts`) accepts either an ISO 8601 string or the object form from the spec, with `offset: "Z"` as default. The offset normalizer handles `Z`, `±HH`, `±HHMM`, `±HH:MM`.

## Things that look wrong but aren't

- `select.kind = "fields"` always re-adds the primary key. This is intentional — without it, relation hydration breaks and downstream consumers that key rows by id get `undefined`.
- `pagination.kind = "first"` maps to `findFirst` with `take: 1`, not a bare `findFirst()`. The take keeps the SQL bounded; `showNumber` / `showTotal` still apply.
- `nativeregex` being rejected by the Prisma adapter is deliberate, not an omission — there is no portable regex operator in a Prisma `where`. The parser still accepts the mode so a future executable-SQL adapter can support it.

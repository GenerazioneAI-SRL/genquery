# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`genquery` is an ORM-agnostic JSON query language with pluggable adapters. Frontends send a `GenQueryInput` (defined by `spec.md`); the backend validates it against a `Schema` and an adapter translates the result into ORM operations. The first adapter targets TypeORM (postgres-flavored SQL).

`spec.md` is the source of truth for the wire format. When changing parsing or adapter semantics, re-read it — `@` marks defaults and `*` marks required fields, and the `searchBy.OR` key is special-cased.

## Commands

- `npm run build` — `tsc` → emits to `dist/`
- `npm run typecheck` — `tsc --noEmit`, no emit
- No test runner is wired up. `package.json#scripts.test` points at a non-existent `dist/tests` dir; ad-hoc smoke scripts using `node` against the built output are the current verification path.

`typeorm` is an **optional peerDependency**. Anything under `src/adapters/typeorm/` imports it directly; the rest of the library must not.

## Architecture

Three layers, kept strictly separated:

1. **Wire types** (`src/types.ts`) — mirror `spec.md` literally, including unions like `string | { ... }`. Only the parser consumes these.
2. **Parsed types** (`src/parsed.ts`) — normalized tagged unions (`{ kind: "string" | "number" | "date" | "bool" | "relation", ... }`). Every default is materialized here so adapters see exactly one shape per concept. **Adapters must never look at wire types.**
3. **Adapters** (`src/adapters/*`) — consume `ParsedQuery` + `Schema`, produce ORM-specific output. The `Adapter<TTarget, TResult>` interface in `src/adapters/base.ts` is intentionally generic in both directions so different ORMs can have radically different signatures (e.g. TypeORM mutates a `SelectQueryBuilder`; a future Prisma adapter would return a `findMany` arg object).

The `Schema` (`src/schema.ts`) is required by both parser and adapter — it's what makes the JSON DSL safe (the parser rejects unknown fields/relations) and what tells the adapter which fields are dates vs strings vs relations. It is **not** derived from ORM metadata; the user declares it explicitly.

`GenQueryEngine` (`src/engine.ts`) is the public glue. It asserts that the schema given to the engine is the same instance as the adapter's schema — they must not diverge.

### TypeORM adapter internals

`src/adapters/typeorm/adapter.ts` runs in a fixed order that matters:

1. **Root `.select()`** first, because TypeORM's `.select()` *replaces* the entire selection list. Calling it after `leftJoinAndSelect` would wipe out joined columns.
2. **Joins**, planned by `joins.ts`. `planJoins` walks `include` (single-level per spec) and the searchBy tree (recursive, including OR branches). A relation referenced both for filtering and inclusion is joined once; selection rules upgrade `none → fields → all`.
3. **WHERE** via `Brackets`. `where.ts#applySearchByInside` is the recursive core: conditions AND together, `or` array is wrapped in its own `Brackets` and AND-ed with the conditions. Relation conditions resolve their alias through `AliasRegistry` (`aliases.ts`) — the join planner must have registered it first.
4. **ORDER BY**, then **pagination** (`skip`/`take`).

String search modes are implemented in `where.ts#buildString`:
- `splitword` → words split on whitespace, each compared with `ILIKE` (case-insensitive), OR-ed
- `exact` → `=` (case-sensitive) or `LIKE '%v%'` if `contained`
- `nativeregex` → postgres `~` operator, value passed unprocessed

All LIKE/ILIKE values flow through `escape.ts#escapeLike` to neutralize `%`, `_`, `\`. Parameters are namespaced through `ParamCounter` to avoid collisions between repeated uses of the same field.

`aliases.ts` truncates path-based aliases to stay under postgres' 63-char identifier limit and suffixes with a monotonic counter — don't shorten the truncation without that guarantee.

### Adding a new adapter

Create `src/adapters/<orm>/`, implement `Adapter<TTarget, TResult>` from `src/adapters/base.ts`, export it through a new package.json `exports` entry, and add the ORM as an **optional** peerDependency. Do not import the new ORM from anywhere outside its adapter directory.

## Parser conventions

- `QueryValidationError` includes a dot-path to the offending location (e.g. `searchBy.posts.title.value`). Preserve this when adding new checks.
- The parser accepts both `mode` and `type` keys for string-search objects — `spec.md`'s example uses `type` while the prose uses `mode`. Don't "fix" this without updating the spec.
- `parseDateTime` (in `datetime.ts`) accepts either an ISO 8601 string or the object form from the spec, with `offset: "Z"` as default. The offset normalizer handles `Z`, `±HH`, `±HHMM`, `±HH:MM`.

## Things that look wrong but aren't

- `select.kind = "fields"` always re-adds the primary key. This is intentional — without it, relation hydration and downstream `.getMany()` break.
- `pagination.kind = "first"` becomes `skip(0).take(1)`, not `.getOne()`. The adapter mutates a `SelectQueryBuilder`; what the caller does with it (`getOne`/`getMany`) is their choice.
- The unused `WhereCtx.schema` and `WhereCtx.paramBag` fields are kept for future use by relation-aware comparators and for adapters that want to collect params out-of-band.

# TypeORM adapter

## Import

```typescript
import { TypeORMAdapter, schemaFromTypeORM } from "@generazioneai/genquery/typeorm";
```

`typeorm` must be installed as a peer dependency (`npm install typeorm`).

## Deriving the Schema

`schemaFromTypeORM(dataSource, options?)` walks the DataSource's entity metadata and returns a genquery `Schema`. The DataSource must be initialized first.

```typescript
const schema = schemaFromTypeORM(dataSource);
```

### Options

| Option | Type | Description |
|--------|------|-------------|
| `entities` | `Array<Function \| string>` | Restrict to specific entity classes or entity names |
| `overrides` | `Record<entity, Record<field, FieldType>>` | Per-field type overrides; also adds fields that don't exist as TypeORM columns |
| `fallback` | `(entity, property, columnType) => FieldType \| undefined` | Called for unrecognized column types; return a FieldType to include, `undefined` to skip |

```typescript
const schema = schemaFromTypeORM(dataSource, {
  entities: [User, Post],
  overrides: { User: { preferences: "string" } },
  fallback: (entity, prop, t) => {
    if (typeof t === "string" && t.startsWith("jsonb")) return "string";
    return undefined;
  },
});
```

Relation kind mapping:

| TypeORM relation | genquery `kind` |
|---|---|
| `@OneToOne`, `@ManyToOne` | `"one"` |
| `@OneToMany`, `@ManyToMany` | `"many"` |

## Constructor

```typescript
const adapter = new TypeORMAdapter(schema, options?);
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `paramPrefix` | `string` | `"gq"` | Prefix for generated SQL parameter names |

```typescript
const adapter = new TypeORMAdapter(schema, { paramPrefix: "q" });
```

Use a custom prefix if you mix genquery parameters with hand-written parameters on the same `SelectQueryBuilder` to avoid collisions.

## Target and result types

```typescript
Adapter<SelectQueryBuilder<ObjectLiteral>, SelectQueryBuilder<ObjectLiteral>>
```

The TypeORM adapter implements both `apply` (sync, mutates the builder) and `execute` (async, applies + runs the query). `engine.run` delegates to `execute` and returns `{ data, current?, total? }`:

```typescript
const qb = repository.createQueryBuilder("User");
const { data, current, total } = await engine.run(input, "User", qb);
```

The result shape follows `pagination.showNumber` / `pagination.showTotal` (both default to `true`). When `showTotal` is `true`, the adapter uses `qb.getManyAndCount()` (one extra `SELECT COUNT(*)` round-trip); otherwise it uses `qb.getMany()` and `total` is omitted.

If you need the raw `SelectQueryBuilder` — for `.getOne()`, `.getRawMany()`, transactions, or hand-written chaining — use `runParsed`, which returns the mutated builder without executing:

```typescript
const parsed = engine.parse(input, "User");
const built  = engine.runParsed(parsed, qb);
const [users, count] = await built.getManyAndCount();
```

## Execution order

The adapter applies clauses in a fixed order that matters for TypeORM:

1. **`.select()`** — must happen first; TypeORM's `.select()` replaces the entire selection list, so calling it after joins would wipe out joined columns
2. **Joins** — `leftJoinAndSelect` for all relations referenced in `include` or `searchBy`
3. **WHERE** — wrapped in `Brackets` for correct AND/OR grouping
4. **ORDER BY**
5. **Pagination** — `skip` / `take`

## String search modes

The `caseSensitive` flag (default `false`) selects between case-sensitive and case-insensitive operators throughout. The table below shows the default (case-insensitive) form; with `caseSensitive: true`, `ILIKE` → `LIKE` and `~*` → `~`.

| Mode | `contained` | SQL (caseSensitive: false, default) | SQL (caseSensitive: true) |
|------|-------------|--------------------------------------|---------------------------|
| `splitword` | false | per word: `field ILIKE 'word'` OR-ed | per word: `field LIKE 'word'` OR-ed |
| `splitword` | true  | per word: `field ILIKE '%word%'` OR-ed | per word: `field LIKE '%word%'` OR-ed |
| `exact`     | false | `field ILIKE 'value'` | `field = $param` |
| `exact`     | true  | `field ILIKE '%value%'` | `field LIKE '%value%'` |
| `nativeregex` | n/a | `field ~* $param` | `field ~ $param` |

All LIKE/ILIKE values are escaped: `%`, `_`, and `\` are neutralized before the pattern is sent to the DB. `nativeregex` values are passed unprocessed — the user controls escape semantics.

## Alias management

TypeORM requires each joined relation to have a unique alias. The adapter builds aliases from the full relation path (e.g. `User__posts__comments`) and truncates them to stay under PostgreSQL's 63-character identifier limit, appending a monotonic counter to guarantee uniqueness.

If you add your own joins on the same builder, use a different prefix to avoid conflicts.

## Relation joins: filtering vs. selection

When a relation appears in both `searchBy` and `include`, it is joined exactly once. The join's selection level is determined by the most permissive rule:

```
none → fields → all
```

A relation joined only for filtering (`searchBy`) is joined with `leftJoin` (no columns selected). A relation in `include` is joined with `leftJoinAndSelect` using the fields specified.

## PostgreSQL vs. other databases

`splitword` mode uses `ILIKE` which is PostgreSQL-specific. On other databases (MySQL, SQLite, etc.) you must use `exact` or `nativeregex` for string searches — `ILIKE` will produce a SQL error.

`nativeregex` uses the PostgreSQL `~` operator and is PostgreSQL-only.

## Debugging

To inspect the generated SQL before execution, use `runParsed` (which doesn't execute) instead of `run`:

```typescript
const qb     = repository.createQueryBuilder("User");
const parsed = engine.parse(input, "User");
engine.runParsed(parsed, qb);
console.log(qb.getSql());
console.log(qb.getParameters());
```

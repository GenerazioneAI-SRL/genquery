# Custom adapter

An adapter translates a `ParsedQuery` into ORM-specific operations. It is generic in both the input target and the result:

```typescript
interface Adapter<TTarget, TResult> {
  readonly name: string;
  readonly schema: Schema;
  apply(target: TTarget, query: ParsedQuery): TResult;
  getRootEntity?(target: TTarget): string | undefined;
  execute?(target: TTarget, query: ParsedQuery): Promise<PaginatedResult<unknown>>;
}
```

`execute` is what `engine.run` calls. Implement it when your target is something you can run end-to-end (e.g. a query builder) so callers get `{ data, current?, total? }` directly. Pure args-builder adapters (Prisma, args-only Mongo) leave it unset and callers use `engine.parse` + `engine.runParsed` to obtain the args object.

## Minimal example

A Prisma adapter that builds a `findMany` args object:

```typescript
import type { Adapter } from "@generazioneai/genquery";
import type { Schema, ParsedQuery, ParsedFieldCondition } from "@generazioneai/genquery";

type PrismaWhere = Record<string, unknown>;

interface PrismaFindManyArgs {
  where?: PrismaWhere;
  orderBy?: Record<string, "asc" | "desc">;
  skip?: number;
  take?: number;
}

export class PrismaAdapter implements Adapter<undefined, PrismaFindManyArgs> {
  readonly name = "prisma";

  constructor(readonly schema: Schema) {}

  apply(_target: undefined, query: ParsedQuery): PrismaFindManyArgs {
    const args: PrismaFindManyArgs = {};

    if (query.searchBy) {
      args.where = this.buildWhere(query.searchBy);
    }

    if (query.orderBy) {
      args.orderBy = { [query.orderBy.field]: query.orderBy.order };
    }

    if (query.pagination.kind === "page") {
      args.skip = (query.pagination.page ?? 0) * (query.pagination.perPage ?? 20);
      args.take = query.pagination.perPage ?? 20;
    } else if (query.pagination.kind === "first") {
      args.skip = 0;
      args.take = 1;
    }

    return args;
  }

  private buildWhere(searchBy: ParsedQuery["searchBy"]): PrismaWhere {
    if (!searchBy) return {};
    const where: PrismaWhere = {};

    for (const cond of searchBy.conditions) {
      where[cond.field] = this.buildCondition(cond);
    }

    if (searchBy.or.length > 0) {
      where["OR"] = searchBy.or.map(o => this.buildWhere(o));
    }

    return where;
  }

  private buildCondition(cond: ParsedFieldCondition): unknown {
    switch (cond.kind) {
      case "string":
        if (cond.search.mode === "exact") {
          return cond.search.contained
            ? { contains: cond.search.value }
            : { equals: cond.search.value };
        }
        return { contains: cond.search.value, mode: "insensitive" };

      case "number":
        return { [cond.search.op === "==" ? "equals" : cond.search.op]: cond.search.value };

      case "bool":
        return { equals: cond.search };

      case "date":
        if (cond.search.kind === "exact") return { equals: cond.search.value };
        return {
          gte: cond.search.after,
          lte: cond.search.before,
        };

      case "relation":
        return { some: this.buildWhere(cond.nested) };
    }
  }
}
```

## Wire it up

```typescript
import { GenQueryEngine } from "@generazioneai/genquery";

const adapter = new PrismaAdapter(schema);
const engine  = new GenQueryEngine({ adapter });   // schema is read from the adapter

// PrismaAdapter doesn't implement execute(), so use parse + runParsed to get
// the args object. engine.run would throw at runtime for this adapter.
const parsed = engine.parse(input, "User");
const args   = engine.runParsed(parsed, undefined);
const users  = await prisma.user.findMany(args);
```

## Package structure

For adapters distributed as part of this package, follow the existing convention:

1. Create `src/adapters/<orm>/`
2. Implement `Adapter<TTarget, TResult>` from `src/adapters/base.ts`
3. Export from `src/adapters/<orm>/index.ts`
4. Add an `exports` entry in `package.json`:
   ```json
   "./myorm": {
     "types": "./dist/adapters/myorm/index.d.ts",
     "import": "./dist/adapters/myorm/index.js",
     "require": "./dist/adapters/myorm/index.js"
   }
   ```
5. Add the ORM as an **optional** peerDependency in `peerDependenciesMeta`
6. Never import the ORM from outside its adapter directory

## Parsed types reference

Your `apply` method receives a `ParsedQuery` where all defaults have been materialized. Key shapes:

```typescript
// searchBy conditions are a flat list + nested OR branches
query.searchBy?.conditions  // ParsedFieldCondition[]
query.searchBy?.or          // ParsedSearchBy[]

// Each condition is a tagged union
cond.kind  // "string" | "number" | "bool" | "date" | "relation"

// Pagination
query.pagination.kind        // "all" | "first" | "page"
query.pagination.page        // number (if kind === "page")
query.pagination.perPage     // number (if kind === "page")
query.pagination.showNumber  // boolean (always present, default true)
query.pagination.showTotal   // boolean (always present, default true)

// Select
query.select.kind   // "all" | "none" | "fields"
query.select.fields // string[] (if kind === "fields")

// Include
query.include.kind      // "none" | "all" | "map"
query.include.relations // Record<string, ParsedIncludeRelation> (if kind === "map")
```

See `src/parsed.ts` for the full type definitions.

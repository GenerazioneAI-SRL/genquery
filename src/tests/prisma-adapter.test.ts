import { strict as assert } from "node:assert";
import { test } from "node:test";
import { QueryValidationError } from "../errors";
import {
  PrismaAdapter,
  createPrismaEngine,
  schemaFromPrisma,
  type PrismaDatamodel,
} from "../adapters/prisma";
import { GenQueryEngine } from "../engine";
import type { Schema } from "../schema";

/**
 * Fixture: a minimal DMMF-shaped datamodel covering scalar, enum, and both
 * cardinalities of relations. Keeps the tests independent of any real Prisma
 * version — the structural type is what matters.
 */
const datamodel: PrismaDatamodel = {
  models: [
    {
      name: "User",
      fields: [
        { name: "id", kind: "scalar", type: "Int", isList: false, isRequired: true, isId: true },
        { name: "email", kind: "scalar", type: "String", isList: false, isRequired: true },
        { name: "name", kind: "scalar", type: "String", isList: false, isRequired: false },
        { name: "age", kind: "scalar", type: "Int", isList: false, isRequired: false },
        { name: "createdAt", kind: "scalar", type: "DateTime", isList: false, isRequired: true },
        { name: "role", kind: "enum", type: "Role", isList: false, isRequired: true },
        { name: "posts", kind: "object", type: "Post", isList: true, isRequired: true, relationName: "PostToUser" },
        { name: "profile", kind: "object", type: "Profile", isList: false, isRequired: false, relationName: "ProfileToUser" },
      ],
    },
    {
      name: "Post",
      fields: [
        { name: "id", kind: "scalar", type: "Int", isList: false, isRequired: true, isId: true },
        { name: "title", kind: "scalar", type: "String", isList: false, isRequired: true },
        { name: "published", kind: "scalar", type: "Boolean", isList: false, isRequired: true },
        { name: "authorId", kind: "scalar", type: "Int", isList: false, isRequired: true },
      ],
    },
    {
      name: "Profile",
      fields: [
        { name: "id", kind: "scalar", type: "Int", isList: false, isRequired: true, isId: true },
        { name: "bio", kind: "scalar", type: "String", isList: false, isRequired: false },
      ],
    },
  ],
  enums: [{ name: "Role", values: [{ name: "user" }, { name: "admin" }] }],
};

function makeAdapter(): { adapter: PrismaAdapter; schema: Schema } {
  const schema = schemaFromPrisma(datamodel);
  return { adapter: new PrismaAdapter(schema), schema };
}

function makeEngine() {
  return createPrismaEngine(datamodel);
}

// ---------- string searches ----------

test("splitword single word → equals + insensitive", () => {
  const engine = makeEngine();
  const parsed = engine.parse({ searchBy: { name: "mario" } }, "User");
  const args = engine.runParsed(parsed, null as never);
  assert.deepEqual(args, {
    where: { name: { equals: "mario", mode: "insensitive" } },
  });
});

test("splitword multi-word → OR per word", () => {
  const engine = makeEngine();
  const parsed = engine.parse(
    { searchBy: { name: "mario rossi" } },
    "User",
  );
  const args = engine.runParsed(parsed, null as never);
  assert.deepEqual(args, {
    where: {
      OR: [
        { name: { equals: "mario", mode: "insensitive" } },
        { name: { equals: "rossi", mode: "insensitive" } },
      ],
    },
  });
});

test("exact contained → contains + insensitive", () => {
  const engine = makeEngine();
  const parsed = engine.parse(
    {
      searchBy: {
        email: { mode: "exact", contained: true, value: "x.it" },
      },
    },
    "User",
  );
  const args = engine.runParsed(parsed, null as never);
  assert.deepEqual(args, {
    where: { email: { contains: "x.it", mode: "insensitive" } },
  });
});

test("exact case-sensitive → bare value (Prisma equality shorthand)", () => {
  const engine = makeEngine();
  const parsed = engine.parse(
    {
      searchBy: {
        email: { mode: "exact", caseSensitive: true, value: "mario@x.it" },
      },
    },
    "User",
  );
  const args = engine.runParsed(parsed, null as never);
  assert.deepEqual(args, { where: { email: "mario@x.it" } });
});

test("nativeregex → QueryValidationError", () => {
  const engine = makeEngine();
  assert.throws(
    () =>
      engine.parse(
        {
          searchBy: {
            name: { mode: "nativeregex", value: "^m" },
          },
        },
        "User",
      ).rootEntity &&
        engine.runParsed(
          engine.parse(
            { searchBy: { name: { mode: "nativeregex", value: "^m" } } },
            "User",
          ),
          null as never,
        ),
    (err: unknown) =>
      err instanceof QueryValidationError && /nativeregex/.test(err.message),
  );
});

// ---------- numbers / dates / bools ----------

test("numeric operations (>, <=, ==) map to gt/lte/equals", () => {
  const engine = makeEngine();
  const parsed = engine.parse(
    {
      searchBy: {
        OR: [
          { age: { operation: ">", value: 18 } },
          { age: { operation: "<=", value: 5 } },
          { age: 42 },
        ],
      },
    },
    "User",
  );
  const args = engine.runParsed(parsed, null as never) as any;
  assert.deepEqual(args.where.OR, [
    { age: { gt: 18 } },
    { age: { lte: 5 } },
    { age: { equals: 42 } },
  ]);
});

test("date range → gt / lt", () => {
  const engine = makeEngine();
  const parsed = engine.parse(
    {
      searchBy: {
        createdAt: {
          after: "2025-01-01T00:00:00Z",
          before: "2025-12-31T23:59:59Z",
        },
      },
    },
    "User",
  );
  const args = engine.runParsed(parsed, null as never) as any;
  assert.equal(args.where.createdAt.gt instanceof Date, true);
  assert.equal(args.where.createdAt.lt instanceof Date, true);
});

// ---------- presence checks ----------

test("isNull on nullable field → null", () => {
  const engine = makeEngine();
  const parsed = engine.parse(
    { searchBy: { name: { isNull: true } } },
    "User",
  );
  const args = engine.runParsed(parsed, null as never);
  assert.deepEqual(args, { where: { name: null } });
});

test("isEmpty true on string → OR null/''", () => {
  const engine = makeEngine();
  const parsed = engine.parse(
    { searchBy: { name: { isEmpty: true } } },
    "User",
  );
  const args = engine.runParsed(parsed, null as never);
  assert.deepEqual(args, {
    where: { OR: [{ name: null }, { name: "" }] },
  });
});

// ---------- enums ----------

test("enum field matches allowed values", () => {
  const engine = makeEngine();
  const parsed = engine.parse({ searchBy: { role: "admin" } }, "User");
  const args = engine.runParsed(parsed, null as never);
  assert.deepEqual(args, { where: { role: "admin" } });
});

test("enum rejects unknown values at parse time", () => {
  const engine = makeEngine();
  assert.throws(
    () => engine.parse({ searchBy: { role: "ghost" } }, "User"),
    (err: unknown) => err instanceof QueryValidationError,
  );
});

// ---------- relations ----------

test("many relation implicit `some`", () => {
  const engine = makeEngine();
  const parsed = engine.parse(
    { searchBy: { posts: { title: "hello" } } },
    "User",
  );
  const args = engine.runParsed(parsed, null as never);
  assert.deepEqual(args, {
    where: {
      posts: {
        some: { title: { equals: "hello", mode: "insensitive" } },
      },
    },
  });
});

test("many relation explicit every/none AND together", () => {
  const engine = makeEngine();
  const parsed = engine.parse(
    {
      searchBy: {
        posts: {
          every: { published: true },
          none: { title: { mode: "exact", value: "spam" } },
        },
      },
    },
    "User",
  );
  const args = engine.runParsed(parsed, null as never) as any;
  assert.equal(args.where.AND.length, 2);
  assert.deepEqual(args.where.AND[0], {
    posts: { every: { published: true } },
  });
  assert.deepEqual(args.where.AND[1], {
    posts: {
      none: { title: { equals: "spam", mode: "insensitive" } },
    },
  });
});

test("one-to-one relation uses is / isNot", () => {
  const engine = makeEngine();
  const parsed = engine.parse(
    {
      searchBy: {
        profile: { none: { bio: { isNull: true } } },
      },
    },
    "User",
  );
  const args = engine.runParsed(parsed, null as never);
  assert.deepEqual(args, {
    where: { profile: { isNot: { bio: null } } },
  });
});

// ---------- orderBy + pagination + select/include ----------

test("orderBy + page pagination → skip/take", () => {
  const engine = makeEngine();
  const parsed = engine.parse(
    {
      orderBy: { field: "createdAt", order: "asc" },
      pagination: { page: 3, perPage: 10 },
    },
    "User",
  );
  const args = engine.runParsed(parsed, null as never);
  assert.deepEqual(args, {
    orderBy: { createdAt: "asc" },
    skip: 30,
    take: 10,
  });
});

test("pagination=first → take 1 (no skip)", () => {
  const engine = makeEngine();
  const parsed = engine.parse({ pagination: "first" }, "User");
  const args = engine.runParsed(parsed, null as never);
  assert.deepEqual(args, { take: 1 });
});

test("select fields auto-includes PK", () => {
  const engine = makeEngine();
  const parsed = engine.parse(
    { select: { email: true, name: true } },
    "User",
  );
  const args = engine.runParsed(parsed, null as never);
  assert.deepEqual(args, {
    select: { email: true, name: true, id: true },
  });
});

test("include 'all' on plain select=all → use `include`", () => {
  const engine = makeEngine();
  const parsed = engine.parse({ include: "all" }, "User");
  const args = engine.runParsed(parsed, null as never) as any;
  assert.deepEqual(args.include, { posts: true, profile: true });
  assert.equal(args.select, undefined);
});

test("include Prisma-style: true ≡ 'all' (top-level e per-relazione)", () => {
  const engine = makeEngine();
  // include: true ≡ include: 'all'
  const all = engine.runParsed(engine.parse({ include: true } as any, "User"), null as never) as any;
  assert.deepEqual(all.include, { posts: true, profile: true });
  // valore boolean sulla singola relazione (shape che inviano FE e federazione)
  const rel = engine.runParsed(
    engine.parse({ include: { posts: true } } as any, "User"),
    null as never,
  ) as any;
  assert.deepEqual(rel.include, { posts: true });
});

test("include Prisma-style: false/null ≡ omesso (niente errore)", () => {
  const engine = makeEngine();
  const args = engine.runParsed(
    engine.parse({ include: { posts: false, profile: null } } as any, "User"),
    null as never,
  ) as any;
  assert.equal(args.include, undefined);
  // include: false ≡ 'none'
  const none = engine.runParsed(engine.parse({ include: false } as any, "User"), null as never) as any;
  assert.equal(none.include, undefined);
});

test("include is nested under select when select≠all", () => {
  const engine = makeEngine();
  const parsed = engine.parse(
    {
      select: { email: true },
      include: { posts: { title: true } },
    },
    "User",
  );
  const args = engine.runParsed(parsed, null as never) as any;
  assert.deepEqual(args.select, {
    email: true,
    id: true,
    posts: { select: { title: true, id: true } },
  });
  assert.equal(args.include, undefined);
});

// ---------- execute ----------

test("execute() runs findMany + parallel count", async () => {
  const { adapter } = makeAdapter();
  const findManyArgs: unknown[] = [];
  const countArgs: unknown[] = [];
  const delegate: any = {
    async findMany(args: unknown) {
      findManyArgs.push(args);
      return [{ id: 1 }, { id: 2 }, { id: 3 }];
    },
    async findFirst() {
      throw new Error("not expected");
    },
    async count(args: unknown) {
      countArgs.push(args);
      return 17;
    },
  };
  const engine = new GenQueryEngine({ adapter });
  const result = await engine.run(
    { searchBy: { email: { mode: "exact", value: "x" } } },
    "User",
    delegate,
  );
  assert.deepEqual(result.data, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(result.current, 3);
  assert.equal(result.total, 17);
  assert.equal(findManyArgs.length, 1);
  assert.equal(countArgs.length, 1);
  assert.deepEqual(countArgs[0], {
    where: { email: { equals: "x", mode: "insensitive" } },
  });
});

test("execute() with pagination=first → findFirst, no findMany", async () => {
  const { adapter } = makeAdapter();
  let findManyCalled = false;
  let findFirstCalled = false;
  const delegate: any = {
    async findMany() {
      findManyCalled = true;
      return [];
    },
    async findFirst() {
      findFirstCalled = true;
      return { id: 99, email: "x" };
    },
    async count() {
      return 1;
    },
  };
  const engine = new GenQueryEngine({ adapter });
  const result = await engine.run({ pagination: "first" }, "User", delegate);
  assert.equal(findManyCalled, false);
  assert.equal(findFirstCalled, true);
  assert.deepEqual(result.data, [{ id: 99, email: "x" }]);
});

test("execute() with showTotal=false skips count entirely", async () => {
  const { adapter } = makeAdapter();
  let countCalled = false;
  const delegate: any = {
    async findMany() {
      return [{ id: 1 }];
    },
    async findFirst() {
      return null;
    },
    async count() {
      countCalled = true;
      return 0;
    },
  };
  const engine = new GenQueryEngine({ adapter });
  const result = await engine.run(
    { pagination: { perPage: 5, showTotal: false } },
    "User",
    delegate,
  );
  assert.equal(countCalled, false);
  assert.equal(result.total, undefined);
  assert.equal(result.current, 1);
});

// ---------- schemaFromPrisma sanity ----------

test("schemaFromPrisma respects isRequired → nullable", () => {
  const schema = schemaFromPrisma(datamodel);
  const user = schema.entities.User;
  assert.equal(user.fields.email.nullable, false);
  assert.equal(user.fields.name.nullable, true);
  assert.equal(user.primaryKey, "id");
  assert.equal(user.fields.role.type, "enum");
  assert.deepEqual(
    (user.fields.role as { values: readonly string[] }).values,
    ["user", "admin"],
  );
  assert.equal(user.relations?.posts.kind, "many");
  assert.equal(user.relations?.profile.kind, "one");
});

test("model filter restricts entities", () => {
  const schema = schemaFromPrisma(datamodel, { models: ["User", "Post"] });
  assert.equal(Object.keys(schema.entities).length, 2);
  assert.equal(schema.entities.Profile, undefined);
});

// ── IN (membership): `field: [v1, v2, ...]` ────────────────────────────────

test("array on string field → IN", () => {
  const engine = makeEngine();
  const parsed = engine.parse(
    { searchBy: { email: ["a@x.it", "b@x.it"] } },
    "User",
  );
  const args = engine.runParsed(parsed, null as never);
  assert.deepEqual(args, { where: { email: { in: ["a@x.it", "b@x.it"] } } });
});

test("array on enum field validates allowed values", () => {
  const engine = makeEngine();
  const parsed = engine.parse({ searchBy: { role: ["admin", "user"] } }, "User");
  const args = engine.runParsed(parsed, null as never);
  assert.deepEqual(args, { where: { role: { in: ["admin", "user"] } } });
  assert.throws(
    () => engine.parse({ searchBy: { role: ["NOPE"] } }, "User"),
    QueryValidationError,
  );
});

test("array on number field → IN; mixed types rejected", () => {
  const engine = makeEngine();
  const parsed = engine.parse({ searchBy: { age: [18, 21] } }, "User");
  const args = engine.runParsed(parsed, null as never);
  assert.deepEqual(args, { where: { age: { in: [18, 21] } } });
  assert.throws(
    () => engine.parse({ searchBy: { age: ["18"] } }, "User"),
    QueryValidationError,
  );
});

test("empty array and date/bool arrays are rejected", () => {
  const engine = makeEngine();
  assert.throws(
    () => engine.parse({ searchBy: { email: [] } }, "User"),
    QueryValidationError,
  );
  assert.throws(
    () => engine.parse({ searchBy: { createdAt: ["2024-01-01"] } }, "User"),
    QueryValidationError,
  );
});

// ── IN / NOT IN object form: `{ in: [...] }` / `{ notIn: [...] }` ───────────

test("object form { in } on string field → IN", () => {
  const engine = makeEngine();
  const parsed = engine.parse(
    { searchBy: { email: { in: ["a@x.it", "b@x.it"] } } },
    "User",
  );
  const args = engine.runParsed(parsed, null as never);
  assert.deepEqual(args, { where: { email: { in: ["a@x.it", "b@x.it"] } } });
});

test("object form { notIn } on string field → NOT IN", () => {
  const engine = makeEngine();
  const parsed = engine.parse(
    { searchBy: { email: { notIn: ["a@x.it", "b@x.it"] } } },
    "User",
  );
  const args = engine.runParsed(parsed, null as never);
  assert.deepEqual(args, { where: { email: { notIn: ["a@x.it", "b@x.it"] } } });
});

test("object form { notIn } on number field → NOT IN", () => {
  const engine = makeEngine();
  const parsed = engine.parse({ searchBy: { age: { notIn: [18, 21] } } }, "User");
  const args = engine.runParsed(parsed, null as never);
  assert.deepEqual(args, { where: { age: { notIn: [18, 21] } } });
});

test("object form allows empty list (in → none, notIn → all)", () => {
  const engine = makeEngine();
  const inArgs = engine.runParsed(
    engine.parse({ searchBy: { email: { in: [] } } }, "User"),
    null as never,
  );
  assert.deepEqual(inArgs, { where: { email: { in: [] } } });
  const notInArgs = engine.runParsed(
    engine.parse({ searchBy: { email: { notIn: [] } } }, "User"),
    null as never,
  );
  assert.deepEqual(notInArgs, { where: { email: { notIn: [] } } });
});

test("object form rejects combining in and notIn, and non-array values", () => {
  const engine = makeEngine();
  assert.throws(
    () => engine.parse({ searchBy: { email: { in: ["a"], notIn: ["b"] } } }, "User"),
    QueryValidationError,
  );
  assert.throws(
    () => engine.parse({ searchBy: { email: { in: "a@x.it" } } }, "User"),
    QueryValidationError,
  );
});

// --- @db.Uuid scalar → exact match (id), not ILIKE string search (0.14.2) ---
// Regression: a Postgres `uuid` column that is neither a PK nor a relation FK
// (e.g. a cross-service semantic link like `learnerId`) was classified as a
// `string` field → genquery emitted `contains` / `mode: insensitive` → Prisma
// `ILIKE` → DB error `operator does not exist: uuid ~~* unknown`.
test("schemaFromPrisma: @db.Uuid scalar is typed as id (exact match)", () => {
  const dm: PrismaDatamodel = {
    models: [
      {
        name: "ExamTry",
        fields: [
          { name: "id", kind: "scalar", type: "String", isList: false, isRequired: true, isId: true, nativeType: ["Uuid", []] },
          { name: "learnerId", kind: "scalar", type: "String", isList: false, isRequired: true, nativeType: ["Uuid", []] },
          { name: "label", kind: "scalar", type: "String", isList: false, isRequired: false },
        ],
      },
    ],
    enums: [],
  };
  const schema = schemaFromPrisma(dm);
  const fields = schema.entities.ExamTry.fields;
  // uuid scalar with no relation → id (exact), NOT string
  assert.equal(fields.learnerId.type, "id");
  // plain string stays a string (text search still works)
  assert.equal(fields.label.type, "string");
});

test("buildArgs: filtering a @db.Uuid scalar emits equals, not contains/ILIKE", () => {
  const dm: PrismaDatamodel = {
    models: [
      {
        name: "ExamTry",
        fields: [
          { name: "id", kind: "scalar", type: "String", isList: false, isRequired: true, isId: true, nativeType: ["Uuid", []] },
          { name: "learnerId", kind: "scalar", type: "String", isList: false, isRequired: true, nativeType: ["Uuid", []] },
        ],
      },
    ],
    enums: [],
  };
  const engine = createPrismaEngine(dm);
  const uuid = "0672976f-0000-4000-8000-000000000000";
  const args = engine.runParsed(
    engine.parse({ searchBy: { learnerId: uuid } }, "ExamTry"),
    {} as any,
  );
  // exact equality (shorthand), no { contains, mode: "insensitive" }
  assert.deepEqual(args.where, { learnerId: uuid });
});

test("buildArgs: a @db.Uuid scalar supports IN lists", () => {
  const dm: PrismaDatamodel = {
    models: [
      {
        name: "ExamTry",
        fields: [
          { name: "id", kind: "scalar", type: "String", isList: false, isRequired: true, isId: true, nativeType: ["Uuid", []] },
          { name: "learnerId", kind: "scalar", type: "String", isList: false, isRequired: true, nativeType: ["Uuid", []] },
        ],
      },
    ],
    enums: [],
  };
  const engine = createPrismaEngine(dm);
  const a = "0672976f-0000-4000-8000-000000000001";
  const b = "0672976f-0000-4000-8000-000000000002";
  const args = engine.runParsed(
    engine.parse({ searchBy: { learnerId: [a, b] } }, "ExamTry"),
    {} as any,
  );
  assert.deepEqual(args.where, { learnerId: { in: [a, b] } });
});

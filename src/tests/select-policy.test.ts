import { strict as assert } from "node:assert";
import { test } from "node:test";
import { QueryValidationError } from "../errors";
import { buildGenQueryPolicy } from "../entity-policy-builder";
import { createPrismaEngine, type PrismaDatamodel } from "../adapters/prisma";

/**
 * Secret-strip on default select: when the policy denies fields (`selectable:
 * false` — e.g. DEFAULT_SECRET_FIELDS), a query WITHOUT an explicit select
 * (select='all') must NOT return them. The adapter emits a Prisma `omit` of
 * the denied names — at the root AND inside included relations — so every
 * OTHER column keeps Prisma's default selection, including ones the genquery
 * schema doesn't model (Json, scalar arrays, ...).
 *
 * Fixture: User carries two DEFAULT_SECRET_FIELDS (`password`, `totpSecret`)
 * plus columns `schemaFromPrisma` skips (`roles` String[], `metadata` Json,
 * `recoveryCodes` String[]) which must survive the strip untouched; Post /
 * Profile / Tag have no denied fields (regression guard for the common case,
 * which must keep emitting NO `omit` key at all).
 */
const datamodel: PrismaDatamodel = {
  models: [
    {
      name: "User",
      fields: [
        { name: "id", kind: "scalar", type: "Int", isList: false, isRequired: true, isId: true },
        { name: "email", kind: "scalar", type: "String", isList: false, isRequired: true },
        { name: "name", kind: "scalar", type: "String", isList: false, isRequired: false },
        { name: "password", kind: "scalar", type: "String", isList: false, isRequired: true },
        { name: "totpSecret", kind: "scalar", type: "String", isList: false, isRequired: false },
        { name: "roles", kind: "scalar", type: "String", isList: true, isRequired: true },
        { name: "metadata", kind: "scalar", type: "Json", isList: false, isRequired: false },
        { name: "recoveryCodes", kind: "scalar", type: "String", isList: true, isRequired: true },
        { name: "posts", kind: "object", type: "Post", isList: true, isRequired: true, relationName: "PostToUser" },
        { name: "profile", kind: "object", type: "Profile", isList: false, isRequired: false, relationName: "ProfileToUser" },
      ],
    },
    {
      name: "Post",
      fields: [
        { name: "id", kind: "scalar", type: "Int", isList: false, isRequired: true, isId: true },
        { name: "title", kind: "scalar", type: "String", isList: false, isRequired: true },
        { name: "authorId", kind: "scalar", type: "Int", isList: false, isRequired: true },
        { name: "author", kind: "object", type: "User", isList: false, isRequired: true, relationName: "PostToUser", relationFromFields: ["authorId"] },
        { name: "tags", kind: "object", type: "Tag", isList: true, isRequired: true, relationName: "PostToTag" },
      ],
    },
    {
      name: "Profile",
      fields: [
        { name: "id", kind: "scalar", type: "Int", isList: false, isRequired: true, isId: true },
        { name: "bio", kind: "scalar", type: "String", isList: false, isRequired: false },
      ],
    },
    {
      name: "Tag",
      fields: [
        { name: "id", kind: "scalar", type: "Int", isList: false, isRequired: true, isId: true },
        { name: "label", kind: "scalar", type: "String", isList: false, isRequired: true },
      ],
    },
  ],
  enums: [],
};

function makeEngine() {
  return createPrismaEngine(datamodel, {
    schema: { policy: buildGenQueryPolicy({ datamodel }) },
  });
}

const SECRET_OMIT = { password: true, totpSecret: true };

// ---------- (1) default select strips denied fields via `omit` ----------

test("select omitted + denied fields → omit of the denied names only", () => {
  const engine = makeEngine();
  const args = engine.runParsed(engine.parse({}, "User"), null as never) as any;
  const omit = args.omit;
  // Columns the schema doesn't model (String[], Json) are NOT omitted: they
  // keep Prisma's default selection.
  assert.equal(omit.roles, undefined);
  assert.equal(omit.metadata, undefined);
  assert.equal(omit.recoveryCodes, undefined);
  assert.deepEqual(args, { omit: SECRET_OMIT });
});

// ---------- (2) explicit select of a denied field is still rejected ----------

test("explicit select asking a denied field → QueryValidationError, as before", () => {
  const engine = makeEngine();
  assert.throws(
    () => engine.parse({ select: { password: true } }, "User"),
    (err: unknown) =>
      err instanceof QueryValidationError && /not selectable/.test(err.message),
  );
});

test("explicit select → plain `select`, no omit (a select is exhaustive)", () => {
  const engine = makeEngine();
  const args = engine.runParsed(
    engine.parse({ select: { email: true } }, "User"),
    null as never,
  ) as any;
  assert.deepEqual(args, { select: { email: true, id: true } });
});

// ---------- (3) include + default select composition ----------

test("include on denied-fields root → omit at root, relations under include", () => {
  const engine = makeEngine();
  const args = engine.runParsed(
    engine.parse({ include: { posts: "all", profile: "all" } }, "User"),
    null as never,
  ) as any;
  // Post/Profile have no denied fields → plain `true`, exactly as before.
  assert.deepEqual(args, {
    omit: SECRET_OMIT,
    include: { posts: true, profile: true },
  });
});

test("include 'all' on denied-fields root → omit + every relation included", () => {
  const engine = makeEngine();
  const args = engine.runParsed(
    engine.parse({ include: "all" }, "User"),
    null as never,
  ) as any;
  assert.deepEqual(args, {
    omit: SECRET_OMIT,
    include: { posts: true, profile: true },
  });
});

test("included relation whose TARGET has denied fields gets a nested omit", () => {
  const engine = makeEngine();
  const args = engine.runParsed(
    engine.parse({ include: { author: "all" } }, "Post"),
    null as never,
  ) as any;
  // Post itself is clean → no root omit; the dirty target is stripped.
  assert.deepEqual(args, { include: { author: { omit: SECRET_OMIT } } });
});

test("multi-level include: omit at the dirty level, nested relations preserved", () => {
  const engine = makeEngine();
  const args = engine.runParsed(
    engine.parse({ include: { author: { posts: "all" } } }, "Post"),
    null as never,
  ) as any;
  // author (User, dirty) → omit; its nested posts (clean) stay `true`.
  assert.deepEqual(args, {
    include: { author: { omit: SECRET_OMIT, include: { posts: true } } },
  });
});

// ---------- baseArgs keep their pre-strip precedence ----------

test("baseArgs.include composes with the root omit", () => {
  const engine = makeEngine();
  const parsed = engine.parse({}, "User");
  parsed.baseArgs = { include: { posts: { include: { tags: true } } } };
  const args = engine.runParsed(parsed, null as never) as any;
  assert.deepEqual(args, {
    omit: SECRET_OMIT,
    include: { posts: { include: { tags: true } } },
  });
});

test("baseArgs.select (trusted, server-side) supersedes the omit", () => {
  const engine = makeEngine();
  const parsed = engine.parse({}, "User");
  parsed.baseArgs = { select: { id: true, email: true } };
  const args = engine.runParsed(parsed, null as never) as any;
  assert.deepEqual(args, { select: { id: true, email: true } });
});

test("wire include set → baseArgs.include skipped, exactly as before", () => {
  const engine = makeEngine();
  const parsed = engine.parse({ include: { profile: "all" } }, "User");
  parsed.baseArgs = { include: { posts: true } };
  const args = engine.runParsed(parsed, null as never) as any;
  assert.deepEqual(args, { omit: SECRET_OMIT, include: { profile: true } });
});

// ---------- (4) denied columns the schema doesn't model are stripped too ----------

test("denied String[] column (extraSecretFields) is omitted even though unmapped", () => {
  const engine = createPrismaEngine(datamodel, {
    schema: {
      policy: buildGenQueryPolicy({
        datamodel,
        extraSecretFields: ["recoveryCodes"],
      }),
    },
  });
  const args = engine.runParsed(engine.parse({}, "User"), null as never) as any;
  assert.deepEqual(args.omit, { ...SECRET_OMIT, recoveryCodes: true });
});

// ---------- (5) zero regression for entities without denied fields ----------

test("entity with NO denied fields → no omit key emitted, exactly as before", () => {
  const engine = makeEngine();
  const plain = engine.runParsed(engine.parse({}, "Post"), null as never);
  assert.deepEqual(plain, {});
  const withInclude = engine.runParsed(
    engine.parse({ include: { tags: "all" } }, "Post"),
    null as never,
  ) as any;
  assert.equal(withInclude.omit, undefined);
  assert.deepEqual(withInclude, { include: { tags: true } });
});

// ---------- include:'all' respects the includable allowlist ----------

test("include 'all' + relazione negata → espande solo le relazioni includibili", () => {
  const engine = createPrismaEngine(datamodel, {
    schema: { policy: { User: { includable: ["profile"] } } },
  });
  const args = engine.runParsed(
    engine.parse({ include: "all" }, "User"),
    null as never,
  ) as any;
  assert.ok(args.include?.profile, "profile (consentita) deve essere inclusa");
  assert.equal(args.include?.posts, undefined, "posts (negata) NON deve rientrare da 'all'");
  // Il percorso esplicito resta rifiutato come prima.
  assert.throws(
    () => engine.parse({ include: { posts: "all" } }, "User"),
    QueryValidationError,
  );
});

test("include 'all' senza relazioni negate → espansione storica completa", () => {
  const engine = makeEngine();
  const args = engine.runParsed(
    engine.parse({ include: "all" }, "User"),
    null as never,
  ) as any;
  assert.ok(args.include?.posts);
  assert.ok(args.include?.profile);
});

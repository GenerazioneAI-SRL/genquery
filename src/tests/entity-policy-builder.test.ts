import test from "node:test";
import assert from "node:assert/strict";
import { buildGenQueryPolicy, DEFAULT_SECRET_FIELDS } from "../entity-policy-builder";

const datamodel = {
  models: [
    {
      name: "User",
      fields: [
        { name: "id", kind: "scalar" },
        { name: "username", kind: "scalar" },
        { name: "password", kind: "scalar" },
        { name: "tokenHash", kind: "scalar" },
        { name: "individual", kind: "object" },
      ],
    },
    {
      name: "Media",
      fields: [
        { name: "id", kind: "scalar" },
        { name: "hash", kind: "scalar" },
      ],
    },
  ],
};

test("buildGenQueryPolicy esclude i SECRET_FIELDS da filter/sort/select", () => {
  const policy = buildGenQueryPolicy({ datamodel });
  const u = policy.User;
  assert.deepEqual(u.filterable, ["id", "username"]); // password/tokenHash esclusi
  assert.deepEqual(u.selectable, ["id", "username"]);
  assert.deepEqual(u.sortable, ["id", "username"]);
  assert.deepEqual(u.includable, ["individual"]);
  assert.ok(!u.selectable!.includes("password"));
  assert.ok(!u.selectable!.includes("tokenHash"));
});

test("hash NON è segreto di default (resta queryable)", () => {
  assert.ok(!DEFAULT_SECRET_FIELDS.has("hash"));
  const policy = buildGenQueryPolicy({ datamodel });
  assert.deepEqual(policy.Media.filterable, ["id", "hash"]);
});

test("maxPerPage dal manifest, fallback al default", () => {
  const policy = buildGenQueryPolicy({
    datamodel,
    manifests: [{ prismaModel: "user", autoquery: { pagination: { max: 50 } } }],
    defaultMaxPerPage: 200,
  });
  assert.equal(policy.User.maxPerPage, 50); // dal manifest (user → User)
  assert.equal(policy.Media.maxPerPage, 200); // fallback
});

test("deny per-modello + extraSecretFields", () => {
  const policy = buildGenQueryPolicy({
    datamodel,
    deny: { User: { fields: ["username"], relations: ["individual"] } },
    extraSecretFields: ["id"],
  });
  assert.deepEqual(policy.User.filterable, []); // id(extra-secret)+username(deny) tolti
  assert.deepEqual(policy.User.includable, []); // individual in deny.relations
});

test("accetta datamodel come array nudo di models", () => {
  const policy = buildGenQueryPolicy({ datamodel: datamodel.models });
  assert.ok(policy.User);
  assert.deepEqual(policy.Media.filterable, ["id", "hash"]);
});

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  toFederatedShape,
  buildFederationIndex,
  planFederatedIncludes,
  collectForeignIds,
  mergeFederatedRows,
  pluralizeCamel,
  FederationPlanError,
} from "../federation";

/** Fixture: due servizi — hr (pivot con FK soft verso id) e id (owner delle entity). */
const hr = toFederatedShape("skillHr", {
  models: [
    {
      name: "StructureJuridicalIndividual",
      fields: [
        { name: "id", kind: "scalar" },
        { name: "juridicalIndividualId", kind: "scalar" },
        { name: "structureId", kind: "scalar" },
        { name: "structure", kind: "object" },
        { name: "deletedAt", kind: "scalar" },
      ],
    },
    {
      name: "Structure",
      fields: [
        { name: "id", kind: "scalar" },
        { name: "juridicalId", kind: "scalar" },
        { name: "cityId", kind: "scalar" },
      ],
    },
    {
      name: "OrgRoleAssignment",
      fields: [
        { name: "id", kind: "scalar" },
        { name: "structureId", kind: "scalar" },
        { name: "juridicalIndividualId", kind: "scalar" },
      ],
    },
  ],
});

const id = toFederatedShape("skillID", {
  models: [
    {
      name: "JuridicalIndividual",
      fields: [
        { name: "id", kind: "scalar" },
        { name: "individualId", kind: "scalar" },
        { name: "individual", kind: "object" },
      ],
    },
    { name: "Juridical", fields: [{ name: "id", kind: "scalar" }] },
    { name: "City", fields: [{ name: "id", kind: "scalar" }] },
    // Collisione intenzionale per il test di ambiguità.
    { name: "Media", fields: [{ name: "id", kind: "scalar" }] },
  ],
});

const atlas = toFederatedShape("skillAtlas", {
  models: [{ name: "Media", fields: [{ name: "id", kind: "scalar" }] }],
});

const index = buildFederationIndex([hr, id, atlas]);

test("relazione locale reale resta locale; FK cross-service diventa piano remoto", () => {
  const plan = planFederatedIncludes({
    index,
    service: "skillHr",
    model: "StructureJuridicalIndividual",
    include: { structure: true, juridicalIndividual: true },
  });
  assert.deepEqual(plan.localInclude, { structure: true });
  assert.equal(plan.remote.length, 1);
  assert.deepEqual(plan.remote[0], {
    key: "juridicalIndividual",
    fk: "juridicalIndividualId",
    targetService: "skillID",
    targetModel: "JuridicalIndividual",
    nested: undefined,
  });
});

test("include annidato dentro la chiave federata viene inoltrato al target", () => {
  const plan = planFederatedIncludes({
    index,
    service: "skillHr",
    model: "StructureJuridicalIndividual",
    include: { juridicalIndividual: { include: { individual: true } } },
  });
  assert.deepEqual(plan.remote[0].nested, {
    include: { individual: true },
    select: undefined,
  });
});

test("soft-FK nello stesso servizio: il servizio del cmd vince", () => {
  const plan = planFederatedIncludes({
    index,
    service: "skillHr",
    model: "OrgRoleAssignment",
    include: { structure: true },
  });
  // OrgRoleAssignment non ha la relazione `structure` ma ha `structureId`;
  // Structure è di skillHr stesso → risoluzione federata interna.
  assert.equal(plan.remote[0].targetService, "skillHr");
  assert.equal(plan.localInclude, undefined);
});

test("ambiguità multi-owner senza override → errore esplicativo", () => {
  const shape = toFederatedShape("skillCertet", {
    models: [
      {
        name: "Doc",
        fields: [
          { name: "id", kind: "scalar" },
          { name: "mediaId", kind: "scalar" },
        ],
      },
    ],
  });
  const idx = buildFederationIndex([shape, id, atlas]);
  assert.throws(
    () =>
      planFederatedIncludes({
        index: idx,
        service: "skillCertet",
        model: "Doc",
        include: { media: true },
      }),
    FederationPlanError,
  );
  // ...e con override si risolve.
  const plan = planFederatedIncludes({
    index: idx,
    service: "skillCertet",
    model: "Doc",
    include: { media: true },
    overrides: { media: { service: "skillAtlas" } },
  });
  assert.equal(plan.remote[0].targetService, "skillAtlas");
});

test("chiave non federabile resta nell'include locale (errore standard del motore)", () => {
  const plan = planFederatedIncludes({
    index,
    service: "skillHr",
    model: "StructureJuridicalIndividual",
    include: { nonsense: true },
  });
  assert.deepEqual(plan.localInclude, { nonsense: true });
  assert.equal(plan.remote.length, 0);
});

test("alwaysInclude federata viene pianificata anche senza richiesta client; se non federabile → errore", () => {
  const plan = planFederatedIncludes({
    index,
    service: "skillHr",
    model: "StructureJuridicalIndividual",
    alwaysInclude: ["juridicalIndividual"],
  });
  assert.equal(plan.remote.length, 1);
  assert.throws(
    () =>
      planFederatedIncludes({
        index,
        service: "skillHr",
        model: "StructureJuridicalIndividual",
        alwaysInclude: ["nonsense"],
      }),
    FederationPlanError,
  );
});

test("collectForeignIds dedupa e ignora null; mergeFederatedRows = left-join", () => {
  const rows = [
    { id: "a", juridicalIndividualId: "ji-1" },
    { id: "b", juridicalIndividualId: "ji-2" },
    { id: "c", juridicalIndividualId: "ji-1" },
    { id: "d", juridicalIndividualId: null },
  ];
  const ids = collectForeignIds(rows, "juridicalIndividualId");
  assert.deepEqual(ids.sort(), ["ji-1", "ji-2"]);

  mergeFederatedRows(
    rows,
    { key: "juridicalIndividual", fk: "juridicalIndividualId" },
    [{ id: "ji-1", individualId: "ind-1" }],
  );
  assert.equal((rows[0] as any).juridicalIndividual.id, "ji-1");
  assert.equal((rows[1] as any).juridicalIndividual, null); // target non trovato
  assert.equal((rows[3] as any).juridicalIndividual, null); // FK null
});

test("pluralizeCamel: convenzioni inglesi di base", () => {
  assert.equal(pluralizeCamel("JuridicalIndividual"), "juridicalIndividuals");
  assert.equal(pluralizeCamel("City"), "cities");
  assert.equal(pluralizeCamel("Address"), "addresses");
  assert.equal(pluralizeCamel("Structure"), "structures");
});

// ── aliasMap / alwaysInclude annidato / include:false / keep-first ──────────

test("aliasMap risolve chiavi semantiche (key ≠ model) senza override", () => {
  const certet = toFederatedShape("skillCertet", {
    models: [{ name: "EmployeePlanning", fields: [
      { name: "id", kind: "scalar" },
      { name: "customerId", kind: "scalar" },
      { name: "submitterId", kind: "scalar" },
    ]}],
  });
  const idx = buildFederationIndex([certet, id]);
  const plan = planFederatedIncludes({
    index: idx, service: "skillCertet", model: "EmployeePlanning",
    include: { customer: true, submitter: true },
    aliasMap: { customer: "Juridical", submitter: "JuridicalIndividual" },
  });
  const byKey = Object.fromEntries(plan.remote.map((r) => [r.key, r]));
  assert.equal(byKey.customer.targetModel, "Juridical");
  assert.equal(byKey.customer.fk, "customerId");
  assert.equal(byKey.submitter.targetModel, "JuridicalIndividual");
  assert.equal(byKey.submitter.fk, "submitterId");
});

test("aliasMap con fk esplicito + override vince su aliasMap", () => {
  const svc = toFederatedShape("skillX", { models: [{ name: "Doc", fields: [
    { name: "id", kind: "scalar" }, { name: "ownerJiId", kind: "scalar" },
  ]}]});
  const idx = buildFederationIndex([svc, id]);
  const plan = planFederatedIncludes({
    index: idx, service: "skillX", model: "Doc",
    include: { owner: true },
    aliasMap: { owner: { model: "JuridicalIndividual", fk: "ownerJiId" } },
  });
  assert.equal(plan.remote[0].fk, "ownerJiId");
  assert.equal(plan.remote[0].targetModel, "JuridicalIndividual");
});

test("manifest links risolve chiavi semantiche senza aliasMap globale", () => {
  // links co-locati col model (harvestati dal resource manifest) — niente aliasMap.
  const certet: any = {
    service: "skillCertet",
    models: [{
      name: "EmployeePlanning",
      relations: [],
      scalars: ["id", "customerId", "submitterId"],
      links: { customer: "Juridical", submitter: { model: "JuridicalIndividual" } },
    }],
  };
  const idx = buildFederationIndex([certet, id]);
  // aliasMap globale in CONFLITTO col link → il link (co-locato) deve vincere.
  const plan = planFederatedIncludes({
    index: idx, service: "skillCertet", model: "EmployeePlanning",
    include: { customer: true, submitter: true },
    aliasMap: { customer: "City" },
  });
  const byKey = Object.fromEntries(plan.remote.map((r) => [r.key, r]));
  assert.equal(byKey.customer.targetModel, "Juridical"); // link batte aliasMap (City)
  assert.equal(byKey.customer.fk, "customerId");
  assert.equal(byKey.submitter.targetModel, "JuridicalIndividual");
  assert.equal(byKey.submitter.fk, "submitterId");
});

test("override vince sul link del manifest, il link vince sull'aliasMap globale", () => {
  const svc: any = {
    service: "skillCertet",
    models: [{
      name: "Doc",
      relations: [],
      scalars: ["id", "customerId", "ownerJiId"],
      links: { customer: "Juridical" },
    }],
  };
  const idx = buildFederationIndex([svc, id]);
  // link (Juridical) batte aliasMap (City); override batte tutto.
  const plan = planFederatedIncludes({
    index: idx, service: "skillCertet", model: "Doc",
    include: { customer: true, owner: true },
    aliasMap: { customer: "City", owner: { model: "JuridicalIndividual", fk: "ownerJiId" } },
    overrides: { customer: { service: "skillID", model: "JuridicalIndividual", fk: "ownerJiId" } },
  });
  const byKey = Object.fromEntries(plan.remote.map((r) => [r.key, r]));
  assert.equal(byKey.customer.targetModel, "JuridicalIndividual"); // override
  assert.equal(byKey.customer.fk, "ownerJiId");
  assert.equal(byKey.owner.targetModel, "JuridicalIndividual"); // aliasMap (nessun link 'owner')
});

test("alwaysInclude annidato inoltra include al target (ripristina nested individual)", () => {
  const hr = toFederatedShape("skillHr", { models: [{ name: "Tempbadge", fields: [
    { name: "id", kind: "scalar" }, { name: "juridicalIndividualId", kind: "scalar" },
  ]}]});
  const idx = buildFederationIndex([hr, id]);
  const plan = planFederatedIncludes({
    index: idx, service: "skillHr", model: "Tempbadge",
    alwaysInclude: [{ key: "juridicalIndividual", include: { individual: true } }],
  });
  assert.equal(plan.remote.length, 1);
  assert.deepEqual(plan.remote[0].nested, { include: { individual: true }, select: undefined });
});

test("include:false NON viene resuscitato da alwaysInclude", () => {
  const hr = toFederatedShape("skillHr", { models: [{ name: "Tempbadge", fields: [
    { name: "id", kind: "scalar" }, { name: "juridicalIndividualId", kind: "scalar" },
  ]}]});
  const idx = buildFederationIndex([hr, id]);
  const plan = planFederatedIncludes({
    index: idx, service: "skillHr", model: "Tempbadge",
    include: { juridicalIndividual: false },
    alwaysInclude: ["juridicalIndividual"],
  });
  assert.equal(plan.remote.length, 0);
  assert.equal(plan.localInclude, undefined);
});

test("mergeFederatedRows keep-first su id duplicati del target", () => {
  const rows = [{ id: "a", jiId: "x" }];
  mergeFederatedRows(rows, { key: "ji", fk: "jiId" }, [
    { id: "x", v: 1 }, { id: "x", v: 2 },
  ]);
  assert.equal((rows[0] as any).ji.v, 1);
});

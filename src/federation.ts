/**
 * GenQuery Federation — cross-service ("federated") includes.
 *
 * Problem: a client asks `include: { juridicalIndividual: true }` on a model
 * whose Prisma schema does NOT have that relation — the row only carries a
 * scalar foreign key (`juridicalIndividualId`) pointing at an entity owned by
 * ANOTHER service. The local engine would (correctly) reject the include.
 *
 * Federation makes such includes work transparently, for ANY resource, with
 * ZERO per-resource declarations. Discovery is convention-driven from the
 * services' own datamodels (the same DMMF already generated for the engine):
 *
 *   include key `x` on local model M
 *     → M has object-relation `x`?            resolve locally (engine as usual)
 *     → M has scalar `xId` and a model `X`
 *       exists in the federation index?       resolve remotely: batch-fetch the
 *                                             target service's `Xs.findAll`
 *                                             (searchBy id-in), then merge under
 *                                             key `x`. Nested include/select are
 *                                             forwarded to the target's engine.
 *
 * This module is PURE logic (planning + merging). The transport (NATS clients,
 * chunking, timeouts) lives in `@generazioneai/genquery-nestjs`.
 */

// ---------------------------------------------------------------------------
// Compact datamodel shape
// ---------------------------------------------------------------------------

/**
 * The minimal knowledge federation needs about a model. Derived from DMMF via
 * {@link toFederatedShape}; kept compact so a gateway can embed the union of
 * ALL services' models in a small generated file.
 */
export interface FederatedModelShape {
  /** DMMF PascalCase model name — e.g. 'JuridicalIndividual'. */
  name: string;
  /** Object-relation field names (locally resolvable by the owning engine). */
  relations: readonly string[];
  /** Scalar/enum field names (FK candidates live here). */
  scalars: readonly string[];
}

export interface FederatedServiceShape {
  /** Owning service name — e.g. 'skillID'. */
  service: string;
  models: readonly FederatedModelShape[];
}

/** Reduce a full DMMF datamodel to the compact federation shape. */
export function toFederatedShape(
  service: string,
  datamodel: { models: readonly { name: string; fields: readonly { name: string; kind: string }[] }[] },
): FederatedServiceShape {
  return {
    service,
    models: datamodel.models.map((m) => ({
      name: m.name,
      relations: m.fields.filter((f) => f.kind === "object").map((f) => f.name),
      scalars: m.fields.filter((f) => f.kind !== "object").map((f) => f.name),
    })),
  };
}

// ---------------------------------------------------------------------------
// Federation index (the "resource discovery" map)
// ---------------------------------------------------------------------------

export interface FederationIndex {
  readonly services: readonly FederatedServiceShape[];
  /** All owners of a given model name (cross-service collisions are possible). */
  ownersOf(model: string): readonly FederatedServiceShape[];
  modelOf(service: string, model: string): FederatedModelShape | undefined;
}

export function buildFederationIndex(
  services: readonly FederatedServiceShape[],
): FederationIndex {
  const byModel = new Map<string, FederatedServiceShape[]>();
  const byService = new Map<string, Map<string, FederatedModelShape>>();
  for (const svc of services) {
    const models = new Map<string, FederatedModelShape>();
    byService.set(svc.service, models);
    for (const m of svc.models) {
      models.set(m.name, m);
      const owners = byModel.get(m.name) ?? [];
      owners.push(svc);
      byModel.set(m.name, owners);
    }
  }
  return {
    services,
    ownersOf: (model) => byModel.get(model) ?? [],
    modelOf: (service, model) => byService.get(service)?.get(model),
  };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** One remote resolution: fetch `targetModel` rows from `targetService` by `fk`. */
export interface FederatedIncludePlan {
  /** Include key requested by the client (and merge key on the result rows). */
  key: string;
  /** Local scalar FK whose values identify the target rows — e.g. 'juridicalIndividualId'. */
  fk: string;
  targetService: string;
  targetModel: string;
  /** Nested envelope forwarded verbatim to the target engine (depth for free). */
  nested?: { include?: Record<string, unknown>; select?: Record<string, unknown> };
}

export interface FederationPlan {
  /** Include to forward to the local engine (undefined when emptied). */
  localInclude?: Record<string, unknown>;
  remote: FederatedIncludePlan[];
}

export class FederationPlanError extends Error {
  constructor(message: string, readonly key: string) {
    super(message);
    this.name = "FederationPlanError";
  }
}

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * Conventional NATS cmd prefix for a model: camelCase English plural.
 *   JuridicalIndividual → juridicalIndividuals · City → cities · Address → addresses
 */
export function pluralizeCamel(model: string): string {
  const base = lowerFirst(model);
  if (/[^aeiou]y$/i.test(base)) return base.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/i.test(base)) return base + "es";
  return base + "s";
}

/**
 * Split a client include tree into the locally-resolvable part and the remote
 * (federated) plans, using convention-driven discovery over the index.
 *
 * - A key matching a real local relation stays local (engine resolves it).
 * - A key with a matching local scalar `<key>Id` and a model `UpperFirst(key)`
 *   known to the index becomes a remote plan. Owner resolution: the cmd's own
 *   service wins if it owns the model (soft-FK within one service), otherwise
 *   the single foreign owner; multiple foreign owners require an override.
 * - Anything else stays local untouched: the local engine emits its own
 *   precise validation error (federation must not swallow it).
 *
 * `alwaysInclude` lists federated keys to resolve even when the client did not
 * ask for them (back-compat with gateways that always enrich).
 */
export function planFederatedIncludes(opts: {
  index: FederationIndex;
  /** Service that owns the cmd being sent (the "local" side). */
  service: string;
  /** Local DMMF PascalCase model returned by the cmd. */
  model: string;
  include?: Record<string, unknown>;
  alwaysInclude?: readonly string[];
  /** Per-key explicit targets for ambiguous/unconventional cases. */
  overrides?: Record<string, { service: string; model?: string; fk?: string }>;
}): FederationPlan {
  const { index, service, model, include, alwaysInclude, overrides } = opts;
  const local = index.modelOf(service, model);
  if (!local) {
    throw new FederationPlanError(
      `Federation: model '${model}' is not in the datamodel of service '${service}' — check the federation configuration`,
      model,
    );
  }

  const localInclude: Record<string, unknown> = {};
  const remote: FederatedIncludePlan[] = [];
  const planned = new Set<string>();

  const planKey = (key: string, value: unknown, demanded: boolean): void => {
    if (planned.has(key)) return;
    planned.add(key);

    // 1) Real local relation → the local engine resolves it.
    if (local.relations.includes(key)) {
      localInclude[key] = value;
      return;
    }

    // 2) Convention: scalar FK `<key>Id` (overridable) + known model.
    const override = overrides?.[key];
    const fk = override?.fk ?? `${key}Id`;
    const targetModel = override?.model ?? upperFirst(key);
    if (local.scalars.includes(fk)) {
      let targetService = override?.service;
      if (!targetService) {
        const owners = index.ownersOf(targetModel);
        if (owners.some((o) => o.service === service)) {
          targetService = service; // soft-FK risolta nello stesso servizio
        } else if (owners.length === 1) {
          targetService = owners[0].service;
        } else if (owners.length > 1) {
          throw new FederationPlanError(
            `Federation: include '${key}' on ${service}.${model} is ambiguous — model '${targetModel}' is owned by ` +
              `[${owners.map((o) => o.service).join(", ")}]. Add an override for '${key}'.`,
            key,
          );
        }
      }
      if (targetService) {
        const nestedSrc =
          value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
        const nested =
          nestedSrc && (nestedSrc.include || nestedSrc.select)
            ? {
                include: nestedSrc.include as Record<string, unknown> | undefined,
                select: nestedSrc.select as Record<string, unknown> | undefined,
              }
            : undefined;
        remote.push({ key, fk, targetService, targetModel, nested });
        return;
      }
    }

    // 3) Not federable. Demanded-by-config keys are a configuration bug; client
    //    keys fall through to the local engine for its standard validation error.
    if (demanded) {
      throw new FederationPlanError(
        `Federation: alwaysInclude '${key}' on ${service}.${model} matches no local relation, ` +
          `no scalar FK '${fk}', or no known model '${targetModel}'`,
        key,
      );
    }
    localInclude[key] = value;
  };

  for (const [key, value] of Object.entries(include ?? {})) {
    if (value === false || value == null) continue; // include disattivato dal client
    planKey(key, value, false);
  }
  for (const key of alwaysInclude ?? []) planKey(key, true, true);

  return {
    localInclude: Object.keys(localInclude).length ? localInclude : undefined,
    remote,
  };
}

// ---------------------------------------------------------------------------
// Resolution helpers (transport-agnostic)
// ---------------------------------------------------------------------------

/** Unique non-null FK values across the local rows (the ids to batch-fetch). */
export function collectForeignIds(rows: readonly any[], fk: string): string[] {
  const out = new Set<string>();
  for (const row of rows) {
    const v = row?.[fk];
    if (v != null && v !== "") out.add(String(v));
  }
  return [...out];
}

/**
 * Merge fetched target rows under `plan.key` on each local row (by `fk` → id).
 * Rows whose FK is null or whose target was not found get `null` — same
 * semantics as a Prisma left-join include.
 */
export function mergeFederatedRows(
  rows: readonly any[],
  plan: Pick<FederatedIncludePlan, "key" | "fk">,
  targetRows: readonly any[],
): void {
  const byId = new Map<string, any>();
  for (const t of targetRows) if (t?.id != null) byId.set(String(t.id), t);
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const fkVal = row[plan.fk];
    row[plan.key] = fkVal != null ? (byId.get(String(fkVal)) ?? null) : null;
  }
}

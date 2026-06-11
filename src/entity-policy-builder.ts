/**
 * EntityPolicy builder — DENY-based, derived from a Prisma DMMF datamodel + resource
 * manifests. Centralizes the boilerplate every backend duplicated in
 * `src/authz/genquery-policy.ts`.
 *
 * Model: PERMISSIVE by default — every scalar/enum is filterable/sortable/selectable
 * and every relation is includable/filterableRelations, MINUS the secret fields and
 * an optional per-model `deny`. maxPerPage is taken from the matching manifest's
 * `autoquery.pagination.max`, else `defaultMaxPerPage`. Keyed by DMMF model name
 * (PascalCase) so it maps 1:1 onto the Schema. Pass the result as `schema.policy`
 * (or to {@link applyPolicy}).
 */
import type { EntityPolicy } from "./schema";

/**
 * Canonical credential/secret field names — NEVER filterable/sortable/selectable on
 * ANY model. Single source of truth: a backend gets the full set automatically and
 * can only ADD via `extraSecretFields` (no per-service drift / forgotten fields).
 * NB: `hash` is intentionally NOT here (e.g. Media dedup queries by hash; the value
 * is still kept out of responses by entity serialization / findOne select-stripping).
 */
export const DEFAULT_SECRET_FIELDS: ReadonlySet<string> = new Set([
  "password",
  "totpSecret",
  "mfaSecret",
  "clientSecret",
  "secret",
  "tokenHash",
  "refreshTokenHash",
  "apiKeyHash",
  "webauthnCredId",
  "webauthnPubKey",
]);

/** Minimal structural shape of a DMMF field (Prisma.dmmf.datamodel.models[].fields). */
type DMField = { name: string; kind: string };
/** Minimal structural shape of a DMMF model. */
type DMModel = { name: string; fields: readonly DMField[] };

/** Structural manifest shape consumed here (a `ResourceManifest` satisfies it). */
export interface PolicyManifestLike {
  prismaModel?: string;
  autoquery?: { pagination?: { max?: number } };
}

export interface BuildGenQueryPolicyOptions {
  /** Prisma DMMF datamodel — `{ models: [...] }` or a bare models array. */
  datamodel: { models: readonly DMModel[] } | readonly DMModel[];
  /** Resource manifests (structural) → per-model maxPerPage from autoquery.pagination.max. */
  manifests?: readonly PolicyManifestLike[];
  /** Per-model extra deny beyond secrets: fields/relations not queryable. */
  deny?: Record<string, { fields?: readonly string[]; relations?: readonly string[] }>;
  /** Extra secret field names added to {@link DEFAULT_SECRET_FIELDS}. */
  extraSecretFields?: Iterable<string>;
  /** Fallback maxPerPage when a manifest declares none. Default 200. */
  defaultMaxPerPage?: number;
}

const pascal = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export function buildGenQueryPolicy(
  opts: BuildGenQueryPolicyOptions,
): Record<string, EntityPolicy> {
  const src: any = opts.datamodel;
  const models: readonly DMModel[] = (Array.isArray(src) ? src : src?.models) ?? [];

  const secrets = new Set<string>(DEFAULT_SECRET_FIELDS);
  for (const f of opts.extraSecretFields ?? []) secrets.add(f);

  const deny = opts.deny ?? {};
  const fallbackMax = opts.defaultMaxPerPage ?? 200;

  const maxByModel: Record<string, number> = {};
  for (const m of opts.manifests ?? []) {
    const max = m.autoquery?.pagination?.max;
    const key = pascal(m.prismaModel ?? "");
    if (key && typeof max === "number") maxByModel[key] = max;
  }

  const policy: Record<string, EntityPolicy> = {};
  for (const model of models) {
    const d = deny[model.name] ?? {};
    const denyFields = new Set<string>([...secrets, ...(d.fields ?? [])]);
    const denyRelations = new Set<string>(d.relations ?? []);

    const scalars = model.fields
      .filter((f) => (f.kind === "scalar" || f.kind === "enum") && !denyFields.has(f.name))
      .map((f) => f.name);
    const relations = model.fields
      .filter((f) => f.kind === "object" && !denyRelations.has(f.name))
      .map((f) => f.name);

    policy[model.name] = {
      filterable: scalars,
      sortable: scalars,
      selectable: scalars,
      includable: relations,
      filterableRelations: relations,
      maxPerPage: maxByModel[model.name] ?? fallbackMax,
    };
  }
  return policy;
}

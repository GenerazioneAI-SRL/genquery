/**
 * Schema describes what fields and relations exist on each entity, so the
 * parser can validate queries and the adapter can produce correct joins and
 * conditions. The schema is intentionally ORM-agnostic.
 */

export type FieldType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "enum"
  | "id";

interface BaseFieldDefinition {
  /**
   * Override the database column name. Defaults to the field key.
   * Adapters may ignore this if they derive column names from ORM metadata.
   */
  column?: string;
  /**
   * Whether the column accepts NULL. Defaults to `false`. The parser uses this
   * to reject `{ isNull }` presence checks on non-nullable fields. With
   * `schemaFromPrisma`, this is auto-populated from the DMMF field metadata.
   */
  nullable?: boolean;
  /**
   * POLICY (allowlist). Whether this field may be used in `searchBy`. Defaults
   * to `true` (the field exists → it's queryable, the historical behavior).
   * Set `false` to expose the field for reading but forbid filtering on it —
   * the parser throws `QueryValidationError` if a query tries to filter it.
   */
  filterable?: boolean;
  /** POLICY. Whether this field may be used in `orderBy`. Defaults to `true`. */
  sortable?: boolean;
  /** POLICY. Whether this field may be requested in `select`. Defaults to `true`. */
  selectable?: boolean;
}

export type FieldDefinition =
  | (BaseFieldDefinition & {
      type: "string" | "number" | "boolean" | "date" | "id";
    })
  | EnumFieldDefinition;

export interface EnumFieldDefinition extends BaseFieldDefinition {
  type: "enum";
  /** Allowed enum values. The parser rejects anything not in this list. */
  values: readonly string[];
}

export interface RelationDefinition {
  /** Name of the related entity in the schema's `entities` map. */
  target: string;
  /** Cardinality. Currently informational; defaults to "many". */
  kind?: "one" | "many";
  /** POLICY. Whether this relation may be requested in `include`. Defaults to `true`. */
  includable?: boolean;
  /** POLICY. Whether this relation may be filtered on inside `searchBy`. Defaults to `true`. */
  filterable?: boolean;
}

export interface EntityDefinition {
  /** Logical name of the entity (matches the key in `Schema.entities`). */
  name: string;
  fields: Record<string, FieldDefinition>;
  relations?: Record<string, RelationDefinition>;
  /**
   * Primary key field name. Used to give relations a stable identity in
   * adapter output. Defaults to "id".
   */
  primaryKey?: string;
  /**
   * POLICY. Maximum `pagination.perPage` the parser will honor for this entity.
   * A larger `perPage` is clamped down to this value (not rejected). Undefined
   * = no cap (historical behavior). Does not affect `pagination: "all"`.
   */
  maxPerPage?: number;
}

export interface Schema {
  entities: Record<string, EntityDefinition>;
}

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

export function getEntity(schema: Schema, name: string): EntityDefinition {
  const entity = schema.entities[name];
  if (!entity) {
    throw new SchemaError(`Unknown entity '${name}' in schema`);
  }
  return entity;
}

export function getField(
  schema: Schema,
  entityName: string,
  field: string,
): FieldDefinition | undefined {
  return getEntity(schema, entityName).fields[field];
}

export function getRelation(
  schema: Schema,
  entityName: string,
  field: string,
): RelationDefinition | undefined {
  return getEntity(schema, entityName).relations?.[field];
}

export function primaryKeyOf(entity: EntityDefinition): string {
  return entity.primaryKey ?? "id";
}

/**
 * Per-entity allowlist policy, expressed as field/relation NAME lists. This is
 * the ergonomic, ORM-agnostic input format (the same shape a backend's resource
 * manifest typically declares). `applyPolicy` projects it onto the low-level
 * per-field/-relation boolean flags the parser enforces.
 *
 * Semantics, per axis:
 *  - the array is OMITTED  → that axis is unrestricted (every field/relation allowed)
 *  - the array is PRESENT  → ONLY the listed names are allowed; everything else is denied
 *  - the array is EMPTY    → nothing is allowed for that axis
 *
 * Names not present on the entity are ignored (a policy may over-list safely).
 */
export interface EntityPolicy {
  /** Field names allowed in `searchBy`. */
  filterable?: readonly string[];
  /** Field names allowed in `orderBy`. */
  sortable?: readonly string[];
  /** Field names allowed in `select`. */
  selectable?: readonly string[];
  /** Relation names allowed in `include`. */
  includable?: readonly string[];
  /** Relation names allowed to be filtered inside `searchBy`. */
  filterableRelations?: readonly string[];
  /** Max `pagination.perPage` honored for this entity (clamp). */
  maxPerPage?: number;
}

/**
 * Return a NEW schema with the per-field/-relation policy flags + `maxPerPage`
 * set from `policies` (keyed by entity name). Pure: does not mutate `schema`.
 * Entities absent from `policies` are returned unchanged (unrestricted).
 *
 * This is the bridge a backend uses to enforce its resource-manifest allowlists
 * (filterable/sortable/includable/pagination.max) through the genquery parser,
 * without hand-writing per-field flags. ORM-agnostic — works on any `Schema`.
 */
export function applyPolicy(
  schema: Schema,
  policies: Record<string, EntityPolicy>,
): Schema {
  const entities: Record<string, EntityDefinition> = {};
  for (const [name, entity] of Object.entries(schema.entities)) {
    const policy = policies[name];
    entities[name] = policy ? applyEntityPolicy(entity, policy) : entity;
  }
  return { entities };
}

function applyEntityPolicy(
  entity: EntityDefinition,
  policy: EntityPolicy,
): EntityDefinition {
  const allow = (
    list: readonly string[] | undefined,
    field: string,
  ): boolean | undefined => (list ? list.includes(field) : undefined);

  const fields: Record<string, FieldDefinition> = {};
  for (const [fname, fdef] of Object.entries(entity.fields)) {
    const next = { ...fdef } as FieldDefinition;
    const f = allow(policy.filterable, fname);
    const s = allow(policy.sortable, fname);
    const sel = allow(policy.selectable, fname);
    if (f !== undefined) next.filterable = f;
    if (s !== undefined) next.sortable = s;
    if (sel !== undefined) next.selectable = sel;
    fields[fname] = next;
  }

  let relations: Record<string, RelationDefinition> | undefined;
  if (entity.relations) {
    relations = {};
    for (const [rname, rdef] of Object.entries(entity.relations)) {
      const next: RelationDefinition = { ...rdef };
      const inc = allow(policy.includable, rname);
      const rf = allow(policy.filterableRelations, rname);
      if (inc !== undefined) next.includable = inc;
      if (rf !== undefined) next.filterable = rf;
      relations[rname] = next;
    }
  }

  const out: EntityDefinition = { ...entity, fields };
  if (relations) out.relations = relations;
  if (policy.maxPerPage !== undefined) out.maxPerPage = policy.maxPerPage;
  return out;
}

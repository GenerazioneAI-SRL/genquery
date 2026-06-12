import {
  applyPolicy,
  type EntityDefinition,
  type EntityPolicy,
  type FieldDefinition,
  type FieldType,
  type RelationDefinition,
  type Schema,
  type UnmappedColumnDefinition,
} from "../../schema";
import type {
  PrismaDatamodel,
  PrismaEnumDef,
  PrismaFieldDef,
  PrismaModelDef,
} from "./types";

/** FieldTypes that don't require additional metadata (excludes `"enum"`). */
type ScalarFieldType = Exclude<FieldType, "enum">;

export interface SchemaFromPrismaOptions {
  /**
   * Restrict to specific models. Accepts model names. Defaults to all models
   * in the datamodel.
   */
  models?: readonly string[];
  /**
   * Per-model, per-field type overrides. Use this to map Prisma scalars that
   * the default mapper skips (e.g. `Json`, `Bytes`) to a genquery FieldType.
   *
   *   overrides: { User: { metadata: "string" } }
   */
  overrides?: Record<string, Record<string, ScalarFieldType>>;
  /**
   * Called when a scalar type is not recognized by the default mapping.
   * Return a FieldType to include the field, or `undefined` to skip it.
   * Defaults to skipping unknown types.
   */
  fallback?: (
    modelName: string,
    fieldName: string,
    scalarType: string,
  ) => ScalarFieldType | undefined;
  /**
   * Per-model allowlist policy (filterable/sortable/selectable/includable +
   * maxPerPage), keyed by model name. Projected onto the schema's per-field
   * flags via `applyPolicy` after the schema is built. Models absent here stay
   * unrestricted. This is how a backend enforces its resource-manifest
   * allowlists through the genquery parser.
   */
  policy?: Record<string, EntityPolicy>;
}

/**
 * Build a genquery `Schema` from a Prisma DMMF datamodel. Accepts the
 * datamodel structurally so the lib doesn't depend on a specific Prisma
 * version — pass `Prisma.dmmf.datamodel` (or whatever your version exposes)
 * directly.
 *
 *   import { Prisma } from "@prisma/client";
 *   const schema = schemaFromPrisma(Prisma.dmmf.datamodel);
 *   const adapter = new PrismaAdapter(schema);
 *
 * Restrict to specific models:
 *
 *   const schema = schemaFromPrisma(Prisma.dmmf.datamodel, {
 *     models: ["User", "Post"],
 *   });
 */
export function schemaFromPrisma(
  datamodel: PrismaDatamodel,
  options: SchemaFromPrismaOptions = {},
): Schema {
  const enumValues = indexEnums(datamodel.enums);

  const filter = options.models;
  const selected = filter
    ? datamodel.models.filter((m) => filter.includes(m.name))
    : datamodel.models;

  const entities: Record<string, EntityDefinition> = {};
  for (const model of selected) {
    entities[model.name] = buildEntity(model, enumValues, options);
  }
  const schema: Schema = { entities };
  return options.policy ? applyPolicy(schema, options.policy) : schema;
}

function indexEnums(
  enums: readonly PrismaEnumDef[],
): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const e of enums) {
    out.set(
      e.name,
      e.values.map((v) => v.name),
    );
  }
  return out;
}

function buildEntity(
  model: PrismaModelDef,
  enumValues: Map<string, readonly string[]>,
  options: SchemaFromPrismaOptions,
): EntityDefinition {
  const fields: Record<string, FieldDefinition> = {};
  const relations: Record<string, RelationDefinition> = {};
  // Columns the mapper skips (Json/Bytes/scalar lists/unknown) still exist on
  // the Prisma client output — track them so `applyPolicy` can flag the
  // policy-denied ones and the adapter can strip them from default selections.
  const unmappedColumns: Record<string, UnmappedColumnDefinition> = {};
  const overrides = options.overrides?.[model.name] ?? {};
  const keyFields = collectKeyFieldNames(model);

  for (const f of model.fields) {
    if (f.kind === "object") {
      relations[f.name] = {
        target: f.type,
        kind: f.isList ? "many" : "one",
      };
      continue;
    }
    if (f.kind === "unsupported") continue;

    const explicit = overrides[f.name];
    if (explicit) {
      fields[f.name] = {
        type: explicit,
        nullable: !f.isRequired,
      };
      continue;
    }

    if (f.kind === "enum") {
      const values = enumValues.get(f.type);
      if (!values) {
        unmappedColumns[f.name] = {};
        continue;
      }
      fields[f.name] = {
        type: "enum",
        values: values.slice(),
        nullable: !f.isRequired,
      };
      continue;
    }

    // Primary keys and relation foreign keys are matched by exact equality
    // regardless of the underlying scalar type.
    if (keyFields.has(f.name)) {
      fields[f.name] = { type: "id", nullable: !f.isRequired };
      continue;
    }

    // scalar
    const fieldType = mapScalar(f, model.name, options);
    if (!fieldType) {
      unmappedColumns[f.name] = {};
      continue;
    }
    fields[f.name] = {
      type: fieldType,
      nullable: !f.isRequired,
    };
  }

  // Add virtual override fields not present in the model.
  for (const [name, type] of Object.entries(overrides)) {
    if (!fields[name]) fields[name] = { type };
  }

  const definition: EntityDefinition = {
    name: model.name,
    fields,
  };
  if (Object.keys(unmappedColumns).length > 0)
    definition.unmappedColumns = unmappedColumns;
  if (Object.keys(relations).length > 0) definition.relations = relations;
  const pk = derivePrimaryKey(model);
  if (pk) definition.primaryKey = pk;
  return definition;
}

function collectKeyFieldNames(model: PrismaModelDef): Set<string> {
  const names = new Set<string>();
  for (const f of model.fields) {
    if (f.isId) names.add(f.name);
    if (f.kind === "object" && f.relationFromFields) {
      for (const fk of f.relationFromFields) names.add(fk);
    }
  }
  const composite = model.primaryKey?.fields;
  if (composite) {
    for (const name of composite) names.add(name);
  }
  return names;
}

function derivePrimaryKey(model: PrismaModelDef): string | undefined {
  const idField = model.fields.find((f) => f.isId === true);
  if (idField) return idField.name;
  const pk = model.primaryKey?.fields?.[0];
  if (pk) return pk;
  // Fallback for minimal DMMF shapes (Prisma 7+) that strip `isId`. The
  // convention in `schema.prisma` is to name the PK field `id`.
  const conventionalId = model.fields.find((f) => f.name === "id");
  return conventionalId?.name;
}

function mapScalar(
  field: PrismaFieldDef,
  modelName: string,
  options: SchemaFromPrismaOptions,
): ScalarFieldType | undefined {
  if (field.isList) return undefined; // genquery doesn't model scalar arrays
  switch (field.type) {
    case "String":
      return "string";
    case "Int":
    case "Float":
    case "Decimal":
    case "BigInt":
      return "number";
    case "Boolean":
      return "boolean";
    case "DateTime":
      return "date";
    default:
      return options.fallback?.(modelName, field.name, field.type);
  }
}

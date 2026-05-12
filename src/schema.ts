/**
 * Schema describes what fields and relations exist on each entity, so the
 * parser can validate queries and the adapter can produce correct joins and
 * conditions. The schema is intentionally ORM-agnostic.
 */

export type FieldType = "string" | "number" | "boolean" | "date" | "enum";

interface BaseFieldDefinition {
  /**
   * Override the database column name. Defaults to the field key.
   * Adapters may ignore this if they rely on ORM metadata (TypeORM uses the
   * entity's own column mapping).
   */
  column?: string;
  /**
   * Whether the column accepts NULL. Defaults to `false`. The parser uses this
   * to reject `{ isNull }` presence checks on non-nullable fields. With
   * `schemaFromTypeORM`, this is auto-populated from `ColumnMetadata.isNullable`.
   */
  nullable?: boolean;
}

export type FieldDefinition =
  | (BaseFieldDefinition & { type: "string" | "number" | "boolean" | "date" })
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

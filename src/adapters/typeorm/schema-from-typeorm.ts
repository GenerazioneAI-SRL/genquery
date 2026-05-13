import type { DataSource } from "typeorm";
import type { ColumnMetadata } from "typeorm/metadata/ColumnMetadata";
import type { EntityMetadata } from "typeorm/metadata/EntityMetadata";
import type {
  EntityDefinition,
  FieldDefinition,
  FieldType,
  RelationDefinition,
  Schema,
} from "../../schema";

/** FieldTypes that don't require additional metadata (excludes `"enum"`). */
type ScalarFieldType = Exclude<FieldType, "enum">;

export interface SchemaFromTypeORMOptions {
  /**
   * Restrict to specific entities. Accepts entity classes or entity names.
   * Defaults to all entities registered on the DataSource.
   */
  entities?: Array<Function | string>;
  /**
   * Per-entity, per-field type overrides. Use this to map custom column types
   * (e.g. `jsonb`, custom transformers) to a genquery FieldType, or to add
   * fields that don't correspond to a TypeORM column.
   *
   *   overrides: { User: { metadata: "string", legacyAge: "number" } }
   */
  overrides?: Record<string, Record<string, ScalarFieldType>>;
  /**
   * Called when a column type is not recognized by the default mapping.
   * Return a FieldType to include the column, or `undefined` to skip it.
   * Defaults to skipping unknown types.
   */
  fallback?: (
    entityName: string,
    propertyName: string,
    columnType: unknown,
  ) => ScalarFieldType | undefined;
}

/**
 * Build a genquery `Schema` from an initialized TypeORM `DataSource`.
 *
 * The DataSource must be initialized (`await dataSource.initialize()`) before
 * calling this function; otherwise `entityMetadatas` will be empty.
 *
 *   const dataSource = new DataSource({ ... });
 *   await dataSource.initialize();
 *   const schema = schemaFromTypeORM(dataSource);
 *   const adapter = new TypeORMAdapter(schema);
 *   const engine = new GenQueryEngine({ schema, adapter });
 *
 * Restrict to specific entities:
 *
 *   const schema = schemaFromTypeORM(dataSource, { entities: [User, Post] });
 *
 * Override a column type that isn't auto-detected:
 *
 *   const schema = schemaFromTypeORM(dataSource, {
 *     overrides: { User: { preferences: "string" } },
 *   });
 */
export function schemaFromTypeORM(
  dataSource: DataSource,
  options: SchemaFromTypeORMOptions = {},
): Schema {
  const all = dataSource.entityMetadatas;
  const filter = options.entities;
  const selected = filter
    ? all.filter((m) =>
        filter.some((t) =>
          typeof t === "string" ? t === m.name : t === m.target,
        ),
      )
    : all;

  const entities: Record<string, EntityDefinition> = {};
  for (const meta of selected) {
    entities[meta.name] = buildEntity(meta, options);
  }
  return { entities };
}

function buildEntity(
  meta: EntityMetadata,
  options: SchemaFromTypeORMOptions,
): EntityDefinition {
  const fields: Record<string, FieldDefinition> = {};
  const overrides = options.overrides?.[meta.name] ?? {};
  const keyColumns = collectKeyColumnNames(meta);

  for (const col of meta.columns) {
    const explicit = overrides[col.propertyName];
    if (explicit) {
      fields[col.propertyName] = { type: explicit, nullable: col.isNullable };
      continue;
    }
    // Enum columns: extract values so the parser can validate the allowlist.
    if (isStringEnumColumn(col)) {
      fields[col.propertyName] = {
        type: "enum",
        values: (col.enum as readonly string[]).slice(),
        nullable: col.isNullable,
      };
      continue;
    }
    // Key-like columns (primary keys, foreign keys, uuid-typed columns) are
    // always matched by exact equality — never with LIKE/ILIKE, which fails
    // outright on Postgres `uuid`.
    if (keyColumns.has(col.propertyName) || isUuidColumn(col)) {
      fields[col.propertyName] = { type: "id", nullable: col.isNullable };
      continue;
    }
    const fieldType = mapColumnType(col, meta.name, options);
    if (!fieldType) continue;
    fields[col.propertyName] = { type: fieldType, nullable: col.isNullable };
  }

  // Add any overrides that didn't correspond to a real column (e.g. virtual fields).
  for (const [name, type] of Object.entries(overrides)) {
    if (!fields[name]) fields[name] = { type };
  }

  const relations: Record<string, RelationDefinition> = {};
  for (const rel of meta.relations) {
    relations[rel.propertyName] = {
      target: rel.inverseEntityMetadata.name,
      kind: rel.isOneToOne || rel.isManyToOne ? "one" : "many",
    };
  }

  const definition: EntityDefinition = {
    name: meta.name,
    fields,
  };
  if (Object.keys(relations).length > 0) definition.relations = relations;
  const pk = meta.primaryColumns[0]?.propertyName;
  if (pk) definition.primaryKey = pk;
  return definition;
}

function isStringEnumColumn(col: ColumnMetadata): boolean {
  if (!Array.isArray(col.enum) || col.enum.length === 0) return false;
  return col.enum.every((v) => typeof v === "string");
}

function isUuidColumn(col: ColumnMetadata): boolean {
  const t = col.type;
  return typeof t === "string" && t.toLowerCase() === "uuid";
}

function collectKeyColumnNames(meta: EntityMetadata): Set<string> {
  const names = new Set<string>();
  for (const pk of meta.primaryColumns) {
    names.add(pk.propertyName);
  }
  for (const rel of meta.relations) {
    for (const jc of rel.joinColumns) {
      // `propertyName` here is the FK property on the parent entity
      // (e.g. `companyId`), not the related entity's id field.
      if (jc.propertyName) names.add(jc.propertyName);
    }
  }
  return names;
}

function mapColumnType(
  col: ColumnMetadata,
  entityName: string,
  options: SchemaFromTypeORMOptions,
): ScalarFieldType | undefined {
  const t = col.type;

  if (typeof t === "function") {
    if (t === String) return "string";
    if (t === Number) return "number";
    if (t === Boolean) return "boolean";
    if (t === Date) return "date";
  } else if (typeof t === "string") {
    const norm = t.toLowerCase();
    if (STRING_TYPES.has(norm)) return "string";
    if (NUMBER_TYPES.has(norm)) return "number";
    if (BOOLEAN_TYPES.has(norm)) return "boolean";
    if (DATE_TYPES.has(norm) || norm.startsWith("timestamp")) return "date";
    // "enum" / "simple-enum" columns are handled earlier via isStringEnumColumn.
    // If we reach this point, the values weren't strings — let the fallback decide.
  }

  return options.fallback?.(entityName, col.propertyName, t);
}

const STRING_TYPES = new Set([
  "string",
  "varchar",
  "varchar2",
  "char",
  "character",
  "character varying",
  "text",
  "tinytext",
  "mediumtext",
  "longtext",
  "ntext",
  "uuid",
  "citext",
  "nvarchar",
  "nvarchar2",
  "nchar",
]);

const NUMBER_TYPES = new Set([
  "int",
  "int2",
  "int4",
  "int8",
  "integer",
  "tinyint",
  "smallint",
  "mediumint",
  "bigint",
  "decimal",
  "numeric",
  "real",
  "float",
  "float4",
  "float8",
  "double",
  "double precision",
  "money",
  "smallmoney",
  "year",
]);

const BOOLEAN_TYPES = new Set(["bool", "boolean"]);

const DATE_TYPES = new Set([
  "date",
  "datetime",
  "datetime2",
  "datetimeoffset",
  "smalldatetime",
  "time",
  "timetz",
  "time with time zone",
  "time without time zone",
  "timestamp with time zone",
  "timestamp without time zone",
]);

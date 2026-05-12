import type { DataSource, ObjectLiteral, SelectQueryBuilder } from "typeorm";
import { GenQueryEngine } from "../../engine";
import { TypeORMAdapter, type TypeORMAdapterOptions } from "./adapter";
import {
  schemaFromTypeORM,
  type SchemaFromTypeORMOptions,
} from "./schema-from-typeorm";

export interface CreateTypeORMEngineOptions {
  /** Options forwarded to `schemaFromTypeORM` (entity filter, overrides, ...). */
  schema?: SchemaFromTypeORMOptions;
  /** Options forwarded to the `TypeORMAdapter` constructor (paramPrefix, ...). */
  adapter?: TypeORMAdapterOptions;
}

/**
 * One-line setup for the common case: read the schema from TypeORM, build the
 * adapter and the engine.
 *
 *   await dataSource.initialize();
 *   const engine = createTypeORMEngine(dataSource);
 *
 * For per-entity type overrides or custom adapter parameters:
 *
 *   const engine = createTypeORMEngine(dataSource, {
 *     schema:  { entities: [User, Post], overrides: { User: { meta: "string" } } },
 *     adapter: { paramPrefix: "q" },
 *   });
 *
 * The DataSource must be initialized before calling this — `entityMetadatas`
 * is empty otherwise.
 */
export function createTypeORMEngine(
  dataSource: DataSource,
  options: CreateTypeORMEngineOptions = {},
): GenQueryEngine<
  SelectQueryBuilder<ObjectLiteral>,
  SelectQueryBuilder<ObjectLiteral>
> {
  const schema = schemaFromTypeORM(dataSource, options.schema);
  const adapter = new TypeORMAdapter(schema, options.adapter);
  return new GenQueryEngine({ adapter });
}

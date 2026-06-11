import { GenQueryEngine } from "../../engine";
import { PrismaAdapter, type PrismaAdapterOptions } from "./adapter";
import {
  schemaFromPrisma,
  type SchemaFromPrismaOptions,
} from "./schema-from-prisma";
import type {
  PrismaDatamodel,
  PrismaFindManyArgs,
  PrismaModelDelegate,
} from "./types";

export interface CreatePrismaEngineOptions {
  /** Options forwarded to `schemaFromPrisma` (model filter, overrides, ...). */
  schema?: SchemaFromPrismaOptions;
  /** Options forwarded to the `PrismaAdapter` constructor (parallelCount, ...). */
  adapter?: PrismaAdapterOptions;
}

/**
 * One-line setup: read the schema from a Prisma DMMF datamodel, build the
 * adapter and the engine.
 *
 *   import { Prisma, PrismaClient } from "@prisma/client";
 *   const prisma = new PrismaClient();
 *   const engine = createPrismaEngine(Prisma.dmmf.datamodel);
 *   await engine.run(input, "User", prisma.user);
 *
 * Restrict to specific models or override scalar types:
 *
 *   const engine = createPrismaEngine(Prisma.dmmf.datamodel, {
 *     schema: { models: ["User", "Post"] },
 *     adapter: { parallelCount: false },
 *   });
 */
export function createPrismaEngine(
  datamodel: PrismaDatamodel,
  options: CreatePrismaEngineOptions = {},
): GenQueryEngine<PrismaModelDelegate, PrismaFindManyArgs> {
  const schema = schemaFromPrisma(datamodel, options.schema);
  const adapter = new PrismaAdapter(schema, options.adapter);
  return new GenQueryEngine({ adapter });
}

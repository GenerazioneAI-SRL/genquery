/**
 * Structural types for the Prisma adapter. Defined here so the package can
 * compile without `@prisma/client` installed (it's an optional peerDep).
 *
 * The runtime shapes match Prisma's actual API surface — the adapter feeds
 * delegate methods directly with the produced args.
 */

/**
 * Subset of a Prisma model delegate (e.g. `prisma.user`). Only the methods
 * the adapter calls are typed; the real delegate has many more.
 */
export interface PrismaModelDelegate {
  findMany(args?: PrismaFindManyArgs): Promise<unknown[]>;
  findFirst(args?: PrismaFindManyArgs): Promise<unknown | null>;
  count(args?: { where?: PrismaWhere }): Promise<number>;
}

/** Recursive Prisma `where` filter. */
export interface PrismaWhere {
  AND?: PrismaWhere[];
  OR?: PrismaWhere[];
  NOT?: PrismaWhere | PrismaWhere[];
  [field: string]: unknown;
}

/** Args object passed to `findMany` / `findFirst`. */
export interface PrismaFindManyArgs {
  where?: PrismaWhere;
  orderBy?: Record<string, "asc" | "desc"> | Array<Record<string, "asc" | "desc">>;
  skip?: number;
  take?: number;
  select?: PrismaSelect;
  include?: PrismaInclude;
}

export interface PrismaSelect {
  [field: string]: boolean | { select?: PrismaSelect; include?: PrismaInclude };
}

export interface PrismaInclude {
  [relation: string]: boolean | { select?: PrismaSelect; include?: PrismaInclude };
}

// ----------------------------------------------------------------------------
// Datamodel shapes — structural subset of `Prisma.dmmf.datamodel`.
// Mirrors the public shape so users can pass `Prisma.dmmf.datamodel` directly.
// ----------------------------------------------------------------------------

export interface PrismaDatamodel {
  models: readonly PrismaModelDef[];
  enums: readonly PrismaEnumDef[];
}

export interface PrismaModelDef {
  name: string;
  fields: readonly PrismaFieldDef[];
  primaryKey?: { fields: readonly string[] } | null;
}

export interface PrismaFieldDef {
  name: string;
  kind: "scalar" | "object" | "enum" | "unsupported";
  /**
   * For `scalar`: the scalar type name (`String`, `Int`, `Boolean`, `DateTime`,
   * `Float`, `Decimal`, `BigInt`, ...). For `object`: the related model name.
   * For `enum`: the enum name.
   */
  type: string;
  isList: boolean;
  isRequired: boolean;
  isId?: boolean;
  isUnique?: boolean;
  relationName?: string;
  /**
   * For `object` (relation) fields: the scalar fields on this model that hold
   * the foreign key. Used to flag those scalar fields as `id` type so they're
   * always matched by exact equality.
   */
  relationFromFields?: readonly string[];
}

export interface PrismaEnumDef {
  name: string;
  values: readonly { name: string }[];
}

import type { PaginatedResult, ParsedQuery } from "../../parsed";
import type { Schema } from "../../schema";
import type { Adapter } from "../base";
import { applySelectAndInclude } from "./select";
import type {
  PrismaFindManyArgs,
  PrismaModelDelegate,
  PrismaWhere,
} from "./types";
import { buildWhere } from "./where";

export interface PrismaAdapterOptions {
  /**
   * When `pagination.showTotal` is true, `execute` issues a parallel `count`
   * query. Set to `false` to run them sequentially (useful when the underlying
   * Prisma client doesn't pool well under concurrent reads). Defaults to true.
   */
  parallelCount?: boolean;
}

/**
 * Applies a parsed GenQuery to a Prisma model delegate (e.g. `prisma.user`).
 * Produces a Prisma `findMany` / `findFirst` args object and, on `execute`,
 * runs the query and an optional parallel `count`.
 *
 * Typical use through the engine:
 *
 *   const result = await engine.run(input, "User", prisma.user);
 *
 * The root entity name must be passed explicitly — Prisma delegates don't
 * expose their model name on a stable public API, so `getRootEntity` is not
 * implemented.
 */
export class PrismaAdapter
  implements Adapter<PrismaModelDelegate, PrismaFindManyArgs>
{
  readonly name = "prisma";
  readonly schema: Schema;
  private readonly options: PrismaAdapterOptions;

  constructor(schema: Schema, options: PrismaAdapterOptions = {}) {
    this.schema = schema;
    this.options = options;
  }

  apply(
    _delegate: PrismaModelDelegate,
    query: ParsedQuery,
  ): PrismaFindManyArgs {
    return this.build(query);
  }

  /**
   * Build a Prisma args object from a parsed query without needing a delegate.
   * Useful for tests / callers who already hold the args path.
   */
  buildArgs(query: ParsedQuery): PrismaFindManyArgs {
    return this.build(query);
  }

  async execute(
    delegate: PrismaModelDelegate,
    query: ParsedQuery,
  ): Promise<PaginatedResult<unknown>> {
    const args = this.build(query);
    const { kind, showNumber, showTotal } = query.pagination;
    const parallel = this.options.parallelCount ?? true;

    const dataPromise =
      kind === "first"
        ? delegate.findFirst(args).then((row) => (row ? [row] : []))
        : delegate.findMany(args);

    let total: number | undefined;
    if (showTotal && parallel) {
      const [data, count] = await Promise.all([
        dataPromise,
        delegate.count({ where: args.where }),
      ]);
      total = count;
      return assemble(data, showNumber, showTotal, total);
    }

    const data = await dataPromise;
    if (showTotal) total = await delegate.count({ where: args.where });
    return assemble(data, showNumber, showTotal, total);
  }

  private build(query: ParsedQuery): PrismaFindManyArgs {
    const args: PrismaFindManyArgs = {};

    if (query.searchBy) {
      const where: PrismaWhere = buildWhere(
        query.searchBy,
        this.schema,
        query.rootEntity,
      );
      if (Object.keys(where).length > 0) args.where = where;
    }

    if (query.orderBy) {
      args.orderBy = {
        [query.orderBy.field]: query.orderBy.order,
      };
    }

    applyPagination(args, query.pagination);
    applySelectAndInclude(args, query, this.schema);

    // Merge server-side raw base args (native Prisma filters/includes the DSL
    // doesn't model). where → AND-merged; orderBy/include/select → used when the
    // parsed query didn't set them.
    const base = query.baseArgs;
    if (base) {
      if (base.where !== undefined && base.where !== null) {
        args.where =
          args.where !== undefined
            ? ({ AND: [base.where, args.where] } as unknown as PrismaWhere)
            : (base.where as PrismaWhere);
      }
      if (base.orderBy !== undefined && args.orderBy === undefined) {
        args.orderBy = base.orderBy as PrismaFindManyArgs["orderBy"];
      }
      if (
        base.include !== undefined &&
        args.include === undefined &&
        args.select === undefined
      ) {
        args.include = base.include as PrismaFindManyArgs["include"];
      }
      if (
        base.select !== undefined &&
        args.select === undefined &&
        args.include === undefined
      ) {
        args.select = base.select as PrismaFindManyArgs["select"];
      }
    }
    return args;
  }
}

function applyPagination(
  args: PrismaFindManyArgs,
  pagination: ParsedQuery["pagination"],
): void {
  if (pagination.kind === "all") return;
  if (pagination.kind === "first") {
    args.take = 1;
    return;
  }
  args.skip = pagination.page * pagination.perPage;
  args.take = pagination.perPage;
}

function assemble(
  data: unknown[],
  showNumber: boolean,
  showTotal: boolean,
  total: number | undefined,
): PaginatedResult<unknown> {
  const result: PaginatedResult<unknown> = { data };
  if (showNumber) result.current = data.length;
  if (showTotal) result.total = total;
  return result;
}

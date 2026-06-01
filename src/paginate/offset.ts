import type { PrismaModelDelegate } from "./model";
import type { OffsetPaginateOptions, PaginatedResult } from "./types";
import { applyTransform } from "./transform";
import { buildMeta } from "./pagination";

/** Append tie-breaker field(s) (`asc`) to the caller's orderBy for stable paging. */
function withTieBreaker(
  orderBy: unknown,
  tieBreaker?: string | string[],
): unknown {
  if (!tieBreaker || orderBy === undefined) return orderBy;
  const fields = Array.isArray(tieBreaker) ? tieBreaker : [tieBreaker];
  const base = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...base, ...fields.map((f) => ({ [f]: "asc" }))];
}

/**
 * Offset-paginate a Prisma model.
 *
 *   const res = await paginate(prisma.user, { where, orderBy }, { page, perPage });
 *   // → { data, meta: { total, lastPage, currentPage, perPage, prev, next, hasPrev, hasNext } }
 *
 * Efficiency:
 *  - COUNT and findMany run in parallel.
 *  - `withTotal: false` SKIPS the COUNT entirely (fetches `perPage + 1` to know
 *    `hasNext`) — much cheaper on large tables.
 *  - `page <= 0` returns ALL rows (no LIMIT, no meta) — back-compat with the
 *    legacy paginator's "page 0 = everything" behavior.
 *
 * The `model` may be an authz-scoped delegate; scoping is preserved.
 */
export async function paginate<T = any>(
  model: PrismaModelDelegate,
  args: Record<string, any> = {},
  options: OffsetPaginateOptions<T> = {},
): Promise<PaginatedResult<T>> {
  const page = Number(options.page) || 0;
  const perPage = Number(options.perPage) || 10;
  const tieBreaker =
    options.orderByTieBreaker ?? options.orderByTieBreakerPropertyName;
  const orderBy = withTieBreaker(args.orderBy, tieBreaker);
  const withTotal = options.withTotal !== false;

  // page <= 0 → return everything (no pagination, no meta).
  if (page <= 0) {
    const rows = await model.findMany({ ...args, orderBy });
    return { data: applyTransform<T>(rows, options) };
  }

  const skip = perPage * (page - 1);

  if (withTotal) {
    const [total, rows] = await Promise.all([
      model.count({ where: args.where }),
      model.findMany({ ...args, orderBy, take: perPage, skip }),
    ]);
    return {
      data: applyTransform<T>(rows, options),
      meta: buildMeta({ page, perPage, total }),
    };
  }

  // Count-less: fetch one extra row to determine hasNext without a COUNT query.
  const rows = await model.findMany({
    ...args,
    orderBy,
    take: perPage + 1,
    skip,
  });
  const hasNext = rows.length > perPage;
  const pageRows = hasNext ? rows.slice(0, perPage) : rows;
  return {
    data: applyTransform<T>(pageRows, options),
    meta: buildMeta({ page, perPage, hasNext }),
  };
}

/**
 * Legacy-compatible factory: `paginator(options)(model, args)`. Equivalent to
 * `(model, args) => paginate(model, args, options)`. Drop-in replacement for
 * the old `utils/paginator` `paginator(...)` export.
 */
export function paginator<T = any>(options: OffsetPaginateOptions<T> = {}) {
  return (
    model: PrismaModelDelegate,
    args: Record<string, any> = {},
  ): Promise<PaginatedResult<T>> => paginate<T>(model, args, options);
}

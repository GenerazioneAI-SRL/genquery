import type { PrismaModelDelegate } from "./model";
import type { CursorPaginateOptions, CursorPaginatedResult } from "./types";
import { applyTransform } from "./transform";

/**
 * Cursor-paginate a Prisma model — O(1) deep pagination (no growing OFFSET),
 * the efficient choice for infinite-scroll / large datasets.
 *
 *   let res = await paginateCursor(prisma.post, { where }, { perPage: 20 });
 *   // next page:
 *   res = await paginateCursor(prisma.post, { where }, { perPage: 20, cursor: res.meta.nextCursor });
 *
 * `cursorField` must be unique & sequential (default `"id"`). The field is
 * appended to the caller's `orderBy` so ordering is deterministic. No COUNT is
 * ever issued. `direction: "backward"` sorts the cursor field descending.
 *
 * The `model` may be an authz-scoped delegate; scoping is preserved.
 */
export async function paginateCursor<T = any>(
  model: PrismaModelDelegate,
  args: Record<string, any> = {},
  options: CursorPaginateOptions<T> = {},
): Promise<CursorPaginatedResult<T>> {
  const perPage = Number(options.perPage) || 10;
  const field = options.cursorField ?? "id";
  const dir = options.direction === "backward" ? "desc" : "asc";

  const baseOrder = args.orderBy
    ? Array.isArray(args.orderBy)
      ? args.orderBy
      : [args.orderBy]
    : [];

  const findArgs: Record<string, any> = {
    ...args,
    orderBy: [...baseOrder, { [field]: dir }],
    take: perPage + 1,
  };
  const hasCursor = options.cursor !== undefined && options.cursor !== null;
  if (hasCursor) {
    findArgs.cursor = { [field]: options.cursor };
    findArgs.skip = 1; // skip the cursor row itself
  }

  const rows = await model.findMany(findArgs);
  const hasNext = rows.length > perPage;
  const pageRows = hasNext ? rows.slice(0, perPage) : rows;
  const last = pageRows[pageRows.length - 1];

  return {
    data: applyTransform<T>(pageRows, options),
    meta: {
      perPage,
      nextCursor: hasNext && last ? String(last[field]) : null,
      prevCursor: hasCursor ? String(options.cursor) : null,
      hasNext,
      hasPrev: hasCursor,
    },
  };
}

import type { Pagination, PaginationMeta } from "./types";

/**
 * Normalize raw page/perPage (possibly strings, possibly missing) into a
 * `{ page, perPage, skip }` triple. Page defaults to 1, perPage to 10.
 */
export function getPagination(
  rawPage?: number | string,
  rawPerPage?: number | string,
): Pagination {
  const page = Number(rawPage ?? 1) || 1;
  const perPage = Number(rawPerPage ?? 10) || 10;
  const skip = page > 0 ? perPage * (page - 1) : 0;
  return { page, perPage, skip };
}

/**
 * Build offset pagination meta. Pass `total` for full meta (lastPage/next from
 * the count), or omit it (with `hasNext`) for the count-less mode.
 */
export function buildMeta(args: {
  page: number;
  perPage: number;
  total?: number;
  /** Used only when `total` is undefined (count-less mode). */
  hasNext?: boolean;
}): PaginationMeta {
  const { page, perPage } = args;
  const hasPrev = page > 1;

  if (args.total === undefined) {
    const hasNext = !!args.hasNext;
    return {
      currentPage: page,
      perPage,
      prev: hasPrev ? page - 1 : null,
      next: hasNext ? page + 1 : null,
      hasPrev,
      hasNext,
    };
  }

  const total = args.total;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const hasNext = page < lastPage;
  return {
    total,
    lastPage,
    currentPage: page,
    perPage,
    prev: hasPrev ? page - 1 : null,
    next: hasNext ? page + 1 : null,
    hasPrev,
    hasNext,
  };
}

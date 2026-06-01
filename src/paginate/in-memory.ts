import type { PaginatedResult, Pagination } from "./types";
import { buildMeta } from "./pagination";

/**
 * Paginate an in-memory array (when you already hold the full result set, e.g.
 * after an aggregation that can't be paged in SQL). Slices `data` to the page
 * window and builds meta. Pass `count` if the true total differs from
 * `data.length` (e.g. `data` is already a page).
 */
export function getPaginatedResult<T>({
  data,
  pagination,
  count,
}: {
  data: T[];
  pagination: Pagination;
  count?: string | number;
}): PaginatedResult<T> {
  const { page, perPage } = pagination;
  const total = Number(count ?? data.length) || 0;

  const start = page > 1 ? (page - 1) * perPage : 0;
  const slicedData = data.slice(start, start + perPage);

  return {
    data: slicedData,
    meta: buildMeta({ page, perPage, total }),
  };
}

export * from "./types";
export * from "./model";
export { paginate, paginator } from "./offset";
export { paginateCursor } from "./cursor";
export { getPagination, buildMeta } from "./pagination";
export { getPaginatedResult } from "./in-memory";
export { transformWithClass, applyTransform } from "./transform";

import type * as T from "./types";

/**
 * Back-compat namespace mirroring the legacy `utils/paginator` export, so
 * existing code only needs to change the import specifier:
 *
 *   - import { PaginatorTypes } from "src/utilities/utils/paginator";
 *   + import { PaginatorTypes } from "@generazioneai/paginator";
 *
 * Prefer the top-level type exports (`PaginatedResult`, `Pagination`, …) in new code.
 */
export namespace PaginatorTypes {
  export type PaginatedResult<X> = T.PaginatedResult<X>;
  export type PaginationMeta = T.PaginationMeta;
  export type Pagination = T.Pagination;
  export type PaginateOptions<X = any> = T.OffsetPaginateOptions<X>;
  export type CursorPaginateOptions<X = any> = T.CursorPaginateOptions<X>;
  export type CursorPaginatedResult<X> = T.CursorPaginatedResult<X>;
  export type CursorMeta = T.CursorMeta;
}

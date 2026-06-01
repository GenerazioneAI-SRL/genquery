/**
 * Public types for @generazioneai/paginator.
 *
 * The library is framework-agnostic: it knows nothing about NestJS, your DI
 * container, or your entity classes. It only needs a Prisma-style model
 * delegate (see ./model) and, optionally, a `class-transformer` entity class.
 */

/** A class constructor usable as a class-transformer target. */
export type Ctor<T> = new (...args: any[]) => T;

/** A custom row mapper. Takes the raw rows, returns the shaped output. */
export type TransformFn<T> = (rows: any[]) => T[];

/** Resolved offset pagination triple. */
export interface Pagination {
  page: number;
  perPage: number;
  skip: number;
}

/** Meta attached to an offset-paginated result. */
export interface PaginationMeta {
  /** Total rows matching the query (omitted when `withTotal: false`). */
  total?: number;
  /** Last page number (omitted when `withTotal: false`). */
  lastPage?: number;
  currentPage: number;
  perPage: number;
  /** Previous page number, or null on the first page. */
  prev: number | null;
  /** Next page number, or null when there is no next page. */
  next: number | null;
  hasPrev: boolean;
  hasNext: boolean;
}

export interface PaginatedResult<T> {
  data: T[];
  /** Absent when `page <= 0` (the "return everything" mode). */
  meta?: PaginationMeta;
}

/** Options shared by every paginate function. */
export interface BasePaginateOptions<T> {
  /**
   * class-transformer target class. When set, rows are mapped through
   * `plainToInstance(cls, rows, { excludeExtraneousValues, enableImplicitConversion })`
   * then `instanceToPlain(..., { exposeUnsetFields: true })`. Requires the
   * optional peer dependency `class-transformer`.
   */
  type?: Ctor<T>;
  /** Custom row mapper. Takes precedence over `type`. */
  transform?: TransformFn<T>;
}

export interface OffsetPaginateOptions<T = any> extends BasePaginateOptions<T> {
  /** 1-based page. `0`/undefined ⇒ return ALL rows (no pagination, no meta). */
  page?: number | string;
  /** Rows per page. Default `10`. */
  perPage?: number | string;
  /**
   * When `false`, the COUNT query is SKIPPED — the paginator fetches `perPage + 1`
   * rows and derives `hasNext` from that. `total`/`lastPage` are then omitted.
   * Big win on large tables when the frontend only needs next/prev. Default `true`.
   */
  withTotal?: boolean;
  /**
   * Field name(s) appended `asc` to `orderBy` so ordering is deterministic
   * across pages (avoids row drift / duplicates when the sort key has ties).
   */
  orderByTieBreaker?: string | string[];
  /** @deprecated Back-compat alias of `orderByTieBreaker`. */
  orderByTieBreakerPropertyName?: string;
}

/** Meta attached to a cursor-paginated result. */
export interface CursorMeta {
  perPage: number;
  /** Cursor to pass back to fetch the next page, or null when exhausted. */
  nextCursor: string | null;
  /** The cursor this page was fetched from, or null on the first page. */
  prevCursor: string | null;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface CursorPaginatedResult<T> {
  data: T[];
  meta: CursorMeta;
}

export interface CursorPaginateOptions<T = any> extends BasePaginateOptions<T> {
  /** Rows per page. Default `10`. */
  perPage?: number | string;
  /** The cursor value (the `cursorField` of the last row of the previous page). */
  cursor?: string | number | null;
  /** Unique, sequential field used as the cursor. Default `"id"`. */
  cursorField?: string;
  /** Sort direction along the cursor field. Default `"forward"` (asc). */
  direction?: "forward" | "backward";
}

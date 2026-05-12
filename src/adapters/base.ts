import type { PaginatedResult, ParsedQuery } from "../parsed";
import type { Schema } from "../schema";

/**
 * Adapters translate a `ParsedQuery` into ORM-specific operations.
 *
 * The interface is intentionally generic in both the host-provided target
 * (e.g. a TypeORM `SelectQueryBuilder`, a Prisma client, ...) and the produced
 * result (e.g. the same query builder mutated in place, a Prisma `findMany`
 * argument object, ...). Each adapter declares the concrete shapes through
 * its own module.
 */
export interface Adapter<TTarget, TResult> {
  /** Stable adapter identifier (e.g. "typeorm", "prisma"). Useful for logging. */
  readonly name: string;

  /** Returns the schema the adapter was built against. */
  readonly schema: Schema;

  /**
   * Apply the parsed query against `target`. Implementations are free to
   * mutate `target` and return it, or to build a fresh value.
   */
  apply(target: TTarget, query: ParsedQuery): TResult;

  /**
   * Optionally derive the root entity name from a target. When implemented,
   * `engine.run(input, target)` can be called without an explicit
   * `rootEntity` string — the engine asks the adapter to extract it from the
   * target (e.g. TypeORM exposes it via `qb.expressionMap.mainAlias.metadata`).
   * Return `undefined` if the target lacks the metadata; the engine will
   * throw a helpful error.
   */
  getRootEntity?(target: TTarget): string | undefined;

  /**
   * Run the query end-to-end and return `{ data, current?, total? }` shaped
   * by `pagination.showNumber` / `pagination.showTotal`. Implemented by
   * adapters whose target can be executed directly (e.g. a TypeORM query
   * builder). `engine.run` delegates to this when present; pure args-builder
   * adapters (Prisma, args-only Mongo) leave it unset and callers consume
   * the apply result themselves.
   */
  execute?(target: TTarget, query: ParsedQuery): Promise<PaginatedResult<unknown>>;
}

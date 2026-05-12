import type { Adapter } from "./adapters/base";
import { parseQuery } from "./parser";
import type { ParsedQuery } from "./parsed";
import type { Schema } from "./schema";
import type { GenQueryInput } from "./types";

export interface GenQueryEngineOptions<TTarget, TResult> {
  schema: Schema;
  adapter: Adapter<TTarget, TResult>;
}

/**
 * Combines parsing + an adapter into a single entry point. The engine is
 * generic over the adapter so the signature of `run` matches the chosen
 * backend (e.g. `SelectQueryBuilder<T>` in/out for TypeORM).
 *
 * The schema given to the engine and the schema used by the adapter must be
 * the same instance; the engine asserts this at construction time.
 */
export class GenQueryEngine<TTarget, TResult> {
  readonly schema: Schema;
  readonly adapter: Adapter<TTarget, TResult>;

  constructor(options: GenQueryEngineOptions<TTarget, TResult>) {
    if (options.schema !== options.adapter.schema) {
      throw new Error(
        "GenQueryEngine: the schema passed to the engine must be the same instance used by the adapter",
      );
    }
    this.schema = options.schema;
    this.adapter = options.adapter;
  }

  /**
   * Parse only — useful when you want to inspect / cache the parsed form.
   *
   * Pass an entity class as the generic parameter to get autocomplete on
   * fields / relations (e.g. `engine.parse<User>(input, "User")`).
   */
  parse<T = unknown>(input: GenQueryInput<T>, rootEntity: string): ParsedQuery {
    return parseQuery(input as GenQueryInput, this.schema, rootEntity);
  }

  /**
   * Parse and apply.
   *
   * Pass an entity class as the generic parameter to get autocomplete on
   * fields / relations (e.g. `engine.run<User>(input, "User", qb)`).
   */
  run<T = unknown>(
    input: GenQueryInput<T>,
    rootEntity: string,
    target: TTarget,
  ): TResult {
    const parsed = this.parse<T>(input, rootEntity);
    return this.adapter.apply(target, parsed);
  }

  /** Apply a previously parsed query. */
  runParsed(parsed: ParsedQuery, target: TTarget): TResult {
    return this.adapter.apply(target, parsed);
  }
}

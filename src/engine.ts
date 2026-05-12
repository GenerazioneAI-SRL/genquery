import type { Adapter } from "./adapters/base";
import { parseQuery } from "./parser";
import type { ParsedQuery } from "./parsed";
import type { Schema } from "./schema";
import type { GenQueryInput } from "./types";

export interface GenQueryEngineOptions<TTarget, TResult> {
  adapter: Adapter<TTarget, TResult>;
}

// --- Type-level helpers for inferring the entity type from a target value ---

type IsAny<T> = 0 extends 1 & T ? true : false;

/** True for TypeORM's wide ObjectLiteral default — treat as "unspecified". */
type IsLooseRecord<T> = IsAny<T> extends true
  ? true
  : [T] extends [Record<string, any>]
    ? [Record<string, any>] extends [T]
      ? true
      : false
    : false;

/**
 * Inspect the target's structural shape. If it looks like a TypeORM
 * `SelectQueryBuilder<T>` (has `getMany(): Promise<T[]>`), pull out T.
 * Falls back to `unknown` (loose mode) for any other adapter target.
 */
type InferEntityFromTarget<X> = X extends {
  getMany(): Promise<infer A>;
}
  ? A extends (infer T)[]
    ? IsLooseRecord<T> extends true
      ? unknown
      : T
    : unknown
  : unknown;

/**
 * Combines parsing + an adapter into a single entry point. The engine is
 * generic over the adapter so the signature of `run` matches the chosen
 * backend (e.g. `SelectQueryBuilder<T>` in/out for TypeORM).
 *
 * The schema is read from the adapter — there is one source of truth.
 */
export class GenQueryEngine<TTarget, TResult> {
  readonly schema: Schema;
  readonly adapter: Adapter<TTarget, TResult>;

  constructor(options: GenQueryEngineOptions<TTarget, TResult>) {
    this.adapter = options.adapter;
    this.schema = options.adapter.schema;
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
   * The entity type is inferred from the `target` argument when it has a
   * recognizable shape (e.g. a TypeORM `SelectQueryBuilder<User>`). When the
   * adapter implements `getRootEntity`, the `rootEntity` string is optional —
   * the engine asks the adapter to derive it from the target. Pass an explicit
   * `rootEntity` to override (or when the adapter can't introspect).
   */
  run<X extends TTarget>(
    input: GenQueryInput<InferEntityFromTarget<X>>,
    target: X,
  ): TResult;
  run<X extends TTarget>(
    input: GenQueryInput<InferEntityFromTarget<X>>,
    rootEntity: string,
    target: X,
  ): TResult;
  run(
    input: GenQueryInput,
    arg2: string | TTarget,
    arg3?: TTarget,
  ): TResult {
    let rootEntity: string;
    let target: TTarget;
    if (typeof arg2 === "string") {
      rootEntity = arg2;
      target = arg3 as TTarget;
    } else {
      target = arg2;
      const derived = this.adapter.getRootEntity?.(target);
      if (!derived) {
        throw new Error(
          "GenQueryEngine.run: rootEntity not provided and the adapter " +
            `('${this.adapter.name}') could not derive it from the target. ` +
            "Pass rootEntity explicitly: engine.run(input, rootEntity, target).",
        );
      }
      rootEntity = derived;
    }
    const parsed = parseQuery(input, this.schema, rootEntity);
    return this.adapter.apply(target, parsed);
  }

  /** Apply a previously parsed query. */
  runParsed(parsed: ParsedQuery, target: TTarget): TResult {
    return this.adapter.apply(target, parsed);
  }
}

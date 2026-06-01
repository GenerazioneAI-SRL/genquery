/**
 * Optional class-transformer integration. `class-transformer` is an OPTIONAL
 * peer dependency: it is required lazily, only when the `type` option is used,
 * so consumers that pass `transform` (or nothing) never need it installed.
 */
import type { BasePaginateOptions, Ctor } from "./types";

let cached: any;
function classTransformer(): any {
  if (cached === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      cached = require("class-transformer");
    } catch {
      cached = null;
    }
  }
  if (!cached) {
    throw new Error(
      "@generazioneai/paginator: the `type` option requires the optional peer " +
        "dependency `class-transformer`. Install it, or use the `transform` option instead.",
    );
  }
  return cached;
}

/**
 * Map raw rows through an entity class: `plainToInstance` (drop unknown props,
 * coerce types) then `instanceToPlain` (serialize, keeping unset fields). This
 * mirrors the classic `transformResponse` helper used across the services.
 */
export function transformWithClass<T>(cls: Ctor<T>, rows: any[]): T[] {
  const { plainToInstance, instanceToPlain } = classTransformer();
  const instances = plainToInstance(cls, rows, {
    excludeExtraneousValues: true,
    enableImplicitConversion: true,
  });
  return instanceToPlain(instances, { exposeUnsetFields: true }) as T[];
}

/** Resolve the row mapper: `transform` wins over `type`; otherwise identity. */
export function applyTransform<T>(
  rows: any[],
  options: BasePaginateOptions<T>,
): T[] {
  if (options.transform) return options.transform(rows);
  if (options.type) return transformWithClass(options.type, rows);
  return rows as T[];
}

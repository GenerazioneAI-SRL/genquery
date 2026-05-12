import { QueryValidationError } from "./errors";
import type { DateTimeInput, DateTimeObjectInput } from "./types";

const ISO_OFFSET_RE = /^(Z|[+-]\d{2}(:?\d{2})?(:?:\d{2})?)$/;

function normalizeOffset(offset: string, path: string): string {
  if (offset === "Z") return "Z";
  if (!ISO_OFFSET_RE.test(offset)) {
    throw new QueryValidationError(
      `Invalid offset '${offset}' (expected 'Z' or '±HH:MM' / '±HHMM' / '±HH')`,
      path,
    );
  }
  // Ensure leading sign
  if (!offset.startsWith("+") && !offset.startsWith("-")) {
    offset = "+" + offset;
  }
  // Expand "+HH" -> "+HH:00" and "+HHMM" -> "+HH:MM"
  const sign = offset[0];
  const rest = offset.slice(1).replace(":", "");
  if (rest.length === 2) return `${sign}${rest}:00`;
  if (rest.length === 4) return `${sign}${rest.slice(0, 2)}:${rest.slice(2)}`;
  return offset;
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, "0");
}

export function parseDateTime(input: DateTimeInput, path: string): Date {
  if (typeof input === "string") {
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) {
      throw new QueryValidationError(
        `Invalid ISO 8601 datetime '${input}'`,
        path,
      );
    }
    return d;
  }

  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new QueryValidationError(
      `Expected ISO string or datetime object`,
      path,
    );
  }

  const obj = input as DateTimeObjectInput;
  const year = obj.year ?? 1970;
  const month = obj.month ?? 1;
  const day = obj.day ?? 1;
  const hours = obj.hours ?? 0;
  const minutes = obj.minutes ?? 0;
  const seconds = obj.seconds ?? 0;
  const offset = normalizeOffset(obj.offset ?? "Z", `${path}.offset`);

  for (const [k, v] of Object.entries({
    year,
    month,
    day,
    hours,
    minutes,
    seconds,
  })) {
    if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
      throw new QueryValidationError(
        `'${k}' must be an integer (got ${JSON.stringify(v)})`,
        path,
      );
    }
  }

  const iso = `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(
    minutes,
  )}:${pad(seconds)}${offset}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new QueryValidationError(
      `Invalid datetime components (built '${iso}')`,
      path,
    );
  }
  return d;
}

function isDateTimeObject(v: unknown): v is DateTimeObjectInput {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = new Set([
    "year",
    "month",
    "day",
    "hours",
    "minutes",
    "seconds",
    "offset",
  ]);
  // Treat as datetime object only if every key belongs to the set.
  // (Otherwise it might be a `{before, after}` range.)
  return Object.keys(v).every((k) => keys.has(k));
}

export function looksLikeDateTime(v: unknown): boolean {
  return typeof v === "string" || isDateTimeObject(v);
}

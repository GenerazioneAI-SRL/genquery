import { QueryValidationError } from "./errors";
import { looksLikeDateTime, parseDateTime } from "./datetime";
import {
  type EntityDefinition,
  type FieldDefinition,
  type Schema,
  getEntity,
} from "./schema";
import type {
  DateRangeInput,
  GenQueryInput,
  IncludeInput,
  OrderByInput,
  PaginationInput,
  SelectInput,
  StringSearchMode,
} from "./types";
import type {
  ParsedDateSearch,
  ParsedEmptyCheck,
  ParsedFieldCondition,
  ParsedIdSearch,
  ParsedInclude,
  ParsedIncludeRelation,
  ParsedNullCheck,
  ParsedNumberSearch,
  ParsedOrderBy,
  ParsedPagination,
  ParsedQuery,
  ParsedSearchBy,
  ParsedSelect,
  ParsedStringSearch,
} from "./parsed";

const STRING_MODES: readonly StringSearchMode[] = [
  "splitword",
  "exact",
  "nativeregex",
];

const NUMERIC_OPS = [">", "<", ">=", "<=", "=="] as const;

const PRESENCE_CHECK_KEYS = ["isNull", "isEmpty"] as const;
type PresenceCheckKey = (typeof PRESENCE_CHECK_KEYS)[number];

/**
 * Detect a presence-check wrapper: a plain object whose keys are all drawn
 * from `PRESENCE_CHECK_KEYS`. Returns `false` for objects mixing presence
 * keys with other keys so per-type parsers can report a more specific error.
 */
function isPresenceCheckObject(
  v: unknown,
): v is Record<PresenceCheckKey, boolean> {
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  if (keys.length === 0) return false;
  return keys.every((k) =>
    (PRESENCE_CHECK_KEYS as readonly string[]).includes(k),
  );
}

interface ParsedPresenceCheck {
  null?: ParsedNullCheck;
  empty?: ParsedEmptyCheck;
}

function parsePresenceCheck(
  raw: Record<string, unknown>,
  path: string,
): ParsedPresenceCheck {
  const out: ParsedPresenceCheck = {};
  for (const key of PRESENCE_CHECK_KEYS) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== "boolean") {
      throw new QueryValidationError(
        `Presence check: '${key}' must be a boolean`,
        `${path}.${key}`,
      );
    }
    if (key === "isNull") out.null = { isNull: v };
    else out.empty = { isEmpty: v };
  }
  // isPresenceCheckObject guarantees at least one key, so `out` is non-empty.
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    !(v instanceof Date)
  );
}

function parseIdSearch(raw: unknown, path: string): ParsedIdSearch {
  // Accept the bare scalar form.
  if (typeof raw === "string") return { value: raw };
  if (typeof raw === "number") return { value: String(raw) };
  // Accept the string-search object form for back-compat with frontends that
  // send `{ mode: "exact", value: "..." }` against ID columns. `mode`,
  // `contained`, and `caseSensitive` are ignored — ID searches are always
  // exact equality.
  if (isPlainObject(raw)) {
    const value = raw.value;
    if (typeof value === "string") return { value };
    if (typeof value === "number") return { value: String(value) };
    throw new QueryValidationError(
      "Id search: 'value' must be a string or number",
      `${path}.value`,
    );
  }
  throw new QueryValidationError(
    "Expected an id value (string/number) or { value } object",
    path,
  );
}

function parseStringSearch(
  raw: unknown,
  path: string,
): ParsedStringSearch {
  if (typeof raw === "string") {
    return {
      mode: "splitword",
      contained: false,
      caseSensitive: false,
      value: raw,
    };
  }
  if (!isPlainObject(raw)) {
    throw new QueryValidationError(
      "Expected string or string-search object",
      path,
    );
  }

  const value = raw.value;
  if (typeof value !== "string") {
    throw new QueryValidationError(
      "String search: 'value' must be a string",
      `${path}.value`,
    );
  }

  let mode: StringSearchMode = "splitword";
  if (raw.mode !== undefined) {
    if (typeof raw.mode !== "string" || !STRING_MODES.includes(raw.mode as StringSearchMode)) {
      throw new QueryValidationError(
        `String search: 'mode' must be one of ${STRING_MODES.join(", ")}`,
        `${path}.mode`,
      );
    }
    mode = raw.mode as StringSearchMode;
  } else if (typeof raw.type === "string") {
    // The spec example uses `type: "exact"` instead of `mode`. Accept both.
    if (!STRING_MODES.includes(raw.type as StringSearchMode)) {
      throw new QueryValidationError(
        `String search: 'type' must be one of ${STRING_MODES.join(", ")}`,
        `${path}.type`,
      );
    }
    mode = raw.type as StringSearchMode;
  }

  const contained =
    raw.contained === undefined ? false : Boolean(raw.contained);
  const caseSensitive =
    raw.caseSensitive === undefined ? false : Boolean(raw.caseSensitive);

  return { mode, contained, caseSensitive, value };
}

function parseNumberSearch(raw: unknown, path: string): ParsedNumberSearch {
  if (typeof raw === "number") {
    return { op: "==", value: raw };
  }
  if (!isPlainObject(raw)) {
    throw new QueryValidationError(
      "Expected number or numeric-comparison object",
      path,
    );
  }

  const value = raw.value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new QueryValidationError(
      "Numeric comparison: 'value' must be a finite number",
      `${path}.value`,
    );
  }
  if (raw.type !== undefined) {
    throw new QueryValidationError(
      "Numeric comparison: 'type' is not a valid key. Use 'operation' instead.",
      `${path}.type`,
    );
  }
  let op: ParsedNumberSearch["op"] = "==";
  if (raw.operation !== undefined) {
    if (
      typeof raw.operation !== "string" ||
      !NUMERIC_OPS.includes(raw.operation as ParsedNumberSearch["op"])
    ) {
      throw new QueryValidationError(
        `Numeric comparison: 'operation' must be one of ${NUMERIC_OPS.join(", ")}`,
        `${path}.operation`,
      );
    }
    op = raw.operation as ParsedNumberSearch["op"];
  }
  return { op, value };
}

function isDateRange(v: unknown): v is DateRangeInput {
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  if (keys.length === 0) return false;
  return keys.every((k) => k === "before" || k === "after");
}

function parseDateSearch(raw: unknown, path: string): ParsedDateSearch {
  if (isDateRange(raw)) {
    const out: ParsedDateSearch = { kind: "range" };
    if (raw.before !== undefined) {
      out.before = parseDateTime(raw.before, `${path}.before`);
    }
    if (raw.after !== undefined) {
      out.after = parseDateTime(raw.after, `${path}.after`);
    }
    if (out.before === undefined && out.after === undefined) {
      throw new QueryValidationError(
        "Date range must contain at least one of 'before' or 'after'",
        path,
      );
    }
    return out;
  }
  if (looksLikeDateTime(raw)) {
    return { kind: "exact", value: parseDateTime(raw as never, path) };
  }
  throw new QueryValidationError(
    "Expected ISO datetime, datetime object, or { before, after } range",
    path,
  );
}

const RELATION_OPS = ["some", "every", "none"] as const;
type RelationOpName = (typeof RELATION_OPS)[number];

/**
 * Detect the explicit-wrapper form for a relation filter and split it into one
 * entry per cardinality op. Returns `null` if the value is a plain SearchBy
 * (implicit `some`). Throws if the wrapper contains unknown keys.
 */
function parseRelationWrapper(
  value: unknown,
): Array<{ op: RelationOpName; nestedValue: unknown }> | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  const hasOp = keys.some((k) => (RELATION_OPS as readonly string[]).includes(k));
  if (!hasOp) return null;
  const unknown = keys.find(
    (k) => !(RELATION_OPS as readonly string[]).includes(k),
  );
  if (unknown !== undefined) {
    throw new QueryValidationError(
      `Unknown relation filter operator '${unknown}'. Expected 'some', 'every', or 'none'.`,
      unknown,
    );
  }
  const result: Array<{ op: RelationOpName; nestedValue: unknown }> = [];
  for (const op of RELATION_OPS) {
    const nestedValue = (value as Record<string, unknown>)[op];
    if (nestedValue !== undefined) result.push({ op, nestedValue });
  }
  return result;
}

function parseSearchBy(
  raw: unknown,
  schema: Schema,
  entityName: string,
  path: string,
): ParsedSearchBy {
  if (!isPlainObject(raw)) {
    throw new QueryValidationError(
      "searchBy must be an object",
      path,
    );
  }

  const entity = getEntity(schema, entityName);
  const conditions: ParsedFieldCondition[] = [];
  const or: ParsedSearchBy[] = [];

  for (const [key, value] of Object.entries(raw)) {
    const fieldPath = `${path}.${key}`;

    if (key === "OR") {
      if (!Array.isArray(value)) {
        throw new QueryValidationError("OR must be an array", fieldPath);
      }
      value.forEach((item, idx) => {
        or.push(
          parseSearchBy(item, schema, entityName, `${fieldPath}[${idx}]`),
        );
      });
      continue;
    }

    const fieldDef = entity.fields[key];
    const relationDef = entity.relations?.[key];

    if (fieldDef) {
      if (fieldDef.filterable === false) {
        throw new QueryValidationError(
          `Field '${key}' of '${entityName}' is not filterable`,
          fieldPath,
        );
      }
      conditions.push(...parseLeafConditions(key, fieldDef, value, fieldPath));
      continue;
    }

    if (relationDef) {
      if (relationDef.filterable === false) {
        throw new QueryValidationError(
          `Relation '${key}' of '${entityName}' is not filterable`,
          fieldPath,
        );
      }
      const wrapperOps = parseRelationWrapper(value);
      if (wrapperOps) {
        for (const { op, nestedValue } of wrapperOps) {
          conditions.push({
            kind: "relation",
            field: key,
            targetEntity: relationDef.target,
            op,
            nested: parseSearchBy(
              nestedValue,
              schema,
              relationDef.target,
              `${fieldPath}.${op}`,
            ),
          });
        }
      } else {
        conditions.push({
          kind: "relation",
          field: key,
          targetEntity: relationDef.target,
          op: "some",
          nested: parseSearchBy(value, schema, relationDef.target, fieldPath),
        });
      }
      continue;
    }

    throw new QueryValidationError(
      `Unknown field or relation '${key}' on entity '${entityName}'`,
      fieldPath,
    );
  }

  return { conditions, or };
}

function parseLeafConditions(
  field: string,
  def: FieldDefinition,
  value: unknown,
  path: string,
): ParsedFieldCondition[] {
  // Presence check (`isNull` on any primitive, `isEmpty` on strings only).
  // Detect before per-type parsing so e.g. `{ isNull: true }` on a string
  // field doesn't get rejected as a malformed StringSearchObjectInput.
  // Both keys may coexist and AND together (the parsed output is one
  // condition per key, and conditions naturally AND).
  if (isPresenceCheckObject(value)) {
    const parsed = parsePresenceCheck(value, path);
    if (parsed.null && !def.nullable) {
      throw new QueryValidationError(
        `isNull is only valid on nullable fields; field '${field}' is not nullable`,
        path,
      );
    }
    if (parsed.empty && def.type !== "string") {
      throw new QueryValidationError(
        `isEmpty is only valid on string fields; field '${field}' is ${def.type}`,
        path,
      );
    }
    const out: ParsedFieldCondition[] = [];
    if (parsed.null) out.push({ kind: "null", field, check: parsed.null });
    if (parsed.empty) out.push({ kind: "empty", field, check: parsed.empty });
    return out;
  }
  // Membership: `field: [v1, v2, ...]` → IN. string/id/enum/number only.
  if (Array.isArray(value)) {
    return [parseInCondition(field, def, value, path)];
  }
  return [parseLeafConditionTyped(field, def, value, path)];
}

function parseInCondition(
  field: string,
  def: FieldDefinition,
  value: unknown[],
  path: string,
): ParsedFieldCondition {
  if (def.type === "boolean" || def.type === "date") {
    throw new QueryValidationError(
      `Array (IN) search is not supported on ${def.type} fields`,
      path,
    );
  }
  if (value.length === 0) {
    throw new QueryValidationError(
      "IN list must contain at least one value",
      path,
    );
  }
  const values = value.map((v, i): string | number => {
    if (def.type === "number") {
      if (typeof v !== "number" || Number.isNaN(v)) {
        throw new QueryValidationError(
          "IN list on a number field must contain only numbers",
          `${path}[${i}]`,
        );
      }
      return v;
    }
    if (typeof v !== "string") {
      throw new QueryValidationError(
        `IN list on a ${def.type} field must contain only strings`,
        `${path}[${i}]`,
      );
    }
    if (def.type === "enum" && !def.values.includes(v)) {
      throw new QueryValidationError(
        `Value '${v}' is not one of the allowed enum values`,
        `${path}[${i}]`,
      );
    }
    return v;
  });
  return { kind: "in", field, values };
}

function parseLeafConditionTyped(
  field: string,
  def: FieldDefinition,
  value: unknown,
  path: string,
): ParsedFieldCondition {
  switch (def.type) {
    case "string":
      return {
        kind: "string",
        field,
        search: parseStringSearch(value, path),
      };
    case "number":
      return {
        kind: "number",
        field,
        search: parseNumberSearch(value, path),
      };
    case "boolean":
      if (typeof value !== "boolean") {
        throw new QueryValidationError(
          `Field '${field}' is boolean; expected true or false`,
          path,
        );
      }
      return { kind: "bool", field, search: { value } };
    case "date":
      return {
        kind: "date",
        field,
        search: parseDateSearch(value, path),
      };
    case "enum": {
      if (typeof value !== "string") {
        throw new QueryValidationError(
          `Field '${field}' is enum; expected a string`,
          path,
        );
      }
      if (!def.values.includes(value)) {
        throw new QueryValidationError(
          `Field '${field}' must be one of: ${def.values.join(", ")}`,
          path,
        );
      }
      return { kind: "enum", field, search: { value } };
    }
    case "id":
      return {
        kind: "id",
        field,
        search: parseIdSearch(value, path),
      };
    default:
      throw new QueryValidationError(
        `Unsupported field type '${(def as { type: string }).type}'`,
        path,
      );
  }
}

function parseOrderBy(
  raw: OrderByInput,
  entity: EntityDefinition,
  path: string,
): ParsedOrderBy {
  if (typeof raw === "string") {
    if (!entity.fields[raw]) {
      throw new QueryValidationError(
        `orderBy field '${raw}' is not a known field of '${entity.name}'`,
        path,
      );
    }
    if (entity.fields[raw].sortable === false) {
      throw new QueryValidationError(
        `orderBy field '${raw}' of '${entity.name}' is not sortable`,
        path,
      );
    }
    return { field: raw, order: "desc" };
  }
  if (!isPlainObject(raw)) {
    throw new QueryValidationError("orderBy must be a string or object", path);
  }
  const field = (raw as Record<string, unknown>).field;
  if (typeof field !== "string") {
    throw new QueryValidationError(
      "orderBy.field is required and must be a string",
      `${path}.field`,
    );
  }
  if (!entity.fields[field]) {
    throw new QueryValidationError(
      `orderBy field '${field}' is not a known field of '${entity.name}'`,
      `${path}.field`,
    );
  }
  if (entity.fields[field].sortable === false) {
    throw new QueryValidationError(
      `orderBy field '${field}' of '${entity.name}' is not sortable`,
      `${path}.field`,
    );
  }
  const order = (raw as Record<string, unknown>).order ?? "desc";
  if (order !== "asc" && order !== "desc") {
    throw new QueryValidationError(
      `orderBy.order must be 'asc' or 'desc'`,
      `${path}.order`,
    );
  }
  return { field, order };
}

function parseSelect(
  raw: SelectInput,
  entity: EntityDefinition,
  path: string,
): ParsedSelect {
  if (raw === "all") return { kind: "all" };
  if (raw === "none") return { kind: "none" };
  if (!isPlainObject(raw)) {
    throw new QueryValidationError(
      "select must be 'all', 'none', or an object",
      path,
    );
  }
  const fields: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (v !== true) continue;
    if (!entity.fields[k]) {
      throw new QueryValidationError(
        `select: '${k}' is not a known field of '${entity.name}'`,
        `${path}.${k}`,
      );
    }
    if (entity.fields[k].selectable === false) {
      throw new QueryValidationError(
        `select: field '${k}' of '${entity.name}' is not selectable`,
        `${path}.${k}`,
      );
    }
    fields.push(k);
  }
  return { kind: "fields", fields };
}

function parseInclude(
  raw: IncludeInput,
  entity: EntityDefinition,
  schema: Schema,
  path: string,
): ParsedInclude {
  // Tolleranza Prisma-style: true ≡ 'all', false ≡ 'none' (i client FE e la
  // federazione inviano naturalmente boolean; la grammatica canonica resta
  // 'all'/'none'/oggetto). Simmetrico ai livelli annidati (parseRelationSpec).
  if (raw === "none" || raw === false) return { kind: "none" };
  if (raw === "all" || raw === true) return { kind: "all" };
  if (!isPlainObject(raw)) {
    throw new QueryValidationError(
      "include must be 'all', 'none', or an object",
      path,
    );
  }

  const relations: Record<string, ParsedIncludeRelation> = {};
  for (const [relName, spec] of Object.entries(raw)) {
    // Prisma-style: relazione disattivata esplicitamente → come se omessa.
    if (spec === false || spec == null) continue;
    const relDef = entity.relations?.[relName];
    if (!relDef) {
      throw new QueryValidationError(
        `include: '${relName}' is not a known relation of '${entity.name}'`,
        `${path}.${relName}`,
      );
    }
    if (relDef.includable === false) {
      throw new QueryValidationError(
        `include: relation '${relName}' of '${entity.name}' is not includable`,
        `${path}.${relName}`,
      );
    }
    relations[relName] = parseRelationSpec(
      spec,
      getEntity(schema, relDef.target),
      schema,
      `${path}.${relName}`,
    );
  }
  return { kind: "map", relations };
}

/**
 * Parse one relation's include spec, RECURSIVELY. A spec object's keys may be
 * scalar fields of the target (value `true` → select that field) OR nested
 * relations of the target (value `true`/"all"/object → include that relation,
 * recursing). Enables multi-level includes (e.g. userSystemRoles → systemRole).
 */
function parseRelationSpec(
  spec: unknown,
  entity: EntityDefinition,
  schema: Schema,
  path: string,
): ParsedIncludeRelation {
  // true ≡ 'all' anche qui: copre i call-path diretti (top-level di parseInclude
  // normalizza già, ma envelope federati/legacy possono arrivare con boolean).
  if (spec === "all" || spec === true) return { kind: "all" };
  if (!isPlainObject(spec)) {
    throw new QueryValidationError(`${path} must be 'all' or an object`, path);
  }
  const fields: string[] = [];
  const relations: Record<string, ParsedIncludeRelation> = {};
  for (const [k, v] of Object.entries(spec)) {
    // Prisma-style: false/null su campo o relazione → escluso (come omesso).
    if (v === false || v == null) continue;
    const fieldDef = entity.fields[k];
    const relDef = entity.relations?.[k];
    if (fieldDef) {
      if (v !== true) {
        throw new QueryValidationError(
          `${path}.${k}: field selection must be true`,
          `${path}.${k}`,
        );
      }
      if (fieldDef.selectable === false) {
        throw new QueryValidationError(
          `${path}.${k}: field of '${entity.name}' is not selectable`,
          `${path}.${k}`,
        );
      }
      fields.push(k);
    } else if (relDef) {
      if (relDef.includable === false) {
        throw new QueryValidationError(
          `${path}.${k}: relation of '${entity.name}' is not includable`,
          `${path}.${k}`,
        );
      }
      relations[k] = parseRelationSpec(
        v === true ? "all" : v,
        getEntity(schema, relDef.target),
        schema,
        `${path}.${k}`,
      );
    } else {
      throw new QueryValidationError(
        `${path}.${k} is not a known field or relation of '${entity.name}'`,
        `${path}.${k}`,
      );
    }
  }
  return Object.keys(relations).length > 0
    ? { kind: "fields", fields, relations }
    : { kind: "fields", fields };
}

function parseShowFlag(
  raw: unknown,
  key: "showNumber" | "showTotal",
  path: string,
): boolean {
  if (raw === undefined) return true;
  if (typeof raw !== "boolean") {
    throw new QueryValidationError(
      `pagination.${key} must be a boolean`,
      `${path}.${key}`,
    );
  }
  return raw;
}

function parsePagination(
  raw: PaginationInput,
  entity: EntityDefinition,
  path: string,
): ParsedPagination {
  if (raw === "all") {
    return { kind: "all", showNumber: true, showTotal: true };
  }
  if (raw === "first") {
    return { kind: "first", showNumber: true, showTotal: true };
  }
  if (!isPlainObject(raw)) {
    throw new QueryValidationError(
      "pagination must be 'all', 'first', or an object",
      path,
    );
  }
  const obj = raw as Record<string, unknown>;
  const pageRaw = obj.page;
  const perPageRaw = obj.perPage;
  const page = pageRaw === undefined ? 0 : Number(pageRaw);
  const perPage = perPageRaw === undefined ? 20 : Number(perPageRaw);
  if (!Number.isInteger(page) || page < 0) {
    throw new QueryValidationError(
      "pagination.page must be a non-negative integer",
      `${path}.page`,
    );
  }
  if (!Number.isInteger(perPage) || perPage <= 0) {
    throw new QueryValidationError(
      "pagination.perPage must be a positive integer",
      `${path}.perPage`,
    );
  }
  // POLICY: clamp (not reject) an over-large page to the entity's max.
  const cappedPerPage =
    entity.maxPerPage !== undefined && perPage > entity.maxPerPage
      ? entity.maxPerPage
      : perPage;
  const showNumber = parseShowFlag(obj.showNumber, "showNumber", path);
  const showTotal = parseShowFlag(obj.showTotal, "showTotal", path);
  return { kind: "page", page, perPage: cappedPerPage, showNumber, showTotal };
}

// Avoid leaning on a circular type import in parseLeafCondition's signature.
// (The helper above is intentionally typed loosely; this re-export is the
// public signature.)
export function parseQuery(
  input: GenQueryInput,
  schema: Schema,
  rootEntity: string,
): ParsedQuery {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    input instanceof Date
  ) {
    throw new QueryValidationError("query must be an object", "");
  }
  const entity = getEntity(schema, rootEntity);

  const parsed: ParsedQuery = {
    rootEntity,
    include: { kind: "none" },
    select: { kind: "all" },
    pagination: { kind: "all", showNumber: true, showTotal: true },
  };

  if (input.orderBy !== undefined) {
    parsed.orderBy = parseOrderBy(input.orderBy, entity, "orderBy");
  }
  if (input.searchBy !== undefined) {
    parsed.searchBy = parseSearchBy(
      input.searchBy,
      schema,
      rootEntity,
      "searchBy",
    );
  }
  if (input.include !== undefined) {
    parsed.include = parseInclude(input.include, entity, schema, "include");
  }
  if (input.select !== undefined) {
    parsed.select = parseSelect(input.select, entity, "select");
  }
  if (input.pagination !== undefined) {
    parsed.pagination = parsePagination(input.pagination, entity, "pagination");
  }

  return parsed;
}

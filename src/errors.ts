/**
 * Thrown when the input query is structurally invalid or refers to unknown
 * fields/relations.
 */
export class QueryValidationError extends Error {
  /** Dot-path to the offending location inside the input query. */
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} (at ${path || "<root>"})`);
    this.name = "QueryValidationError";
    this.path = path;
  }
}

/**
 * Manages join aliases for a single query. Each (path, alias) pair is unique
 * within a query builder; aliases are derived from the relation path and a
 * monotonic counter to avoid collisions and to stay under Postgres' identifier
 * limit (63 chars).
 */
export class AliasRegistry {
  private byPath = new Map<string, string>();
  private counter = 0;

  constructor(private rootAlias: string) {}

  /** Returns the alias for `path` if a join was previously registered. */
  get(path: string): string | undefined {
    return this.byPath.get(path);
  }

  /** Returns the alias for the root entity. */
  root(): string {
    return this.rootAlias;
  }

  /**
   * Register an alias for `path`. `path` is expected to be a dot-joined chain
   * of relation names (e.g. "posts.comments"). The alias incorporates the path
   * but is truncated and suffixed with a counter for uniqueness.
   */
  register(path: string): string {
    const existing = this.byPath.get(path);
    if (existing) return existing;
    const suffix = String(this.counter++);
    const base = `${this.rootAlias}_${path.replace(/\./g, "_")}`;
    // Stay well under Postgres' 63-char identifier limit.
    const trimmed = base.length > 50 ? base.slice(0, 50) : base;
    const alias = `${trimmed}_${suffix}`;
    this.byPath.set(path, alias);
    return alias;
  }

  /** Iterate registered (path, alias) pairs in insertion order. */
  entries(): IterableIterator<[string, string]> {
    return this.byPath.entries();
  }
}

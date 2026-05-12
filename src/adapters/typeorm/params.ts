/** Generates unique parameter names for a TypeORM query builder. */
export class ParamCounter {
  private n = 0;
  constructor(private prefix = "gq") {}

  next(): string {
    return `${this.prefix}_${this.n++}`;
  }
}

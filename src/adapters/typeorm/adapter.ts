import { Brackets, type ObjectLiteral, type SelectQueryBuilder } from "typeorm";
import type { PaginatedResult, ParsedQuery, ParsedSelect } from "../../parsed";
import {
  type EntityDefinition,
  type Schema,
  getEntity,
  primaryKeyOf,
} from "../../schema";
import type { Adapter } from "../base";
import { AliasRegistry } from "./aliases";
import { planJoins, type JoinPlan } from "./joins";
import { ParamCounter } from "./params";
import { applySearchByInside, type WhereCtx } from "./where";

export interface TypeORMAdapterOptions {
  /** Override the parameter name prefix used in generated SQL. */
  paramPrefix?: string;
}

/**
 * Applies a parsed GenQuery to a TypeORM `SelectQueryBuilder`. The builder is
 * mutated in place and returned for convenience.
 *
 * Typical use:
 *
 *   const qb = userRepo.createQueryBuilder("user");
 *   adapter.apply(qb, parsed);
 *   const rows = await qb.getMany();
 */
export class TypeORMAdapter
  implements
    Adapter<SelectQueryBuilder<ObjectLiteral>, SelectQueryBuilder<ObjectLiteral>>
{
  readonly name = "typeorm";

  constructor(
    public readonly schema: Schema,
    private readonly options: TypeORMAdapterOptions = {},
  ) {}

  /**
   * Derive the root entity name from a TypeORM `SelectQueryBuilder`. Returns
   * the entity class name as TypeORM knows it (e.g. `"User"`), so the engine
   * can look it up in the schema without the caller having to repeat it.
   */
  getRootEntity(qb: SelectQueryBuilder<ObjectLiteral>): string | undefined {
    return qb.expressionMap?.mainAlias?.metadata?.name;
  }

  apply<T extends ObjectLiteral>(
    qb: SelectQueryBuilder<T>,
    query: ParsedQuery,
  ): SelectQueryBuilder<T> {
    const rootEntity = getEntity(this.schema, query.rootEntity);
    const aliases = new AliasRegistry(qb.alias);
    const params = new ParamCounter(this.options.paramPrefix);

    // 1. Root selection (must happen before leftJoinAndSelect calls, since
    //    `.select()` replaces the entire selection list).
    this.applyRootSelect(qb, rootEntity, query.select, aliases.root());

    // 2. Plan + apply all joins (includes + searchBy relations).
    const plans = planJoins(query, this.schema, aliases);
    for (const plan of plans) {
      this.applyJoin(qb, plan);
    }

    // 3. WHERE.
    if (query.searchBy) {
      const ctx: WhereCtx = {
        schema: this.schema,
        aliases,
        params,
        paramBag: {},
        currentAlias: aliases.root(),
        currentPath: "",
        currentEntity: query.rootEntity,
        connection: qb.connection,
      };
      qb.andWhere(
        new Brackets((sub) => applySearchByInside(sub, query.searchBy!, ctx)),
      );
    }

    // 4. ORDER BY.
    if (query.orderBy) {
      qb.addOrderBy(
        `${aliases.root()}.${query.orderBy.field}`,
        query.orderBy.order.toUpperCase() as "ASC" | "DESC",
      );
    }

    // 5. Pagination.
    this.applyPagination(qb, query.pagination);

    return qb;
  }

  /**
   * Apply the parsed query to `qb`, run it, and return `{ data, current?,
   * total? }` shaped by `pagination.showNumber` / `pagination.showTotal`
   * (both default to true). Uses `getManyAndCount` when a total is needed,
   * `getMany` otherwise. This is what `engine.run` invokes for TypeORM.
   */
  async execute<T extends ObjectLiteral>(
    qb: SelectQueryBuilder<T>,
    query: ParsedQuery,
  ): Promise<PaginatedResult<T>> {
    this.apply(qb, query);
    const { showNumber, showTotal } = query.pagination;

    let data: T[];
    let total: number | undefined;
    if (showTotal) {
      [data, total] = await qb.getManyAndCount();
    } else {
      data = await qb.getMany();
    }

    const result: PaginatedResult<T> = { data };
    if (showNumber) result.current = data.length;
    if (showTotal) result.total = total;
    return result;
  }

  private applyRootSelect<T extends ObjectLiteral>(
    qb: SelectQueryBuilder<T>,
    entity: EntityDefinition,
    select: ParsedSelect,
    rootAlias: string,
  ): void {
    if (select.kind === "all") return; // default behaviour
    const pk = primaryKeyOf(entity);
    if (select.kind === "none") {
      qb.select([`${rootAlias}.${pk}`]);
      return;
    }
    // fields
    const set = new Set(select.fields);
    set.add(pk); // keep primary key so hydration + relations still work
    qb.select([...set].map((f) => `${rootAlias}.${f}`));
  }

  private applyJoin<T extends ObjectLiteral>(
    qb: SelectQueryBuilder<T>,
    plan: JoinPlan,
  ): void {
    const targetEntity = getEntity(this.schema, plan.targetEntity);
    switch (plan.selection.kind) {
      case "none":
        qb.leftJoin(plan.propertyPath, plan.alias);
        return;
      case "all":
        qb.leftJoinAndSelect(plan.propertyPath, plan.alias);
        return;
      case "fields": {
        qb.leftJoin(plan.propertyPath, plan.alias);
        const pk = primaryKeyOf(targetEntity);
        const set = new Set(plan.selection.fields);
        set.add(pk);
        qb.addSelect([...set].map((f) => `${plan.alias}.${f}`));
        return;
      }
    }
  }

  private applyPagination<T extends ObjectLiteral>(
    qb: SelectQueryBuilder<T>,
    pagination: ParsedQuery["pagination"],
  ): void {
    if (pagination.kind === "all") return;
    if (pagination.kind === "first") {
      qb.skip(0).take(1);
      return;
    }
    qb.skip(pagination.page * pagination.perPage).take(pagination.perPage);
  }
}

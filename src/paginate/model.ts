/**
 * Structural contract for a Prisma model delegate (e.g. `prisma.user`).
 *
 * Declared structurally so the library does not depend on a specific Prisma
 * version or on `@prisma/client` at all — pass any object exposing `count`
 * and `findMany`. Crucially, this is satisfied by an authz-SCOPED delegate too
 * (the extended client returned by the authz Prisma extension), so pagination
 * automatically respects row-level scoping.
 */
export interface PrismaModelDelegate {
  count(args?: { where?: unknown }): Promise<number>;
  findMany(args?: Record<string, any>): Promise<any[]>;
}

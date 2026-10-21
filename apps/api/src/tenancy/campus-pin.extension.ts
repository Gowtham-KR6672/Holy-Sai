import { Prisma } from '@prisma/client';
import { AppError } from '../common/errors';
import { pinnedCampusOrNull } from './context';

/** Every school model with a campusId column, and whether the column is required. */
const CAMPUS_MODELS = new Map<string, boolean>(
  Prisma.dmmf.datamodel.models.flatMap((m) => {
    const field = m.fields.find((f) => f.name === 'campusId');
    return field ? [[m.name, field.isRequired] as [string, boolean]] : [];
  }),
);

/** Operations that take a `where` (reads, and updates / deletes of existing records). */
const FILTERED = new Set([
  'findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow',
  'count', 'aggregate', 'groupBy', 'update', 'updateMany', 'updateManyAndReturn', 'delete', 'deleteMany', 'upsert',
]);

const outside = () => new AppError(403, 'FORBIDDEN', 'That campus is outside your access');

type Where = Record<string, unknown> | undefined;
const and = (where: Where, extra: Record<string, unknown>) => {
  if (!where) return extra;
  const existing = where.AND ? (Array.isArray(where.AND) ? where.AND : [where.AND]) : [];
  return { ...where, AND: [...existing, extra] };
};

/**
 * Campus admins see and change only their own campus. While a request is pinned to a campus (see AuthGuard), every
 * query on a model with a campusId column is limited to that campus (records with no campus stay visible where the
 * column is optional), campuses other than their own disappear, and creating or moving a record into another campus
 * is refused. This also covers records opened by id. Raw SQL is not seen here; those reports take the campus from
 * ScopeService, which is pinned too.
 */
export const campusPinExtension = Prisma.defineExtension({
  name: 'campus-pin',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const pinned = pinnedCampusOrNull();
        if (!pinned || !model) return query(args);
        const a = (args ?? {}) as Record<string, unknown>;

        if (model === 'Campus') {
          if (operation === 'create' || operation === 'createMany' || operation === 'createManyAndReturn') {
            throw new AppError(403, 'FORBIDDEN', 'Only a Workspace Admin can add campuses');
          }
          if (FILTERED.has(operation)) a.where = and(a.where as Where, { id: pinned });
          return query(a);
        }

        const required = CAMPUS_MODELS.get(model);
        if (required === undefined) return query(args);
        if (FILTERED.has(operation)) {
          a.where = and(a.where as Where, required ? { campusId: pinned } : { OR: [{ campusId: pinned }, { campusId: null }] });
        }
        const check = (data: unknown) => {
          const c = (data as { campusId?: unknown } | null | undefined)?.campusId;
          if (typeof c === 'string' && c !== pinned) throw outside();
        };
        if (operation === 'create' || operation === 'update' || operation === 'updateMany' || operation === 'updateManyAndReturn') check(a.data);
        if (operation === 'upsert') {
          check(a.create);
          check(a.update);
        }
        if (operation === 'createMany' || operation === 'createManyAndReturn') (Array.isArray(a.data) ? a.data : [a.data]).forEach(check);
        return query(a);
      },
    },
  },
});

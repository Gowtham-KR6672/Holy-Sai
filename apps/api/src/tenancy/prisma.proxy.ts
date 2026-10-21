import type { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../common/prisma.service';
import type { TenancyService } from './tenancy.service';

/** Names Nest and Node probe on providers (promise check, lifecycle hooks, inspection) — never a database call. */
const NOT_FORWARDED = new Set<PropertyKey>([
  'then',
  'constructor',
  'toJSON',
  'onModuleInit',
  'onModuleDestroy',
  'onApplicationBootstrap',
  'beforeApplicationShutdown',
  'onApplicationShutdown',
]);

/**
 * PrismaService as injected everywhere: each property access is forwarded to the current workspace's client,
 * so modules keep writing `this.prisma.student.findMany()` and `this.prisma.$transaction(async (tx) => …)`.
 * Functions are bound to the real client (Prisma reads its own symbol-keyed state through `this`).
 */
export function createPrismaProxy(tenancy: TenancyService): PrismaService {
  const bound = new WeakMap<PrismaClient, Map<PropertyKey, unknown>>();
  return new Proxy(Object.create(null) as PrismaService, {
    get(_target, prop) {
      if (typeof prop === 'symbol' || NOT_FORWARDED.has(prop)) return undefined;
      const client = tenancy.current();
      const value: unknown = Reflect.get(client, prop, client);
      if (typeof value !== 'function') return value;
      let fns = bound.get(client);
      if (!fns) {
        fns = new Map();
        bound.set(client, fns);
      }
      let fn = fns.get(prop);
      if (!fn) {
        fn = (value as (...args: unknown[]) => unknown).bind(client);
        fns.set(prop, fn);
      }
      return fn;
    },
    has(_target, prop) {
      if (typeof prop === 'symbol' || NOT_FORWARDED.has(prop)) return false;
      return prop in tenancy.current();
    },
  });
}

import type { Prisma, PrismaClient } from '@prisma/client';
import { PERMISSIONS, ROLES } from '@holysai/shared';
import { SETTING_DEFAULTS } from '../modules/settings/defaults';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * A school's system catalogue: permissions, the roles and the default settings. Idempotent — run for a new school
 * and again after an upgrade (new permissions are added; a role's permissions are set only when the role is new,
 * except Super Admin, which always gets every permission). Settings are created once and never overwritten,
 * except the values passed in `overrides` on a new school.
 */
export async function seedSchoolCatalog(db: Db, overrides: Record<string, unknown> = {}) {
  // Permissions this school does not have yet (added in an upgrade): roles that are defined with them get them,
  // without touching the permissions a school changed by hand.
  const known = new Set((await db.permission.findMany({ select: { key: true } })).map((p) => p.key));
  const added = new Set(PERMISSIONS.map((p) => p.key as string).filter((k) => known.size > 0 && !known.has(k)));
  for (const [i, p] of PERMISSIONS.entries()) {
    await db.permission.upsert({
      where: { key: p.key },
      create: { key: p.key, module: p.area, description: p.label, sortOrder: i },
      update: { module: p.area, description: p.label, sortOrder: i },
    });
  }

  for (const [i, r] of ROLES.entries()) {
    const existing = await db.role.findUnique({ where: { key: r.key } });
    const role = await db.role.upsert({
      where: { key: r.key },
      create: { key: r.key, name: r.name, scope: r.scope, description: r.description, homeRoute: r.home, sortOrder: i },
      update: { name: r.name, scope: r.scope, description: r.description, homeRoute: r.home, sortOrder: i },
    });
    if (!existing || r.key === 'super_admin') {
      await db.rolePermission.deleteMany({ where: { roleId: role.id } });
      await db.rolePermission.createMany({ data: r.permissions.map((permissionKey) => ({ roleId: role.id, permissionKey })) });
    } else if (added.size) {
      const grant = r.permissions.filter((k) => added.has(k));
      if (grant.length) await db.rolePermission.createMany({ data: grant.map((permissionKey) => ({ roleId: role.id, permissionKey })), skipDuplicates: true });
    }
  }

  for (const s of SETTING_DEFAULTS) {
    const value = (s.key in overrides ? overrides[s.key] : s.value) as Prisma.InputJsonValue;
    await db.setting.upsert({
      where: { key: s.key },
      create: { key: s.key, value, description: s.description, isPublic: s.isPublic },
      update: { description: s.description, isPublic: s.isPublic },
    });
  }
  return { permissions: PERMISSIONS.length, roles: ROLES.length, settings: SETTING_DEFAULTS.length };
}

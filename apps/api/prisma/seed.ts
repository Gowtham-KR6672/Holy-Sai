// System data only — no demo records. Creates permissions, the 11 roles, default settings
// and the first Super Admin (from SEED_ADMIN_* in .env) if no Super Admin exists yet.
import { existsSync } from 'node:fs';
import { PrismaClient, type Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PERMISSIONS, ROLES } from '@holysai/shared';
import { SETTING_DEFAULTS } from '../src/modules/settings/defaults';

if (existsSync('.env')) process.loadEnvFile('.env');
const prisma = new PrismaClient();

async function main() {
  for (const [i, p] of PERMISSIONS.entries()) {
    await prisma.permission.upsert({
      where: { key: p.key },
      create: { key: p.key, module: p.area, description: p.label, sortOrder: i },
      update: { module: p.area, description: p.label, sortOrder: i },
    });
  }
  console.log(`Permissions: ${PERMISSIONS.length}`);

  for (const [i, r] of ROLES.entries()) {
    const existing = await prisma.role.findUnique({ where: { key: r.key } });
    const role = await prisma.role.upsert({
      where: { key: r.key },
      create: { key: r.key, name: r.name, scope: r.scope, description: r.description, homeRoute: r.home, sortOrder: i },
      update: { name: r.name, scope: r.scope, description: r.description, homeRoute: r.home, sortOrder: i },
    });
    // Permissions are set when the role is first created; Super Admin always gets every permission.
    if (!existing || r.key === 'super_admin') {
      await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
      await prisma.rolePermission.createMany({ data: r.permissions.map((permissionKey) => ({ roleId: role.id, permissionKey })) });
    }
  }
  console.log(`Roles: ${ROLES.length}`);

  for (const s of SETTING_DEFAULTS) {
    await prisma.setting.upsert({
      where: { key: s.key },
      create: { key: s.key, value: s.value as Prisma.InputJsonValue, description: s.description, isPublic: s.isPublic },
      update: { description: s.description, isPublic: s.isPublic },
    });
  }
  console.log(`Settings: ${SETTING_DEFAULTS.length}`);

  const superAdmins = await prisma.user.count({ where: { role: { key: 'super_admin' } } });
  if (superAdmins === 0) {
    const email = (process.env.SEED_ADMIN_EMAIL ?? '').trim().toLowerCase();
    const password = process.env.SEED_ADMIN_PASSWORD ?? '';
    if (!email || !password || password === 'change-me') {
      throw new Error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in apps/api/.env to create the first Super Admin.');
    }
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'super_admin' } });
    const user = await prisma.user.create({
      data: {
        fullName: process.env.SEED_ADMIN_NAME?.trim() || 'System Administrator',
        email,
        title: 'Platform Administration',
        roleId: role.id,
        passwordHash: await bcrypt.hash(password, 12),
      },
    });
    await prisma.auditLog.create({
      data: { userName: 'System', action: 'seed', module: 'system', entityType: 'user', entityId: user.id, description: `Created the first Super Admin (${email})`, device: 'system' },
    });
    console.log(`Super Admin created: ${email} (password is in apps/api/.env)`);
  } else {
    console.log('Super Admin already exists — left unchanged');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

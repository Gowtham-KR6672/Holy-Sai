// We School seed — system data only, no demo records:
//  1. the platform Super Admin (SEED_ADMIN_* in .env) if none exists yet, with its sign-in directory entry;
//  2. every school's system catalogue (permissions, roles, default settings) — new permissions after an upgrade.
// Schools themselves are created in the We School console (or tools/convert-to-weschool.mjs for an existing database).
import { existsSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaClient as PlatformClient } from '.prisma/platform-client';
import * as bcrypt from 'bcryptjs';
import { seedSchoolCatalog } from '../src/tenancy/school-seed';

if (existsSync('.env')) process.loadEnvFile('.env');

const withSchema = (schema: string) => {
  const url = new URL(process.env.DATABASE_URL ?? '');
  url.searchParams.set('schema', schema);
  return url.toString();
};

const platform = new PlatformClient({ datasources: { db: { url: withSchema('platform') } } });

async function main() {
  const admins = await platform.platformAdmin.count();
  if (admins === 0) {
    const email = (process.env.SEED_ADMIN_EMAIL ?? '').trim().toLowerCase();
    const password = process.env.SEED_ADMIN_PASSWORD ?? '';
    if (!email || !password || password === 'change-me') {
      throw new Error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in apps/api/.env to create the platform Super Admin.');
    }
    if (await platform.loginIdentifier.findUnique({ where: { kind_value: { kind: 'email', value: email } } })) {
      throw new Error(`${email} already signs in to a school — choose another SEED_ADMIN_EMAIL.`);
    }
    const admin = await platform.platformAdmin.create({
      data: { fullName: process.env.SEED_ADMIN_NAME?.trim() || 'We School Administrator', email, passwordHash: await bcrypt.hash(password, 12) },
    });
    await platform.loginIdentifier.create({ data: { kind: 'email', value: email, platformAdminId: admin.id } });
    await platform.platformAuditLog.create({ data: { adminName: 'System', action: 'seed', entityType: 'platform_admin', entityId: admin.id, description: `Created the platform Super Admin (${email})` } });
    console.log(`Platform Super Admin created: ${email} (password is in apps/api/.env)`);
  } else {
    console.log('Platform Super Admin already exists — left unchanged');
  }

  const schools = await platform.workspace.findMany({ where: { status: { in: ['active', 'suspended'] } }, orderBy: { createdAt: 'asc' } });
  for (const ws of schools) {
    const db = new PrismaClient({ datasources: { db: { url: withSchema(ws.schemaName) } } });
    try {
      const n = await seedSchoolCatalog(db);
      console.log(`${ws.name} (${ws.code}): ${n.permissions} permissions, ${n.roles} roles, ${n.settings} settings`);
    } finally {
      await db.$disconnect();
    }
  }
  if (!schools.length) console.log('No schools yet — create the first one in the We School console.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => platform.$disconnect());

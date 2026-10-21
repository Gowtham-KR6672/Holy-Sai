import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient as PlatformClient } from '.prisma/platform-client';

export type { Prisma as PlatformPrisma } from '.prisma/platform-client';

/** DATABASE_URL pointed at the "platform" schema (We School's own tables). */
export function platformDatabaseUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is not set');
  const url = new URL(base);
  url.searchParams.set('schema', 'platform');
  if (!url.searchParams.has('connection_limit')) url.searchParams.set('connection_limit', '5');
  return url.toString();
}

/** We School's platform database: workspaces, platform admins, the sign-in directory and platform audit. */
@Injectable()
export class PlatformDb extends PlatformClient implements OnModuleDestroy {
  constructor() {
    super({ datasources: { db: { url: platformDatabaseUrl() } } });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

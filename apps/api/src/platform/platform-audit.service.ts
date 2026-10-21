import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { clientIp, userAgent } from '../common/auth-user';
import { PlatformDb, type PlatformPrisma } from '../tenancy/platform-db.service';
import type { PlatformAdminUser } from './platform.guard';

/** The platform audit trail: what We School's own admins did (schools, support access, payments…). */
@Injectable()
export class PlatformAudit {
  constructor(private readonly platform: PlatformDb) {}

  async record(entry: {
    admin: PlatformAdminUser | null;
    action: string;
    description: string;
    entityType?: string;
    entityId?: string;
    workspaceId?: string | null;
    metadata?: Record<string, unknown>;
    req?: Request;
  }) {
    await this.platform.platformAuditLog.create({
      data: {
        adminId: entry.admin?.id ?? null,
        adminName: entry.admin?.fullName ?? 'System',
        action: entry.action,
        description: entry.description.slice(0, 1000),
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        workspaceId: entry.workspaceId ?? null,
        metadata: (entry.metadata ?? undefined) as PlatformPrisma.InputJsonValue | undefined,
        ip: entry.req ? clientIp(entry.req) : null,
        userAgent: entry.req ? userAgent(entry.req) : null,
      },
    });
  }
}

import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { AuthUser, clientIp, clientType, userAgent } from '../../common/auth-user';
import { PrismaService } from '../../common/prisma.service';

export type AuditAction =
  | 'view'
  | 'create'
  | 'update'
  | 'delete'
  | 'approve'
  | 'reject'
  | 'publish'
  | 'export'
  | 'ask'
  | 'login'
  | 'login_failed'
  | 'logout'
  | 'device_auth_failed'
  | 'seed';

export interface AuditInput {
  user?: Pick<AuthUser, 'id' | 'fullName' | 'roleKey'> | null;
  /** Name for actions without a signed-in user, e.g. "System" or a failed sign-in identifier. */
  userName?: string;
  action: AuditAction;
  module: string;
  description: string;
  entityType?: string;
  entityId?: string;
  campusId?: string | null;
  sensitive?: boolean;
  metadata?: Prisma.InputJsonValue;
  req?: Request;
}

/** Writes the audit trail. Restricted records log reads as well as writes. */
@Injectable()
export class AuditService {
  private readonly log = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: input.user?.id ?? null,
          userName: input.user?.fullName ?? input.userName ?? null,
          role: input.user?.roleKey ?? null,
          action: input.action,
          module: input.module,
          description: input.description,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          campusId: input.campusId ?? null,
          sensitive: input.sensitive ?? false,
          metadata: input.metadata,
          ip: input.req ? clientIp(input.req) : null,
          device: input.req ? clientType(input.req) : 'system',
          userAgent: input.req ? userAgent(input.req) : null,
        },
      });
    } catch (err) {
      // The audit trail must never break the action being audited.
      this.log.error(`Could not write audit entry: ${(err as Error).message}`);
    }
  }
}

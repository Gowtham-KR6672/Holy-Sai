import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { AuditService, type AuditInput } from '../audit/audit.service';

const VIEW_WINDOW_MS = 10 * 60 * 1000;

/** Audit trail for Paper Correction. Answer scripts and marks are sensitive, so views are logged too. */
@Injectable()
export class EcAudit {
  private seen = new Map<string, number>();

  constructor(private readonly audit: AuditService) {}

  record(user: AuthUser, input: Omit<AuditInput, 'user' | 'module'>, req?: Request) {
    return this.audit.record({ ...input, user, module: 'exam-correction', req });
  }

  /** Logs a view of sensitive records once per user and record every ten minutes (pages poll while busy). */
  async view(user: AuthUser, entityType: string, entityId: string, description: string, req?: Request, campusId?: string | null) {
    const key = `${user.id}:${entityType}:${entityId}`;
    const now = Date.now();
    if ((this.seen.get(key) ?? 0) > now - VIEW_WINDOW_MS) return;
    this.seen.set(key, now);
    if (this.seen.size > 5000) for (const [k, t] of this.seen) if (t < now - VIEW_WINDOW_MS) this.seen.delete(k);
    await this.audit.record({ user, action: 'view', module: 'exam-correction', entityType, entityId, description, sensitive: true, campusId: campusId ?? null, req });
  }
}

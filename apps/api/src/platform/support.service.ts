import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError, notFound } from '../common/errors';
import { AuditService } from '../modules/audit/audit.service';
import { TokensService } from '../modules/auth/tokens.service';
import { PlatformDb } from '../tenancy/platform-db.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { PlatformAudit } from './platform-audit.service';
import type { PlatformAdminUser } from './platform.guard';
import { ProvisioningService } from './provisioning.service';

/** A support session lasts an hour and cannot be refreshed; the admin enters again from the console. */
export const SUPPORT_SESSION_SECONDS = 3600;
const CODE_SECONDS = 60;
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/**
 * Support access: a platform admin opens any school (even a suspended or expired one) as the school's hidden
 * "We School Support" account. The console gets a single-use code; the new tab exchanges it for a one-hour access
 * token. Both the platform audit trail and the school's own Audit Trail record it.
 */
@Injectable()
export class SupportService {
  constructor(
    private readonly platform: PlatformDb,
    private readonly tenancy: TenancyService,
    private readonly tokens: TokensService,
    private readonly schoolAudit: AuditService,
    private readonly audit: PlatformAudit,
    private readonly provisioning: ProvisioningService,
  ) {}

  async createCode(workspaceId: string, admin: PlatformAdminUser, req: Request) {
    const ws = await this.platform.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws || !['active', 'suspended'].includes(ws.status)) throw notFound('School');
    const code = randomBytes(24).toString('base64url');
    await this.platform.supportCode.create({ data: { codeHash: sha256(code), adminId: admin.id, workspaceId: ws.id, expiresAt: new Date(Date.now() + CODE_SECONDS * 1000) } });
    await this.audit.record({ admin, action: 'support_requested', entityType: 'workspace', entityId: ws.id, workspaceId: ws.id, description: `Opened support access to ${ws.name}`, req });
    return { code, path: `/support#code=${code}` };
  }

  async exchange(code: string, req: Request) {
    const invalid = new AppError(401, 'SUPPORT_CODE_INVALID', 'This support link has expired. Open the school again from the We School console.');
    const row = await this.platform.supportCode.findUnique({ where: { codeHash: sha256(code) } });
    if (!row || row.usedAt || row.expiresAt < new Date()) throw invalid;
    const claimed = await this.platform.supportCode.updateMany({ where: { codeHash: row.codeHash, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) throw invalid;
    const admin = await this.platform.platformAdmin.findUnique({ where: { id: row.adminId } });
    const ws = await this.tenancy.byId(row.workspaceId);
    if (!admin || admin.status !== 'active' || !ws) throw invalid;

    const result = await this.tenancy.run(ws, async () => {
      const db = this.tenancy.current();
      let supportUserId = (await this.platform.workspace.findUnique({ where: { id: ws.id }, select: { supportUserId: true } }))?.supportUserId ?? null;
      if (!supportUserId || !(await db.user.count({ where: { id: supportUserId } }))) {
        supportUserId = await this.provisioning.ensureSupportUser(db, ws.code);
        await this.platform.workspace.update({ where: { id: ws.id }, data: { supportUserId } });
      }
      const access = await this.tokens.accessToken(supportUserId, randomUUID(), { sup: admin.id, ttl: SUPPORT_SESSION_SECONDS });
      await this.schoolAudit.record({
        user: { id: supportUserId, fullName: 'We School Support', roleKey: 'super_admin' },
        action: 'support_access',
        module: 'system',
        entityType: 'user',
        entityId: supportUserId,
        description: `We School support (${admin.fullName}) opened a support session`,
        req,
      });
      return access;
    });
    await this.audit.record({ admin: { id: admin.id, fullName: admin.fullName, email: admin.email }, action: 'support_access', entityType: 'workspace', entityId: ws.id, workspaceId: ws.id, description: `Entered ${ws.name} for support`, req });
    return { accessToken: result.token, expiresIn: result.expiresIn, school: { code: ws.code, name: ws.name } };
  }
}

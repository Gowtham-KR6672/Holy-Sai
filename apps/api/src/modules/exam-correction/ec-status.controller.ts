import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { EcAccess } from './ec.access';
import { EcAudit } from './ec.audit';
import { PushDto } from './ec.dto';
import { EcReports } from './ec.reports.service';
import { EcRoster } from './ec.roster.service';

interface LastSync { at: string; students_created: number; students_updated: number; staff: number }

/** Connection status, roster check and marks push (the calls outside /exam-correction/api). */
@Controller('exam-correction')
export class EcStatusController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly access: EcAccess,
    private readonly roster: EcRoster,
    private readonly reports: EcReports,
    private readonly audit: EcAudit,
  ) {}

  /** The marking engine runs inside this API, so it is connected whenever its tables exist. */
  @Get('status')
  @RequirePermissions('assessments.manage', 'settings.manage')
  async status(@CurrentUser() user: AuthUser) {
    const role = this.access.role(user);
    try {
      const state = await this.access.aiState();
      return { connected: true, waking: false, reason: null, role, ai: state.status, lastSync: (state.cfg.lastSync as unknown as LastSync | null) ?? null };
    } catch (err) {
      const code = (err as Prisma.PrismaClientKnownRequestError)?.code;
      if (code === 'P2021' || code === 'P2022') {
        return { connected: false, waking: false, reason: 'Paper Correction is installed but its database tables are not created yet — the administrator applies the latest database migration.', role, lastSync: null };
      }
      throw err;
    }
  }

  /**
   * Students and staff are read live from Holy Sai, so there is nothing to copy. This checks the roster,
   * re-links examinations to their class, section and subject records, and records the time of the check.
   */
  @Post('sync')
  @HttpCode(200)
  @RequirePermissions('assessments.manage')
  async sync(@CurrentUser() user: AuthUser, @Req() req: Request) {
    this.access.assertManager(user);
    const campusId = this.scope.campus(user);
    const [students, staff, relinked] = await Promise.all([
      this.prisma.student.count({ where: { status: 'active', ...(campusId ? { campusId } : {}) } }),
      this.prisma.user.count({ where: { status: 'active', role: { permissions: { some: { permissionKey: 'assessments.manage' } } }, ...(campusId ? { OR: [{ campusId }, { campusId: null }] } : {}) } }),
      this.roster.relinkExams(),
    ]);
    const lastSync: LastSync = { at: new Date().toISOString(), students_created: 0, students_updated: students, staff };
    await this.access.config();
    await this.prisma.examCorrectionConfig.update({ where: { id: 'default' }, data: { lastSync: lastSync as unknown as Prisma.InputJsonValue, updatedById: user.id } });
    await this.audit.record(user, { action: 'update', entityType: 'roster', description: `Checked the Paper Correction roster: ${students} students, ${staff} staff${relinked ? `, ${relinked} examination(s) re-linked` : ''}` }, req);
    return ok(lastSync, `Roster is up to date — ${students} students and ${staff} staff are read directly from Holy Sai${relinked ? `; ${relinked} examination(s) re-linked to their class` : ''}`);
  }

  @Post('exams/:id/push-marks')
  @HttpCode(200)
  @RequirePermissions('assessments.manage')
  async push(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PushDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const exam = await this.access.exam(user, id);
    const r = await this.reports.push(user, exam, dto.assessmentId, req);
    return ok(r, `${r.sent} mark(s) sent to the assessment`);
  }
}

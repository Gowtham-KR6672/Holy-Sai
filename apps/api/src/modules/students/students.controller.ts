import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { fieldError, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { StudentLifecycleService } from './lifecycle.service';
import { StudentProfileService } from './profile.service';
import { StudentRecordsService } from './records.service';
import {
  AchievementDto, CampusQuery, CreateStudentDto, LeaveDto, ObservationDto, ProfileBehaviourDto, ReactivateDto, StatusChangeDto,
  StudentListQuery, UpdateStudentDto,
} from './students.dto';
import { StudentsService } from './students.service';
import { asDate, assertId, dayKey, isDateKey, schoolToday, STAFF_READ, STATUS_LABEL } from './students.util';

const PROFILE_READ = [...STAFF_READ, 'parent_portal.use', 'student_portal.use'];

/** The student register, the Student 360 profile and its records, and the student lifecycle. */
@Controller('students')
export class StudentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly students: StudentsService,
    private readonly profiles: StudentProfileService,
    private readonly records: StudentRecordsService,
    private readonly lifecycle: StudentLifecycleService,
  ) {}

  // -------------------------------------------------------------------------
  // Register
  // -------------------------------------------------------------------------

  @Get()
  @RequirePermissions(...STAFF_READ)
  list(@Query() q: StudentListQuery, @CurrentUser() user: AuthUser) {
    return this.students.list(user, q);
  }

  @Get('summary')
  @RequirePermissions(...STAFF_READ)
  summary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    return this.students.summary(user, q.campusId);
  }

  @Post()
  @RequirePermissions('students.create')
  async create(@Body() dto: CreateStudentDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const r = await this.students.create(user, dto, req);
    return ok(r, `${r.fullName} created as ${r.admissionNo}`);
  }

  @Put(':id')
  @RequirePermissions('students.update')
  async update(@Param('id') id: string, @Body() dto: UpdateStudentDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    assertId(id);
    const r = await this.students.update(user, id, dto, req);
    return ok(r, r.changed.length ? 'Student updated' : 'No changes to save');
  }

  // -------------------------------------------------------------------------
  // Lifecycle: records are kept; leaving disables the student's (and, when no child remains, the parents') sign-in
  // -------------------------------------------------------------------------

  @Patch(':id/status')
  @RequirePermissions('students.archive')
  async status(@Param('id') id: string, @Body() dto: StatusChangeDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    await this.access(user, id);
    const r = await this.lifecycle.changeStatus(user, id, dto, req);
    return ok(r, this.statusMessage(r));
  }

  @Post(':id/discontinue')
  @RequirePermissions('students.archive')
  async discontinue(@Param('id') id: string, @Body() dto: LeaveDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    await this.access(user, id);
    const r = await this.lifecycle.changeStatus(user, id, { status: dto.status ?? 'discontinued', reason: dto.reason, effectiveOn: dto.effectiveOn }, req);
    return ok(r, this.statusMessage(r));
  }

  @Post(':id/reactivate')
  @RequirePermissions('students.archive')
  async reactivate(@Param('id') id: string, @Body() dto: ReactivateDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    await this.access(user, id);
    const r = await this.lifecycle.changeStatus(user, id, { status: 'active', reason: dto.reason }, req);
    return ok(r, this.statusMessage(r));
  }

  @Get(':id/status-history')
  @RequirePermissions(...STAFF_READ)
  async statusHistory(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.access(user, id);
    const rows = await this.prisma.studentStatusChange.findMany({ where: { studentId: id }, orderBy: { createdAt: 'desc' } });
    return rows.map((c) => ({
      id: c.id, fromStatus: c.fromStatus, toStatus: c.toStatus, effectiveOn: dayKey(c.effectiveOn), reason: c.reason,
      accountsDisabled: c.disabledUserIds.length, accountsEnabled: c.enabledUserIds.length, changedBy: c.changedByName, changedAt: c.createdAt.toISOString(),
    }));
  }

  // -------------------------------------------------------------------------
  // Student 360 (staff), Parent 360 (family) and My profile (self)
  // -------------------------------------------------------------------------

  @Get(':id/profile')
  @RequirePermissions(...PROFILE_READ)
  profile(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.profiles.profile(user, id, req);
  }

  @Post(':id/behaviour')
  @RequirePermissions(...STAFF_READ)
  async behaviour(@Param('id') id: string, @Body() dto: ProfileBehaviourDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    assertId(id);
    const row = await this.records.addBehaviour(user, { studentId: id, recordType: dto.recordType, note: dto.note, source: 'student360' }, req);
    return ok(row, `${row.type} note saved to the profile`);
  }

  @Post(':id/observations')
  @RequirePermissions(...STAFF_READ)
  async observation(@Param('id') id: string, @Body() dto: ObservationDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    assertId(id);
    const row = await this.records.addObservation(user, id, dto.observation, req);
    return ok(row, 'Observation saved to the profile');
  }

  /** Recorded by staff from Student 360, so it is verified on entry. Stored with the Innovation Lab's achievements. */
  @Post(':id/achievements')
  @RequirePermissions(...STAFF_READ)
  async achievement(@Param('id') id: string, @Body() dto: AchievementDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    assertId(id);
    const s = await this.prisma.student.findUnique({ where: { id }, select: { id: true, fullName: true, admissionNo: true, campusId: true, dateOfBirth: true } });
    if (!s) throw notFound('Student');
    await this.scope.assertStudent(user, id);
    const today = schoolToday();
    if (!isDateKey(dto.achievedOn)) throw fieldError('achievedOn', 'Enter the date');
    if (dto.achievedOn > today) throw fieldError('achievedOn', 'The date cannot be in the future');
    if (dto.achievedOn < dayKey(s.dateOfBirth)) throw fieldError('achievedOn', 'The date is before the date of birth');
    const now = new Date();
    const title = dto.title.trim();
    const row = await this.prisma.innovationAchievement.create({
      data: {
        studentId: s.id, campusId: s.campusId, title, type: dto.achievementType, level: dto.level ?? 'School', achievedOn: asDate(dto.achievedOn),
        verified: true, verifiedById: user.id, verifiedByName: user.fullName, verifiedAt: now, source: 'student360', createdById: user.id,
      },
    });
    await this.audit.record({
      user, req, action: 'create', module: 'students', entityType: 'achievement', entityId: row.id, campusId: s.campusId,
      description: `Recorded achievement "${title}" (${dto.achievementType}${dto.level ? `, ${dto.level}` : ''}) for ${s.fullName} (${s.admissionNo})`,
    });
    const own = await this.prisma.user.findMany({ where: { studentId: s.id, status: 'active' }, select: { id: true } });
    const notice = {
      category: 'Completed' as const, topic: 'system', module: 'students', icon: 'award', campusId: s.campusId,
      title: `Achievement recorded: ${title}`, body: `${s.fullName} · ${dto.achievementType}${dto.level ? ` · ${dto.level}` : ''}`,
    };
    await this.notifications.notifyUsers(own.map((u) => u.id), { ...notice, route: '/my-profile?view=profile&tab=achievements' });
    await this.notifications.notifyGuardians(s.id, { ...notice, route: '/parent-360' });
    return ok(
      { id: row.id, title: row.title, type: row.type, level: row.level, date: dayKey(row.achievedOn), verified: row.verified },
      'Achievement recorded and verified',
    );
  }

  /** 404 for an unknown student, 403 for one outside the user's scope. */
  private async access(user: AuthUser, id: string) {
    assertId(id);
    if (!(await this.prisma.student.count({ where: { id } }))) throw notFound('Student');
    await this.scope.assertStudent(user, id);
  }

  private statusMessage(r: { status: string; accountsDisabled: number; accountsEnabled: number }) {
    const label = STATUS_LABEL[r.status] ?? r.status;
    if (r.status === 'active') return `Student re-activated${r.accountsEnabled ? ` · ${r.accountsEnabled} sign-in account${r.accountsEnabled === 1 ? '' : 's'} re-enabled` : ''}`;
    return `Student marked ${label.toLowerCase()}${r.accountsDisabled ? ` · ${r.accountsDisabled} sign-in account${r.accountsDisabled === 1 ? '' : 's'} disabled` : ''}`;
  }
}

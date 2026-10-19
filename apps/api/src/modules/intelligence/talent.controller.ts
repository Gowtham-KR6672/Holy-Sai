import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { conflict, fieldError, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { assertUuid, truncate } from './intel.util';
import { findStudent } from './student-ref';
import { StudentExtrasService } from './student-extras.service';
import { TalentService } from './talent.service';

class DecisionDto {
  @IsIn(['accept', 'dismiss'], { message: 'Choose offer or dismiss' }) decision: 'accept' | 'dismiss';
  @IsOptional() @IsString() @MaxLength(300) opportunity?: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

/** Talent Discovery: strength distribution, unrecognised potential and recorded decisions. */
@Controller('talent')
@RequirePermissions('students.read', 'students.read_assigned', 'ai.use')
export class TalentController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly talent: TalentService,
    private readonly extras: StudentExtrasService,
  ) {}

  @Get('overview')
  async overview(@Query('campusId') campusId: string | undefined, @CurrentUser() user: AuthUser) {
    const where: Prisma.StudentWhereInput = { AND: [await this.scope.studentWhere(user, campusId), { status: 'active' }] };
    const students = await this.prisma.student.findMany({
      where,
      select: { id: true, fullName: true, admissionNo: true, section: { select: { name: true, class: { select: { name: true } } } } },
    });
    const ids = students.map((s) => s.id);
    const [threshold, strengths, decisions] = await Promise.all([
      this.talent.threshold(),
      this.talent.strengths(ids),
      ids.length ? this.prisma.talentDecision.findMany({ where: { studentId: { in: ids } }, orderBy: { decidedAt: 'desc' } }) : Promise.resolve([]),
    ]);
    const byStudent = new Map(students.map((s) => [s.id, s]));

    const skills = new Map<string, { strong: number; developing: number; emerging: number; scores: number[] }>();
    for (const s of strengths) {
      const g = skills.get(s.skill) ?? { strong: 0, developing: 0, emerging: 0, scores: [] };
      if (s.score >= threshold) g.strong++;
      else if (s.score >= 68) g.developing++;
      else g.emerging++;
      g.scores.push(s.score);
      skills.set(s.skill, g);
    }
    const distribution = [...skills.entries()]
      .map(([skill, g]) => ({ skill, strong: g.strong, developing: g.developing, emerging: g.emerging, average: Math.round(g.scores.reduce((a, b) => a + b, 0) / g.scores.length) }))
      .sort((a, b) => b.strong - a.strong || b.average - a.average);

    const decided = new Set(decisions.map((d) => `${d.studentId}|${d.skill}`));
    const suggestions = strengths
      .filter((s) => s.score >= threshold && s.evidenceCount >= 2 && !decided.has(`${s.studentId}|${s.skill}`))
      .sort((a, b) => b.score - a.score || b.evidence.length - a.evidence.length)
      .slice(0, 12)
      .map((s) => {
        const st = byStudent.get(s.studentId);
        return {
          skillId: s.id, skill: s.skill, score: s.score, confidence: s.confidence, evidence: s.evidence, evidenceCount: s.evidenceCount, assessedOn: s.assessedOn,
          studentId: s.studentId, studentName: st?.fullName ?? '', admissionNo: st?.admissionNo ?? '', grade: st?.section.class.name ?? null, section: st?.section.name ?? null,
          activities: s.activities,
        };
      });

    return {
      rule: this.talent.rule(threshold),
      threshold,
      distribution,
      suggestions,
      decisions: decisions.slice(0, 10).map((d) => {
        const st = byStudent.get(d.studentId);
        return {
          at: d.decidedAt.toISOString(), action: d.action as 'accept' | 'dismiss', by: d.decidedByName, skill: d.skill, studentId: d.studentId, studentName: st?.fullName ?? '',
          description: d.action === 'accept'
            ? `${st?.fullName ?? 'A student'} — ${d.skill}: opportunity offered (${truncate(d.note, 120)})`
            : `${st?.fullName ?? 'A student'} — ${d.skill}: suggestion dismissed (${truncate(d.note, 120)})`,
        };
      }),
      totals: { students: ids.length, withStrength: new Set(strengths.filter((s) => s.score >= threshold).map((s) => s.studentId)).size },
    };
  }

  @Get('students/:id')
  async student(@Param('id') ref: string, @CurrentUser() user: AuthUser) {
    const s = await findStudent(this.prisma, this.scope, user, ref);
    const [strengths, decisions, interests, activities] = await Promise.all([
      this.talent.strengths([s.id]),
      this.prisma.talentDecision.findMany({ where: { studentId: s.id }, orderBy: { decidedAt: 'desc' } }),
      this.extras.interests([s.id]),
      this.extras.activities([s.id]),
    ]);
    return {
      student: { id: s.id, fullName: s.fullName, admissionNo: s.admissionNo, grade: s.section.class.name, section: s.section.name },
      strengths: strengths.map((x) => {
        const d = decisions.find((y) => y.skill === x.skill);
        return {
          id: x.id, name: x.skill, score: x.score, confidence: x.confidence, evidence: x.evidence, assessedOn: x.assessedOn,
          decision: d ? { action: d.action, by: d.decidedByName, at: d.decidedAt.toISOString(), note: d.note } : null,
        };
      }),
      interests: [...new Set(interests.map((i) => i.name))],
      activities: activities.map((a) => ({ name: a.name, category: a.category, role: a.role, hours: a.hours })),
    };
  }

  @Post('suggestions/:id/decision')
  @HttpCode(200)
  @RequirePermissions('students.read', 'students.read_assigned')
  async decide(@Param('id') id: string, @Body() dto: DecisionDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    assertUuid(id, 'Suggestion');
    const s = await this.prisma.talentStrength.findUnique({ where: { id } });
    if (!s) throw notFound('Suggestion');
    await this.scope.assertStudent(user, s.studentId);
    const existing = await this.prisma.talentDecision.findFirst({ where: { studentId: s.studentId, skill: s.skill }, orderBy: { decidedAt: 'desc' } });
    if (existing) throw conflict(`A decision was already recorded by ${existing.decidedByName}`);
    const note = (dto.decision === 'accept' ? dto.opportunity : dto.reason)?.trim() ?? '';
    if (note.length < 5) throw fieldError(dto.decision === 'accept' ? 'opportunity' : 'reason', dto.decision === 'accept' ? 'Describe the opportunity offered' : 'Record why this is being dismissed');
    const student = await this.prisma.student.findUnique({ where: { id: s.studentId }, select: { fullName: true } });
    const d = await this.prisma.talentDecision.create({
      data: {
        strengthId: s.id, studentId: s.studentId, campusId: s.campusId, skill: s.skill, action: dto.decision, note, scoreAtDecision: s.score,
        decidedById: user.id, decidedByName: user.fullName,
      },
    });
    await this.audit.record({
      user, action: dto.decision === 'accept' ? 'approve' : 'reject', module: 'talent', entityType: 'talent_suggestion', entityId: s.id, campusId: s.campusId, req,
      description: dto.decision === 'accept'
        ? `Offered an opportunity to ${student?.fullName ?? 'a student'} for ${s.skill} (score ${s.score}): ${note}`
        : `Dismissed the ${s.skill} suggestion for ${student?.fullName ?? 'a student'} (score ${s.score}): ${note}`,
    });
    return ok({ id: d.id, action: d.action }, dto.decision === 'accept' ? 'Opportunity recorded' : 'Suggestion dismissed');
  }
}

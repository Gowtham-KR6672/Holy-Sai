import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { badRequest, fieldError, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TokensService } from '../auth/tokens.service';
import { NotificationsService } from '../notifications/notifications.service';
import { asDate, dayKey, schoolToday, STATUS_LABEL } from './students.util';

type Tx = Prisma.TransactionClient;

/** Account states a hold suspends (an invited account must not be activated for a student who has left). */
const HOLDABLE = ['active', 'invited'];

export interface StatusChangeResult {
  id: string;
  status: string;
  discontinuedOn: string | null;
  discontinueReason: string | null;
  accountsDisabled: number;
  accountsEnabled: number;
}

/**
 * The student lifecycle. Student records are kept permanently; a student who leaves is marked
 * discontinued / transferred / graduated with the date and reason, and:
 *  - the student's own sign-in account is disabled and signed out everywhere;
 *  - each guardian's parent account is disabled and signed out, unless that guardian still has an active child;
 *  - GPS tracking is switched off (restored on re-activation).
 * Re-activating the student re-enables exactly the accounts these holds suspended (StudentAccountHold),
 * including a parent account suspended when a sibling left earlier. Every change is audited.
 *
 * Exported for other modules (e.g. group transfers, admissions):
 *  - changeStatus(user, studentId, { status, reason, effectiveOn }, req)
 *  - liftGuardianHolds(guardianIds) — call after linking a guardian to an active student
 */
@Injectable()
export class StudentLifecycleService {
  private readonly log = new Logger('Students');

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async changeStatus(user: AuthUser, studentId: string, dto: { status: string; reason?: string; effectiveOn?: string }, req?: Request): Promise<StatusChangeResult> {
    const s = await this.prisma.student.findUnique({
      where: { id: studentId },
      include: { section: { select: { name: true, classTeacherId: true, class: { select: { name: true } } } } },
    });
    if (!s) throw notFound('Student');
    const from = s.status;
    const to = dto.status;
    if (!STATUS_LABEL[to]) throw fieldError('status', 'Choose active, discontinued, transferred or graduated');
    if (to === from) throw badRequest(`${s.fullName} is already ${STATUS_LABEL[to].toLowerCase()}`);
    const today = schoolToday();
    const effectiveOn = dto.effectiveOn?.slice(0, 10) || today;
    if (effectiveOn > today) throw fieldError('effectiveOn', 'The date cannot be in the future');
    if (s.admittedOn && to !== 'active' && effectiveOn < dayKey(s.admittedOn)) throw fieldError('effectiveOn', 'The date is before the student was admitted');
    const reason = dto.reason?.trim() || null;
    const leaving = from === 'active' && to !== 'active';
    const returning = from !== 'active' && to === 'active';
    if (leaving && to !== 'graduated' && !reason) throw fieldError('reason', `Give the reason the student is ${to === 'transferred' ? 'transferring' : 'leaving'}`);

    const lastLeave = returning
      ? await this.prisma.studentStatusChange.findFirst({ where: { studentId, fromStatus: 'active' }, orderBy: { createdAt: 'desc' } })
      : null;

    let disabled: string[] = [];
    let enabled: string[] = [];
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.student.update({
        where: { id: s.id },
        data: {
          status: to,
          discontinuedOn: to === 'active' ? null : asDate(effectiveOn),
          discontinueReason: to === 'active' ? null : (reason ?? s.discontinueReason),
          ...(leaving && s.trackingStatus !== 'disabled' ? { trackingStatus: 'disabled' } : {}),
          ...(returning && lastLeave?.trackingStatusBefore && lastLeave.trackingStatusBefore !== 'disabled' && s.trackingStatus === 'disabled'
            ? { trackingStatus: lastLeave.trackingStatusBefore }
            : {}),
        },
      });
      if (leaving) disabled = await this.suspendAccounts(tx, s.id);
      if (returning) enabled = await this.restoreAccounts(tx, s.id);
      await tx.studentStatusChange.create({
        data: {
          studentId: s.id, campusId: s.campusId, fromStatus: from, toStatus: to, effectiveOn: asDate(effectiveOn), reason,
          disabledUserIds: disabled, enabledUserIds: enabled, trackingStatusBefore: leaving ? s.trackingStatus : null,
          changedById: user.id, changedByName: user.fullName,
        },
      });
      return row;
    });

    // Sign the suspended accounts out everywhere (their next request or refresh is refused).
    for (const id of disabled) {
      try {
        await this.tokens.revokeAllForUser(id);
      } catch (err) {
        this.log.warn(`Could not revoke sessions of ${id}: ${(err as Error).message}`);
      }
    }

    const sectionLabel = s.section ? `${s.section.class.name}${s.section.name}` : '';
    const accounts = [
      disabled.length ? `${disabled.length} sign-in account${disabled.length === 1 ? '' : 's'} disabled` : null,
      enabled.length ? `${enabled.length} sign-in account${enabled.length === 1 ? '' : 's'} re-enabled` : null,
    ].filter(Boolean).join('; ');
    await this.audit.record({
      user, req, action: 'update', module: 'students', entityType: 'student', entityId: s.id, campusId: s.campusId,
      description: `${s.fullName} (${s.admissionNo}): ${STATUS_LABEL[from] ?? from} → ${STATUS_LABEL[to]} from ${effectiveOn}${reason ? ` · ${reason}` : ''}${accounts ? ` · ${accounts}` : ''}`,
      metadata: { from, to, effectiveOn, reason, disabledUserIds: disabled, enabledUserIds: enabled },
    });

    // Tell the class teacher their roll changed.
    if (s.section?.classTeacherId) {
      const teacher = await this.prisma.user.findFirst({ where: { employeeId: s.section.classTeacherId, status: 'active' }, select: { id: true } });
      if (teacher && teacher.id !== user.id) {
        await this.notifications.notifyUsers([teacher.id], {
          category: 'Information', topic: 'system', module: 'students', icon: returning ? 'userCheck' : 'user', campusId: s.campusId,
          title: returning ? `${s.fullName} is back on the ${sectionLabel} roll` : `${s.fullName} has left ${sectionLabel} (${STATUS_LABEL[to].toLowerCase()})`,
          body: `${s.admissionNo}${reason ? ` · ${reason}` : ''}`,
          route: `/student-360/${s.id}`,
        });
      }
    }

    return {
      id: updated.id,
      status: updated.status,
      discontinuedOn: updated.discontinuedOn ? dayKey(updated.discontinuedOn) : null,
      discontinueReason: updated.discontinueReason,
      accountsDisabled: disabled.length,
      accountsEnabled: enabled.length,
    };
  }

  /** Re-enables parent accounts that were suspended when their children left, once a guardian has an active child again. */
  async liftGuardianHolds(guardianIds: string[]): Promise<string[]> {
    const ids = [...new Set(guardianIds)].filter(Boolean);
    if (!ids.length) return [];
    const active = await this.prisma.studentGuardian.findMany({ where: { guardianId: { in: ids }, student: { status: 'active' } }, select: { guardianId: true } });
    const withChild = [...new Set(active.map((a) => a.guardianId))];
    if (!withChild.length) return [];
    return this.prisma.$transaction(async (tx) => {
      const users = await tx.user.findMany({ where: { parentId: { in: withChild } }, select: { id: true, status: true } });
      return this.lift(tx, users);
    });
  }

  // -------------------------------------------------------------------------

  private async suspendAccounts(tx: Tx, studentId: string): Promise<string[]> {
    const out: string[] = [];
    const hold = async (users: { id: string; status: string }[], kind: 'student' | 'parent') => {
      for (const u of users) {
        await tx.user.update({ where: { id: u.id }, data: { status: 'disabled' } });
        await tx.studentAccountHold.upsert({
          where: { userId: u.id },
          create: { userId: u.id, kind, studentId, previousStatus: u.status },
          update: { kind, studentId, previousStatus: u.status },
        });
        out.push(u.id);
      }
    };
    await hold(await tx.user.findMany({ where: { studentId, status: { in: HOLDABLE } }, select: { id: true, status: true } }), 'student');

    const links = await tx.studentGuardian.findMany({ where: { studentId }, select: { guardianId: true } });
    for (const { guardianId } of links) {
      const stillActive = await tx.studentGuardian.count({ where: { guardianId, studentId: { not: studentId }, student: { status: 'active' } } });
      if (stillActive) continue;
      await hold(await tx.user.findMany({ where: { parentId: guardianId, status: { in: HOLDABLE } }, select: { id: true, status: true } }), 'parent');
    }
    return out;
  }

  private async restoreAccounts(tx: Tx, studentId: string): Promise<string[]> {
    const links = await tx.studentGuardian.findMany({ where: { studentId }, select: { guardianId: true } });
    const users = await tx.user.findMany({
      where: { OR: [{ studentId }, ...(links.length ? [{ parentId: { in: links.map((l) => l.guardianId) } }] : [])] },
      select: { id: true, status: true },
    });
    return this.lift(tx, users);
  }

  /** Lifts the holds on these accounts: an account still disabled goes back to the state it had. */
  private async lift(tx: Tx, users: { id: string; status: string }[]): Promise<string[]> {
    if (!users.length) return [];
    const holds = await tx.studentAccountHold.findMany({ where: { userId: { in: users.map((u) => u.id) } } });
    const out: string[] = [];
    for (const h of holds) {
      const u = users.find((x) => x.id === h.userId);
      if (u?.status === 'disabled') {
        await tx.user.update({
          where: { id: u.id },
          data: { status: HOLDABLE.includes(h.previousStatus) ? h.previousStatus : 'active', failedLogins: 0, lockedUntil: null },
        });
        out.push(u.id);
      }
      await tx.studentAccountHold.delete({ where: { userId: h.userId } });
    }
    return out;
  }
}

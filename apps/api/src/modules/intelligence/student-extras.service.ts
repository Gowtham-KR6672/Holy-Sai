import { Injectable, Logger } from '@nestjs/common';
import type { AuthUser } from '../../common/auth-user';
import { PrismaService } from '../../common/prisma.service';
import { asDate, dayKey, schoolToday } from './intel.util';

/**
 * Student 360 records the intelligence module reads or derives:
 *  - behaviour notes, wellbeing check-ins and teacher observations (students module tables), read
 *    defensively so a database without those tables yet still answers with empty lists;
 *  - activities and interests, which this module owns and derives from real records: Innovation Lab
 *    project membership (activities), idea categories and achievement types (interests).
 */

export interface BehaviourRow { studentId: string; date: string | null; type: string; note: string; by: string | null }
export interface ObservationRow { studentId: string; date: string | null; text: string; by: string; role: string | null }
export interface ActivityRow { studentId: string; name: string; category: string; role: string; since: string | null; hours: number; status: string }
export interface InterestRow { studentId: string; name: string }
export interface WellbeingRow { studentId: string; date: string | null; mood: string }

const INTEREST_BY_TYPE: Record<string, string> = { Sports: 'Sports', 'Co-curricular': 'Arts and culture', Service: 'Community service', Innovation: 'Innovation', Competition: 'Competitions' };

@Injectable()
export class StudentExtrasService {
  private readonly log = new Logger(StudentExtrasService.name);
  private warned = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  private async guarded<T>(what: string, fn: () => Promise<T[]>): Promise<T[]> {
    try {
      return await fn();
    } catch (err) {
      if (!this.warned.has(what)) {
        this.warned.add(what);
        this.log.warn(`${what} unavailable: ${(err as Error).message.split('\n')[0]}`);
      }
      return [];
    }
  }

  async behaviour(studentIds: string[]): Promise<BehaviourRow[]> {
    if (!studentIds.length) return [];
    const rows = await this.guarded('Behaviour notes', () =>
      this.prisma.studentBehaviourNote.findMany({ where: { studentId: { in: studentIds } }, orderBy: [{ recordedOn: 'desc' }, { createdAt: 'desc' }] }),
    );
    return rows.map((r) => ({ studentId: r.studentId, date: dayKey(r.recordedOn), type: r.recordType, note: r.note, by: r.recordedByName }));
  }

  async observations(studentIds: string[]): Promise<ObservationRow[]> {
    if (!studentIds.length) return [];
    const rows = await this.guarded('Teacher observations', () =>
      this.prisma.studentObservation.findMany({ where: { studentId: { in: studentIds } }, orderBy: [{ observedOn: 'desc' }, { createdAt: 'desc' }], take: 200 }),
    );
    return rows.map((r) => ({ studentId: r.studentId, date: dayKey(r.observedOn), text: r.text, by: r.authorName, role: r.authorRole }));
  }

  /** Wellbeing moods only (never notes); confidential check-ins count but are not shown. */
  async wellbeing(studentIds: string[]): Promise<WellbeingRow[]> {
    if (!studentIds.length) return [];
    const rows = await this.guarded('Wellbeing check-ins', () =>
      this.prisma.studentWellbeingCheckin.findMany({ where: { studentId: { in: studentIds } }, select: { studentId: true, checkedOn: true, mood: true } }),
    );
    return rows.map((r) => ({ studentId: r.studentId, date: dayKey(r.checkedOn), mood: r.mood }));
  }

  /** Saves a reviewing teacher's context as a Student 360 observation (when the table exists). */
  async addObservation(user: AuthUser, studentId: string, campusId: string, text: string): Promise<boolean> {
    try {
      const emp = user.employeeId ? await this.prisma.employee.findUnique({ where: { id: user.employeeId }, select: { designation: true } }) : null;
      await this.prisma.studentObservation.create({
        data: {
          studentId, campusId, text, observedOn: asDate(schoolToday()),
          authorId: user.id, authorEmployeeId: user.employeeId, authorName: user.fullName, authorRole: emp?.designation ?? user.roleName,
        },
      });
      return true;
    } catch (err) {
      this.log.warn(`Observation not saved to Student 360: ${(err as Error).message.split('\n')[0]}`);
      return false;
    }
  }

  /** Activities: Innovation Lab projects the student leads or works on. */
  async activities(studentIds: string[]): Promise<ActivityRow[]> {
    if (!studentIds.length) return [];
    const [members, led] = await Promise.all([
      this.prisma.innovationProjectMember.findMany({ where: { studentId: { in: studentIds } }, select: { studentId: true, role: true, projectId: true } }),
      this.prisma.innovationProject.findMany({ where: { studentId: { in: studentIds } }, select: { id: true, studentId: true } }),
    ]);
    const links = new Map<string, { studentId: string; projectId: string; role: string }>();
    for (const m of members) links.set(`${m.studentId}|${m.projectId}`, m);
    for (const p of led) links.set(`${p.studentId}|${p.id}`, { studentId: p.studentId, projectId: p.id, role: 'Lead' });
    if (!links.size) return [];
    const projects = new Map(
      (await this.prisma.innovationProject.findMany({
        where: { id: { in: [...new Set([...links.values()].map((l) => l.projectId))] } },
        select: { id: true, code: true, title: true, status: true, startedOn: true, createdAt: true, completedOn: true },
      })).map((p) => [p.id, p]),
    );
    const out: ActivityRow[] = [];
    for (const l of links.values()) {
      const p = projects.get(l.projectId);
      if (!p) continue;
      out.push({
        studentId: l.studentId, name: `Innovation Lab — ${p.title}`, category: 'Innovation', role: l.role, since: dayKey(p.startedOn ?? p.createdAt), hours: 0,
        status: p.status === 'Completed' ? 'Completed' : 'Active',
      });
    }
    return out;
  }

  /** Interests shown by what the student chose to do: idea categories and achievement areas. */
  async interests(studentIds: string[]): Promise<InterestRow[]> {
    if (!studentIds.length) return [];
    const [ideas, achievements] = await Promise.all([
      this.prisma.innovationIdea.findMany({ where: { studentId: { in: studentIds }, category: { not: null } }, select: { studentId: true, category: true } }),
      this.prisma.innovationAchievement.findMany({ where: { studentId: { in: studentIds } }, select: { studentId: true, type: true } }),
    ]);
    const seen = new Set<string>();
    const out: InterestRow[] = [];
    const add = (studentId: string, name: string | null | undefined) => {
      if (!name || name === 'Other') return;
      const k = `${studentId}|${name}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ studentId, name });
    };
    for (const i of ideas) add(i.studentId, i.category);
    for (const a of achievements) add(a.studentId, INTEREST_BY_TYPE[a.type]);
    return out;
  }
}

/** Behaviour note types that are not concerns. */
export const isPositive = (type: string) => /positive|praise|merit|commend|achievement|good/i.test(type);
/** Behaviour note types that are concerns (the students module records Concern and Incident). */
export const isConcern = (type: string) => /concern|incident/i.test(type);
/** Wellbeing moods that call for a conversation. */
export const isConcernMood = (mood: string) => /low|anxious|unsettled|sad|worried|withdrawn|upset|distress/i.test(mood);

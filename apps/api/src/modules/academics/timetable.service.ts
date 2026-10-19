import { Injectable } from '@nestjs/common';
import type { TimetableEntry, TimetablePeriod } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { AcademicsAccess } from './academics.access';
import { asDate, DAY_NAMES, dayKey, nextDateForDay, schoolToday } from './academics.util';

/**
 * Standard bell schedule, created for a campus the first time its timetable is opened
 * (the screens have no bell-time editor). Eight 40-minute periods after an 08:45 registration.
 */
export const DEFAULT_PERIODS: [string, string][] = [
  ['08:50', '09:30'], ['09:30', '10:10'], ['10:10', '10:50'], ['11:05', '11:45'],
  ['11:45', '12:25'], ['13:05', '13:45'], ['13:45', '14:25'], ['14:25', '15:05'],
];

export interface EntryDto {
  id: string; sectionId: string; sectionLabel: string; day: number; periodNo: number; startsAt: string; endsAt: string;
  subjectId: string | null; subject: string | null; activity: string | null; employeeId: string | null; teacher: string | null;
  substituteId: string | null; substitute: string | null; room: string | null; needsSubstitute: boolean;
}

@Injectable()
export class TimetableService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AcademicsAccess,
  ) {}

  /** The campus bell schedule, created with the standard periods when the campus has none. */
  async periods(campusId: string): Promise<TimetablePeriod[]> {
    let rows = await this.prisma.timetablePeriod.findMany({ where: { campusId }, orderBy: { periodNo: 'asc' } });
    if (!rows.length) {
      await this.prisma.timetablePeriod.createMany({
        data: DEFAULT_PERIODS.map(([startsAt, endsAt], i) => ({ campusId, periodNo: i + 1, startsAt, endsAt })),
        skipDuplicates: true,
      });
      rows = await this.prisma.timetablePeriod.findMany({ where: { campusId }, orderBy: { periodNo: 'asc' } });
    }
    return rows;
  }

  /** Creates the empty Monday–Saturday slots of a section so the academic office can fill them in. */
  async ensureSlots(sectionId: string, campusId: string, periods: TimetablePeriod[]) {
    const have = await this.prisma.timetableEntry.count({ where: { sectionId } });
    if (have >= periods.length * DAY_NAMES.length) return;
    await this.prisma.timetableEntry.createMany({
      data: DAY_NAMES.flatMap((_, d) => periods.map((p) => ({ sectionId, campusId, day: d + 1, periodNo: p.periodNo }))),
      skipDuplicates: true,
    });
  }

  /** Covers apply to one date; once it has passed the period goes back to its own teacher. */
  async expireCovers() {
    await this.prisma.timetableEntry.updateMany({
      where: { coverDate: { lt: asDate(schoolToday()) } },
      data: { substituteId: null, substituteNote: null, coverDate: null, coverAssignedById: null, needsSubstitute: false },
    });
  }

  /** Sections an employee teaches or covers (registered with ScopeService for teacher scope). */
  async teacherSections(employeeId: string): Promise<string[]> {
    const rows = await this.prisma.timetableEntry.findMany({
      where: { OR: [{ employeeId }, { substituteId: employeeId }] },
      select: { sectionId: true },
      distinct: ['sectionId'],
    });
    return rows.map((r) => r.sectionId);
  }

  /**
   * Staff who are away on a date, from Workforce leave and staff attendance when that module is present.
   * Read defensively so the timetable keeps working on its own.
   */
  async unavailable(employeeIds: string[], date: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const ids = [...new Set(employeeIds.filter(Boolean))];
    if (!ids.length) return out;
    const d = asDate(date);
    const client = this.prisma as unknown as Record<string, { findMany?: (args: unknown) => Promise<Record<string, unknown>[]> } | undefined>;
    try {
      const leave = await client.workforceLeaveRequest?.findMany?.({
        where: { employeeId: { in: ids }, status: 'Approved', fromDate: { lte: d }, toDate: { gte: d } },
        select: { employeeId: true },
      });
      for (const l of leave ?? []) out.set(String(l.employeeId), 'On leave');
    } catch {
      /* Workforce tables not available */
    }
    try {
      const att = await client.workforceAttendance?.findMany?.({
        where: { employeeId: { in: ids }, date: d, status: { in: ['Absent', 'On Leave'] } },
        select: { employeeId: true, status: true },
      });
      for (const a of att ?? []) if (!out.has(String(a.employeeId))) out.set(String(a.employeeId), a.status === 'Absent' ? 'Absent' : 'On leave');
    } catch {
      /* Workforce tables not available */
    }
    return out;
  }

  /** Builds the entries the page reads, flagging periods whose teacher is away on the next occurrence. */
  async toDtos(entries: TimetableEntry[], periodsByCampus: Map<string, TimetablePeriod[]>) {
    const today = schoolToday();
    const [sections, subjects, staff] = await Promise.all([
      this.access.sectionInfo(entries.map((e) => e.sectionId)),
      this.access.subjectNames(entries.map((e) => e.subjectId)),
      this.access.employeeNames(entries.flatMap((e) => [e.employeeId, e.substituteId])),
    ]);
    // Away checks per upcoming date (one query pair per weekday at most).
    const byDate = new Map<string, string[]>();
    for (const e of entries) {
      if (!e.employeeId || e.substituteId) continue;
      const date = nextDateForDay(today, e.day);
      byDate.set(date, [...(byDate.get(date) ?? []), e.employeeId]);
    }
    const away = new Map<string, Map<string, string>>();
    for (const [date, ids] of byDate) away.set(date, await this.unavailable(ids, date));

    const dtos: (EntryDto & { teacherStatus: string | null; date: string })[] = entries.map((e) => {
      const p = periodsByCampus.get(e.campusId)?.find((x) => x.periodNo === e.periodNo);
      const date = e.coverDate ? dayKey(e.coverDate) : nextDateForDay(today, e.day);
      const status = e.employeeId && !e.substituteId ? away.get(date)?.get(e.employeeId) ?? null : null;
      return {
        id: e.id,
        sectionId: e.sectionId,
        sectionLabel: sections.get(e.sectionId)?.label ?? '',
        day: e.day,
        periodNo: e.periodNo,
        startsAt: p?.startsAt ?? '',
        endsAt: p?.endsAt ?? '',
        subjectId: e.subjectId,
        subject: e.subjectId ? subjects.get(e.subjectId) ?? null : null,
        activity: e.activity,
        employeeId: e.employeeId,
        teacher: e.employeeId ? staff.get(e.employeeId) ?? null : null,
        substituteId: e.substituteId,
        substitute: e.substituteId ? staff.get(e.substituteId) ?? null : null,
        room: e.room,
        needsSubstitute: e.needsSubstitute || !!status,
        teacherStatus: status,
        date,
      };
    });
    return dtos;
  }
}

/** An entry is a lesson when it has a subject or an activity (blank slots are free periods). */
export const isLesson = (e: { subjectId: string | null; activity: string | null }) => !!e.subjectId || !!e.activity;

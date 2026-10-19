import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { andCampus, istStart, sqlDate, sqlTs } from './insights.util';

export interface EarlyWarningFigures {
  open: number;
  awaitingReview: number;
  inIntervention: number;
  closedThisTerm: number;
  overdueReviews: number;
}

export interface BehaviourFigures {
  concerns: number;
  positives: number;
  notes: number;
}

const NO_EW: EarlyWarningFigures = { open: 0, awaitingReview: 0, inIntervention: 0, closedThisTerm: 0, overdueReviews: 0 };
const NO_BEHAVIOUR: BehaviourFigures = { concerns: 0, positives: 0, notes: 0 };

/**
 * Reads of tables owned by modules that are built and migrated separately (Early Warning signals in
 * intelligence, behaviour notes in students). Each read is a raw aggregate that tolerates a missing
 * table or column and then reports zeros, so the dashboards never fail because of another module.
 */
@Injectable()
export class GuardedReadsService {
  private readonly log = new Logger('Insights');
  private readonly exists = new Map<string, { at: number; ok: boolean }>();

  constructor(private readonly prisma: PrismaService) {}

  /** Whether a table exists, remembered for a minute. */
  async has(table: string): Promise<boolean> {
    const hit = this.exists.get(table);
    if (hit && Date.now() - hit.at < 60_000) return hit.ok;
    let ok = false;
    try {
      const r = await this.prisma.$queryRaw<{ t: string | null }[]>(Prisma.sql`SELECT to_regclass(${`"${table}"`}::text)::text AS t`);
      ok = !!r[0]?.t;
    } catch {
      ok = false;
    }
    this.exists.set(table, { at: Date.now(), ok });
    return ok;
  }

  /**
   * Early Warning signals (intelligence module): open (not closed, not dismissed), awaiting a teacher decision,
   * accepted and in intervention, closed since the term began, and reviews past their next-review date.
   */
  async earlyWarning(campusId: string | undefined, termStart: string, today: string): Promise<EarlyWarningFigures> {
    if (!(await this.has('EarlyWarningSignal'))) return NO_EW;
    try {
      const rows = await this.prisma.$queryRaw<EarlyWarningFigures[]>(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE s."closedAt" IS NULL AND s.stage < 5 AND COALESCE(s.decision, '') <> 'dismissed')::int AS "open",
          COUNT(*) FILTER (WHERE s."closedAt" IS NULL AND s.stage < 5 AND s.decision IS NULL)::int AS "awaitingReview",
          COUNT(*) FILTER (WHERE s."closedAt" IS NULL AND s.stage < 5 AND s.decision = 'accepted')::int AS "inIntervention",
          COUNT(*) FILTER (WHERE s."closedAt" >= ${sqlTs(istStart(termStart))})::int AS "closedThisTerm",
          COUNT(*) FILTER (WHERE s."closedAt" IS NULL AND s.stage < 5 AND s.decision = 'accepted' AND s."nextReviewOn" < ${sqlDate(today)})::int AS "overdueReviews"
        FROM "EarlyWarningSignal" s
        JOIN "Student" st ON st.id = s."studentId"
        WHERE st.status = 'active' ${andCampus('s."campusId"', campusId)}`);
      return rows[0] ?? NO_EW;
    } catch (err) {
      this.log.warn(`Early Warning figures unavailable: ${(err as Error).message}`);
      return NO_EW;
    }
  }

  /** Behaviour notes (students module) recorded since a date: concerns (and incidents), positives, plain notes. */
  async behaviour(campusId: string | undefined, since: string): Promise<BehaviourFigures> {
    if (!(await this.has('StudentBehaviourNote'))) return NO_BEHAVIOUR;
    try {
      const rows = await this.prisma.$queryRaw<BehaviourFigures[]>(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE b."recordType" IN ('Concern', 'Incident'))::int AS concerns,
          COUNT(*) FILTER (WHERE b."recordType" = 'Positive')::int AS positives,
          COUNT(*) FILTER (WHERE b."recordType" = 'Note')::int AS notes
        FROM "StudentBehaviourNote" b
        WHERE b."recordedOn" >= ${sqlDate(since)} ${andCampus('b."campusId"', campusId)}`);
      return rows[0] ?? NO_BEHAVIOUR;
    } catch (err) {
      this.log.warn(`Behaviour figures unavailable: ${(err as Error).message}`);
      return NO_BEHAVIOUR;
    }
  }
}

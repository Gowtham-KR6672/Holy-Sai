import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { ExamCorrectionJob, Prisma } from '@prisma/client';
import { AppError, conflict } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { PerWorkspace } from '../../tenancy/context';
import { TenancyService } from '../../tenancy/tenancy.service';
import { PlatformDb } from '../../tenancy/platform-db.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EcAccess } from './ec.access';
import { EcPages, PermanentError } from './ec.pages.service';
import { EcPipeline } from './ec.pipeline.service';
import { BUSY } from './ec.views.service';

/** Sheets processed at the same time by this API instance (EXAM_CORRECTION_CONCURRENCY, default 2). */
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.EXAM_CORRECTION_CONCURRENCY ?? 2) || 2));
const TICK_MS = 4000;
/** A running job whose worker has not written for this long is treated as interrupted and queued again. */
const STALE_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;

/**
 * Background processing of answer sheets. Jobs are rows in ExamCorrectionJob, so they survive restarts;
 * a worker loop claims queued jobs (bounded concurrency), retries temporary failures with back-off, and
 * keeps each sheet's status current for the pages, which poll while a job is busy.
 */
@Injectable()
export class EcQueue implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger('PaperCorrection');
  private running = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private warnedMissing = false;
  /** Each school's queue is pumped and swept on its own; CONCURRENCY is shared by all schools on this instance. */
  private readonly school = new PerWorkspace(() => ({ pumping: false, lastSweep: 0 }));

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: EcAccess,
    private readonly pipeline: EcPipeline,
    private readonly notifications: NotificationsService,
    private readonly pages: EcPages,
    private readonly tenancy: TenancyService,
    private readonly platform: PlatformDb,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  /** Every tick each school with queued or running sheets gets a turn, one school after another. */
  private async tick() {
    if (this.stopping) return;
    const busy = await this.schoolsWithWork().catch(() => null);
    if (busy && !busy.length) return;
    await this.tenancy.forEachWorkspace('paper-correction-queue', () => this.pump(), 1, busy ?? undefined);
  }

  /** The schools that have answer sheets waiting or being processed — one query across all school schemas. */
  private async schoolsWithWork() {
    const schools = await this.tenancy.workspaces();
    if (!schools.length) return [];
    const parts = schools
      .filter((w) => /^ws_[a-z0-9_]{2,40}$/.test(w.schema))
      .map((w) => `SELECT '${w.code}' AS code WHERE EXISTS (SELECT 1 FROM "${w.schema}"."ExamCorrectionJob" WHERE status IN ('queued', 'running'))`);
    const rows = await this.platform.$queryRawUnsafe<{ code: string }[]>(parts.join(' UNION ALL '));
    const codes = new Set(rows.map((r) => r.code));
    return schools.filter((w) => codes.has(w.code));
  }

  /** Jobs whose worker stopped (API restarted or crashed) are queued again. Running workers send a heartbeat. */
  private async sweep() {
    const school = this.school.get();
    if (Date.now() - school.lastSweep < 60_000) return;
    school.lastSweep = Date.now();
    const n = await this.prisma.examCorrectionJob.updateMany({
      where: { status: 'running', updatedAt: { lt: new Date(Date.now() - STALE_MS) } },
      data: { status: 'queued', progress: 'Resuming after an interruption' },
    });
    if (n.count) this.log.log(`Resuming ${n.count} interrupted answer-sheet job(s)`);
  }

  onApplicationShutdown() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** Queues a job for a sheet (one active job per sheet). */
  async enqueue(submissionId: string, kind: 'Reading' | 'Marking', o: { evaluateAfter?: boolean; force?: boolean; answerIds?: string[]; by: { id: string; fullName: string } }): Promise<ExamCorrectionJob> {
    const busy = await this.prisma.examCorrectionJob.findFirst({ where: { submissionId, status: { in: BUSY } } });
    if (busy) throw conflict(`This answer sheet is already being ${busy.kind === 'Marking' ? 'marked' : 'read'}. Wait for it to finish.`);
    const cfg = await this.access.config();
    const job = await this.prisma.examCorrectionJob.create({
      data: {
        submissionId, kind, evaluateAfter: o.evaluateAfter ?? true, force: o.force ?? false,
        answerIds: o.answerIds?.length ? o.answerIds : undefined, maxAttempts: Math.max(0, cfg.maxRetries) + 1,
        progress: 'Waiting in the queue', createdById: o.by.id, createdByName: o.by.fullName,
      },
    });
    await this.pipeline.refresh(submissionId);
    setImmediate(() => void this.pump());
    return job;
  }

  /** Claims queued jobs of the current school while this instance has capacity. */
  private async pump() {
    const school = this.school.get();
    if (this.stopping || school.pumping) return;
    school.pumping = true;
    try {
      await this.sweep();
      while (this.running < CONCURRENCY && !this.stopping) {
        const next = await this.prisma.examCorrectionJob.findFirst({ where: { status: 'queued', runAfter: { lte: new Date() } }, orderBy: { createdAt: 'asc' } });
        if (!next) break;
        const claimed = await this.prisma.examCorrectionJob.updateMany({
          where: { id: next.id, status: 'queued' },
          data: { status: 'running', startedAt: new Date(), attempts: { increment: 1 }, error: null, progress: 'Starting' },
        });
        if (!claimed.count) continue;
        this.running++;
        void this.run({ ...next, attempts: next.attempts + 1 }).finally(() => {
          this.running--;
          setImmediate(() => void this.pump());
        });
      }
    } catch (err) {
      this.missingTables(err);
    } finally {
      school.pumping = false;
    }
  }

  private async run(job: ExamCorrectionJob) {
    let last = 'Starting';
    const progress = async (text: string) => {
      last = text.slice(0, 200);
      await this.prisma.examCorrectionJob.update({ where: { id: job.id }, data: { progress: last } }).catch(() => undefined);
    };
    // Heartbeat while long AI calls run, so other instances do not take the job over.
    const beat = setInterval(() => void this.prisma.examCorrectionJob.updateMany({ where: { id: job.id, status: 'running' }, data: { progress: last } }).catch(() => undefined), HEARTBEAT_MS);
    beat.unref?.();
    try {
      await this.pipeline.refresh(job.submissionId);
      if (job.kind === 'Reading') {
        await this.pipeline.read(job, progress);
        if (job.evaluateAfter) {
          const state = await this.access.aiState();
          if (state.status.marking_available) {
            await this.prisma.examCorrectionJob.update({ where: { id: job.id }, data: { kind: 'Marking', progress: 'Marking the answers' } });
            await this.pipeline.refresh(job.submissionId);
            await this.pipeline.mark({ ...job, kind: 'Marking', force: false }, progress);
          }
        }
      } else {
        await this.pipeline.mark(job, progress);
      }
      await this.prisma.examCorrectionJob.update({ where: { id: job.id }, data: { status: 'done', progress: 'Finished', finishedAt: new Date() } });
    } catch (err) {
      await this.failed(job, err);
    } finally {
      clearInterval(beat);
      await this.pipeline.refresh(job.submissionId).catch((e) => this.log.warn(`Status refresh failed: ${(e as Error).message}`));
    }
  }

  private async failed(job: ExamCorrectionJob, err: unknown) {
    const message = ((err as Error)?.message ?? String(err)).slice(0, 500);
    // Client errors from the provider (bad key, unknown model, request too large) do not get better by retrying.
    const providerRefused = /did not answer: 4(0[0-7]|09|1\d|2[0-8])(?!\d)/.test(message);
    const truncated = err instanceof AppError && err.code === 'AI_TRUNCATED';
    const permanent = providerRefused || truncated || err instanceof PermanentError || (err instanceof AppError && [400, 403, 404, 409, 413, 503].includes(err.getStatus()));
    const current = await this.prisma.examCorrectionJob.findUnique({ where: { id: job.id } });
    if (!current) return;
    if (!permanent && job.attempts < job.maxAttempts) {
      const wait = 30_000 * job.attempts;
      await this.prisma.examCorrectionJob.update({
        where: { id: job.id },
        data: { status: 'queued', runAfter: new Date(Date.now() + wait), progress: `Retrying in ${wait / 1000} s (attempt ${job.attempts + 1} of ${job.maxAttempts}): ${message}`.slice(0, 200), error: null },
      });
      return;
    }
    await this.prisma.examCorrectionJob.update({ where: { id: job.id }, data: { status: 'failed', error: message, finishedAt: new Date() } });
    this.log.warn(`Answer sheet ${job.submissionId}: ${current.kind} failed — ${message}`);
    if (job.createdById) {
      const sub = await this.prisma.examCorrectionSubmission.findUnique({ where: { id: job.submissionId }, select: { studentId: true, exam: { select: { name: true } } } });
      const student = sub ? await this.prisma.student.findUnique({ where: { id: sub.studentId }, select: { fullName: true } }) : null;
      await this.notifications.notifyUsers([job.createdById], {
        category: 'Attention', module: 'exam-correction', topic: 'system', icon: 'scan',
        title: `Could not ${current.kind === 'Marking' ? 'mark' : 'read'} ${student?.fullName ?? 'an'} answer sheet`,
        body: `${sub?.exam.name ?? 'Paper Correction'}: ${message}`,
        route: `/paper-correction/sheets/${job.submissionId}`,
      }).catch(() => undefined);
    }
  }

  /** Before the module's migration is applied the tables are missing; say so once instead of every tick. */
  private missingTables(err: unknown) {
    const code = (err as Prisma.PrismaClientKnownRequestError)?.code;
    if (code === 'P2021' || code === 'P2022') {
      if (!this.warnedMissing) this.log.warn('Paper Correction tables are not in the database yet — apply the migration to start processing.');
      this.warnedMissing = true;
      return;
    }
    this.log.error(`Paper Correction queue: ${(err as Error)?.message ?? err}`);
  }

  /** Removes a sheet and its stored files (used when a sheet is replaced). */
  async removeSheet(submissionId: string) {
    const pages = await this.prisma.examCorrectionPage.findMany({ where: { submissionId }, select: { sourceKey: true, imageKey: true } });
    await this.prisma.examCorrectionSubmission.delete({ where: { id: submissionId } });
    await this.pages.removeFiles(pages);
  }
}

import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, ReportCardBatch } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { badRequest, fieldError, forbidden, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { AiService } from '../ai/ai.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AcademicsAccess, type SectionInfo } from './academics.access';
import { asDate, dayKey, gradeFor, iso, loadTerms, mean, schoolToday, termOf, type Term } from './academics.util';

export const RC_STAGES = ['Marks', 'Moderation', 'AI draft comments', 'Teacher review', 'Approval', 'Parent release'];
const RC_STATUS = ['Marks entry', 'In moderation', 'Drafting comments', 'Teacher review', 'Awaiting approval', 'Released to parents'];

interface StudentResults {
  results: { subject: string; score: number; grade: string | null; target: number | null; trend: number; teacher: string | null }[];
  assessments: number;
}

/** Report cards: Marks → Moderation → AI draft comments → Teacher review → Approval → Parent release. */
@Injectable()
export class ReportCardsService {
  private readonly log = new Logger(ReportCardsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AcademicsAccess,
    private readonly ai: AiService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Creates this term's batch for every section in scope that has students. */
  private async ensureBatches(sections: SectionInfo[], term: Term) {
    if (!sections.length) return;
    const counts = await this.access.studentCounts(sections.map((s) => s.id));
    const data = sections
      .filter((s) => (counts.get(s.id) ?? 0) > 0)
      .map((s) => ({ sectionId: s.id, campusId: s.campusId, term: term.label, termStart: asDate(term.start), termEnd: asDate(term.end), due: asDate(term.end) }));
    if (data.length) await this.prisma.reportCardBatch.createMany({ data, skipDuplicates: true });
  }

  async overview(user: AuthUser, campusId?: string) {
    const terms = await loadTerms(this.prisma);
    const term = termOf(terms, schoolToday());
    const sections = await this.access.sections(user, campusId);
    if (term) await this.ensureBatches(sections, term);
    // This academic year's terms (the current term's year suffix).
    const yearSuffix = term?.label.replace(/^Term \d+ /, '');
    const labels = terms.filter((t) => t.label.endsWith(` ${yearSuffix}`)).map((t) => t.label);
    const batches = await this.prisma.reportCardBatch.findMany({
      where: { sectionId: { in: sections.map((s) => s.id) }, ...(labels.length ? { term: { in: labels } } : {}) },
      include: { comments: { select: { status: true } } },
      orderBy: [{ termStart: 'desc' }],
    });
    const bySection = new Map(sections.map((s, i) => [s.id, { s, i }]));
    const counts = await this.access.studentCounts(batches.map((b) => b.sectionId));
    const rows = batches
      .sort((a, b) => b.termStart.getTime() - a.termStart.getTime() || (bySection.get(a.sectionId)?.i ?? 0) - (bySection.get(b.sectionId)?.i ?? 0))
      .map((b) => ({
        id: b.id,
        sectionId: b.sectionId,
        grade: bySection.get(b.sectionId)?.s.label ?? '',
        term: b.term,
        stage: b.stage,
        status: RC_STATUS[b.stage] ?? '',
        due: dayKey(b.due),
        releasedAt: iso(b.releasedAt),
        approvedBy: b.approvedByName,
        students: counts.get(b.sectionId) ?? 0,
        drafts: b.comments.filter((c) => c.status === 'Draft').length,
        approved: b.comments.filter((c) => c.status === 'Approved').length,
        rejected: b.comments.filter((c) => c.status === 'Rejected').length,
      }));
    return {
      stages: RC_STAGES,
      stageCounts: RC_STAGES.map((label, i) => ({ label, count: rows.filter((r) => r.stage === i).length })),
      rows,
      awaitingRelease: rows.filter((r) => r.stage === 4).length,
    };
  }

  private async load(user: AuthUser, id: string) {
    const b = await this.prisma.reportCardBatch.findUnique({ where: { id } });
    if (!b) throw notFound('Report card batch');
    if (!(await this.access.canSeeSection(user, b.sectionId, b.campusId))) throw forbidden('This class is outside your access');
    const section = (await this.access.sectionInfo([b.sectionId])).get(b.sectionId)!;
    return { b, section };
  }

  private students(sectionId: string) {
    return this.prisma.student.findMany({
      where: { sectionId, status: 'active' },
      orderBy: [{ rollNo: 'asc' }, { fullName: 'asc' }],
      select: { id: true, admissionNo: true, fullName: true, firstName: true, rollNo: true, attendancePct: true },
    });
  }

  /** Subject averages for a student in the batch's term, against the previous term. */
  private async results(b: ReportCardBatch, section: SectionInfo, studentId: string): Promise<StudentResults> {
    const terms = await loadTerms(this.prisma);
    const idx = terms.findIndex((t) => t.label === b.term);
    const prev = idx > 0 ? terms[idx - 1] : null;
    const from = prev ? asDate(prev.start) : b.termStart;
    const marks = await this.prisma.assessmentMark.findMany({
      where: { studentId, isAbsent: false, marks: { not: null }, assessment: { heldOn: { gte: from, lte: b.termEnd } } },
      select: { marks: true, assessment: { select: { subjectId: true, maxMarks: true, heldOn: true } } },
    });
    const subjects = await this.access.subjectNames(marks.map((m) => m.assessment.subjectId));
    const entries = await this.prisma.timetableEntry.findMany({ where: { sectionId: section.id, subjectId: { in: [...subjects.keys()] }, employeeId: { not: null } }, select: { subjectId: true, employeeId: true } });
    const teachers = await this.access.employeeNames(entries.map((e) => e.employeeId));
    const bySubject = new Map<string, { cur: number[]; prev: number[] }>();
    for (const m of marks) {
      if (m.assessment.maxMarks <= 0) continue;
      const p = (100 * (m.marks ?? 0)) / m.assessment.maxMarks;
      const g = bySubject.get(m.assessment.subjectId) ?? { cur: [], prev: [] };
      (m.assessment.heldOn >= b.termStart ? g.cur : g.prev).push(p);
      bySubject.set(m.assessment.subjectId, g);
    }
    const results = [...bySubject]
      .filter(([, g]) => g.cur.length)
      .map(([sid, g]) => {
        const score = Math.round(mean(g.cur)!);
        const before = mean(g.prev);
        const teacherId = entries.find((e) => e.subjectId === sid)?.employeeId;
        return { subject: subjects.get(sid) ?? '', score, grade: gradeFor(score), target: null, trend: before == null ? 0 : Math.round(score - before), teacher: teacherId ? teachers.get(teacherId) ?? null : null };
      })
      .sort((a, b2) => a.subject.localeCompare(b2.subject));
    const assessments = marks.filter((m) => m.assessment.heldOn >= b.termStart).length;
    return { results, assessments };
  }

  async detail(user: AuthUser, id: string, studentId?: string) {
    const { b, section } = await this.load(user, id);
    const [students, comments] = await Promise.all([this.students(b.sectionId), this.prisma.reportCardComment.findMany({ where: { batchId: id } })]);
    const byStudent = new Map(comments.map((c) => [c.studentId, c]));
    const list = students.map((s) => {
      const c = byStudent.get(s.id);
      return { id: s.id, admissionNo: s.admissionNo, fullName: s.fullName, roll: s.rollNo, commentId: c?.id ?? null, commentStatus: c?.status ?? null, aiDrafted: c ? c.aiDrafted : null };
    });
    const sel = list.find((s) => s.id === studentId) ?? list[0];
    let selected = null;
    if (sel) {
      const r = await this.results(b, section, sel.id);
      const c = byStudent.get(sel.id);
      const src = (c?.sources ?? null) as { assessments?: number; observations?: number; behaviour?: number } | null;
      selected = {
        student: sel,
        results: r.results,
        comment: c ? { id: c.id, comment: c.comment, aiDrafted: c.aiDrafted, status: c.status, reviewedBy: c.reviewedByName, updatedAt: c.updatedAt.toISOString() } : null,
        sources: { assessments: src?.assessments ?? r.assessments, observations: src?.observations ?? 0, behaviour: src?.behaviour ?? 0 },
      };
    }
    return {
      id: b.id,
      label: section.label,
      term: b.term,
      stage: b.stage,
      status: RC_STATUS[b.stage] ?? '',
      stages: RC_STAGES,
      due: dayKey(b.due),
      releasedAt: iso(b.releasedAt),
      locked: b.stage >= 5,
      students: list,
      counts: {
        total: list.length,
        drafts: list.filter((s) => s.commentStatus === 'Draft').length,
        approved: list.filter((s) => s.commentStatus === 'Approved').length,
        rejected: list.filter((s) => s.commentStatus === 'Rejected').length,
        missing: list.filter((s) => !s.commentId).length,
      },
      selected,
    };
  }

  /** Writes draft comments for the students who have none: AI drafts when a provider is connected, else empty drafts for teachers. */
  async draftMissing(user: AuthUser, id: string, req?: Request) {
    const { b, section } = await this.load(user, id);
    if (b.stage !== 2 && b.stage !== 3) throw badRequest('Comments are drafted after moderation, before the class is sent for approval');
    const students = await this.students(b.sectionId);
    const have = new Set((await this.prisma.reportCardComment.findMany({ where: { batchId: id }, select: { studentId: true } })).map((c) => c.studentId));
    const missing = students.filter((s) => !have.has(s.id));
    if (!missing.length) return { drafted: 0, aiDrafted: 0, message: 'Every student already has a comment' };
    const drafts = await this.aiDrafts(b, section, missing);
    await this.prisma.reportCardComment.createMany({
      data: missing.map((s) => {
        const d = drafts.get(s.id);
        return { batchId: id, studentId: s.id, comment: d?.comment ?? '', aiDrafted: !!d?.comment, status: 'Draft', sources: d?.sources as Prisma.InputJsonValue };
      }),
      skipDuplicates: true,
    });
    const ai = [...drafts.values()].filter((d) => d.comment).length;
    await this.audit.record({ user, action: 'create', module: 'academics', entityType: 'report_card_batch', entityId: id, campusId: b.campusId, req, description: `Drafted ${missing.length} report card comments for ${section.label} ${b.term} (${ai} by AI)` });
    const message = ai === missing.length
      ? `${ai} AI draft comment${ai === 1 ? '' : 's'} ready for review`
      : ai > 0
        ? `${ai} AI drafts and ${missing.length - ai} empty drafts created — write the empty ones yourself`
        : `AI drafting is not available — ${missing.length} empty draft${missing.length === 1 ? '' : 's'} created for teachers to write`;
    return { drafted: missing.length, aiDrafted: ai, message };
  }

  /** Asks the report-comments AI for drafts in small groups; returns nothing when no provider is connected or it fails. */
  private async aiDrafts(b: ReportCardBatch, section: SectionInfo, students: { id: string; firstName: string; fullName: string; attendancePct: number | null }[]) {
    const out = new Map<string, { comment: string; sources: { assessments: number; observations: number; behaviour: number } }>();
    const status = await this.ai.status('report_comments');
    const facts = new Map<string, StudentResults>();
    for (const s of students) facts.set(s.id, await this.results(b, section, s.id));
    if (!status.available) {
      for (const s of students) out.set(s.id, { comment: '', sources: { assessments: facts.get(s.id)!.assessments, observations: 0, behaviour: 0 } });
      return out;
    }
    for (let i = 0; i < students.length; i += 10) {
      const group = students.slice(i, i + 10);
      try {
        const reply = await this.ai.completeJson<{ comments: { id: string; comment: string }[] }>('report_comments', {
          system:
            'You write end-of-term report card comments for a Cambridge international school in India. For each student write 2–3 warm, specific sentences (40–70 words) ' +
            'in British English: one genuine strength drawn from the results, one clear next step, and encouragement. Use only the first name. ' +
            'Do not quote marks or percentages, do not invent facts, and do not mention attendance unless it is below 85%. ' +
            'Reply with JSON only: {"comments":[{"id":"<student id>","comment":"..."}]}',
          messages: [{
            role: 'user',
            content: JSON.stringify({
              class: section.label,
              term: b.term,
              students: group.map((s) => ({
                id: s.id,
                firstName: s.firstName,
                attendancePct: s.attendancePct,
                results: facts.get(s.id)!.results.map((r) => ({ subject: r.subject, grade: r.grade, trend: r.trend })),
              })),
            }),
          }],
          maxTokens: 2500,
        });
        for (const c of reply.data.comments ?? []) {
          if (!group.some((s) => s.id === c.id) || typeof c.comment !== 'string') continue;
          out.set(c.id, { comment: c.comment.trim().slice(0, 2000), sources: { assessments: facts.get(c.id)!.assessments, observations: 0, behaviour: 0 } });
        }
      } catch (err) {
        this.log.warn(`AI report comments failed for ${section.label}: ${(err as Error).message}`);
      }
    }
    for (const s of students) if (!out.has(s.id)) out.set(s.id, { comment: '', sources: { assessments: facts.get(s.id)!.assessments, observations: 0, behaviour: 0 } });
    return out;
  }

  async advance(user: AuthUser, id: string, toStage: number, req?: Request) {
    const { b, section } = await this.load(user, id);
    if (toStage !== b.stage + 1 || toStage > 5) throw badRequest(b.stage >= 5 ? 'These report cards are already released' : 'The class can move only to the next stage');
    const comments = await this.prisma.reportCardComment.findMany({ where: { batchId: id } });
    const students = await this.students(b.sectionId);
    let draftNote = '';

    if (toStage === 1 || toStage === 2) {
      // Every assessment of this term for the class must have its marks in (stage 1), and be moderated (stage 2).
      const pending = await this.prisma.assessment.findMany({
        where: {
          heldOn: { gte: b.termStart, lte: asDate(schoolToday() < dayKey(b.termEnd) ? schoolToday() : dayKey(b.termEnd)) },
          OR: [{ sectionId: b.sectionId }, { sectionId: null, classId: section.classId }],
          status: { in: toStage === 1 ? ['Scheduled', 'In Progress'] : ['Scheduled', 'In Progress', 'Moderation'] },
        },
        select: { code: true, status: true },
      });
      if (pending.length) {
        throw badRequest(`${pending.length} assessment${pending.length === 1 ? ' is' : 's are'} not ${toStage === 1 ? 'fully marked' : 'moderated'} yet: ${pending.slice(0, 4).map((p) => `${p.code} (${p.status})`).join(', ')}`);
      }
    }
    if (toStage === 3 && students.some((s) => !comments.some((c) => c.studentId === s.id))) throw badRequest('Some students do not have a draft comment yet');
    if (toStage === 4) {
      const approved = comments.filter((c) => c.status === 'Approved' && students.some((s) => s.id === c.studentId)).length;
      if (approved < students.length) throw badRequest(`${students.length - approved} comment(s) still need approval before the class can be sent for approval`);
    }
    if (toStage === 5 && !this.access.isSchoolLevel(user)) throw forbidden('Report cards are approved and released by the academic office');

    await this.prisma.reportCardBatch.update({
      where: { id },
      data: { stage: toStage, ...(toStage === 5 ? { releasedAt: new Date(), approvedById: user.id, approvedByName: user.fullName } : {}) },
    });

    if (toStage === 2) {
      const r = await this.draftMissing(user, id, req);
      draftNote = r.drafted ? ` · ${r.message}` : '';
    }
    if (toStage === 4) {
      const leads = await this.access.schoolLeads(b.campusId, user.id);
      for (const assigneeId of leads) {
        await this.notifications.createTask({
          title: `Approve report cards: ${section.label} ${b.term}`, module: 'Academics', assigneeId, status: 'Under Review', priority: 'High',
          dueOn: b.due, route: '/report-cards', entityType: 'report_card_batch', entityId: id,
        });
      }
      await this.notifications.notifyUsers(leads, {
        category: 'Attention', topic: 'system', module: 'academics', campusId: b.campusId,
        title: `Report cards ready for approval: ${section.label}`, body: `${b.term} · sent by ${user.fullName}`, route: '/report-cards',
      });
    }
    if (toStage === 5) await this.releaseNotify(b, section, students.map((s) => s.id));

    const message = [
      'Sent for moderation',
      'Moderation done — comments drafted',
      'Teacher review started',
      'Sent for approval — the academic office is notified',
      'Approved and released to parents',
    ][toStage - 1];
    await this.audit.record({
      user, action: toStage === 5 ? 'approve' : 'update', module: 'academics', entityType: 'report_card_batch', entityId: id, campusId: b.campusId, req,
      description: `Report cards ${section.label} ${b.term}: ${RC_STAGES[b.stage]} → ${RC_STAGES[toStage]}${toStage === 5 ? ` (approved by ${user.fullName})` : ''}`,
    });
    return { stage: toStage, status: RC_STATUS[toStage], message: message + draftNote };
  }

  private async releaseNotify(b: ReportCardBatch, section: SectionInfo, studentIds: string[]) {
    await this.notifications.completeTasksFor('report_card_batch', b.id);
    const guardians = await this.access.guardianUsers(studentIds);
    const ids = [...new Set([...guardians.values()].flat())];
    await this.notifications.notifyUsers(ids, {
      category: 'Information', topic: 'system', module: 'academics', campusId: b.campusId, deliver: true,
      title: `${b.term} report card released`, body: `The ${section.label} report card is ready to read in Parent 360.`, route: '/parent-360?tab=academics',
    });
  }

  /** Approves and releases every class awaiting approval in scope. */
  async releaseAll(user: AuthUser, campusId?: string, req?: Request) {
    if (!this.access.isSchoolLevel(user)) throw forbidden('Report cards are approved and released by the academic office');
    const sections = await this.access.sections(user, campusId);
    const batches = await this.prisma.reportCardBatch.findMany({ where: { stage: 4, sectionId: { in: sections.map((s) => s.id) } } });
    if (!batches.length) throw badRequest('No classes are awaiting approval');
    const info = new Map(sections.map((s) => [s.id, s]));
    for (const b of batches) {
      await this.prisma.reportCardBatch.update({ where: { id: b.id }, data: { stage: 5, releasedAt: new Date(), approvedById: user.id, approvedByName: user.fullName } });
      const students = await this.students(b.sectionId);
      await this.releaseNotify(b, info.get(b.sectionId)!, students.map((s) => s.id));
      await this.audit.record({ user, action: 'approve', module: 'academics', entityType: 'report_card_batch', entityId: b.id, campusId: b.campusId, req, description: `Approved and released ${info.get(b.sectionId)?.label} ${b.term} report cards to parents` });
    }
    return { released: batches.length };
  }

  /** approve (with optional edit) / reject / regenerate one comment. */
  async review(user: AuthUser, commentId: string, action: 'approve' | 'reject' | 'regenerate', text?: string, req?: Request) {
    const c = await this.prisma.reportCardComment.findUnique({ where: { id: commentId } });
    if (!c) throw notFound('Comment');
    const { b, section } = await this.load(user, c.batchId);
    if (b.stage !== 2 && b.stage !== 3) throw badRequest(b.stage > 3 ? 'Comments are locked once the class is sent for approval' : 'Comments are reviewed after moderation');
    const student = await this.prisma.student.findUnique({ where: { id: c.studentId }, select: { fullName: true, firstName: true, attendancePct: true } });
    let status = c.status;
    let message: string;
    if (action === 'approve') {
      const comment = (text ?? c.comment).trim();
      if (comment.length < 10) throw fieldError('comment', 'Write at least a sentence');
      status = 'Approved';
      await this.prisma.reportCardComment.update({
        where: { id: commentId },
        data: { comment, status, reviewedById: user.id, reviewedByName: user.fullName },
      });
      message = c.status === 'Approved' ? 'Approved comment saved' : 'Comment approved';
    } else if (action === 'reject') {
      status = 'Rejected';
      await this.prisma.reportCardComment.update({ where: { id: commentId }, data: { status, reviewedById: user.id, reviewedByName: user.fullName } });
      message = 'Draft rejected';
    } else {
      const drafts = await this.aiDrafts(b, section, [{ id: c.studentId, firstName: student?.firstName ?? '', fullName: student?.fullName ?? '', attendancePct: student?.attendancePct ?? null }]);
      const d = drafts.get(c.studentId);
      if (!d?.comment) throw badRequest('The AI could not draft a comment right now. Check the AI provider under Users & Settings, or write the comment yourself.');
      status = 'Draft';
      await this.prisma.reportCardComment.update({
        where: { id: commentId },
        data: { comment: d.comment, aiDrafted: true, status, reviewedById: null, reviewedByName: null, sources: d.sources as Prisma.InputJsonValue },
      });
      message = 'New draft ready';
    }
    await this.audit.record({
      user, action: action === 'approve' ? 'approve' : action === 'reject' ? 'reject' : 'update', module: 'academics', entityType: 'report_card_comment', entityId: commentId,
      campusId: b.campusId, req, description: `${action === 'regenerate' ? 'Regenerated' : action === 'approve' ? 'Approved' : 'Rejected'} the report card comment for ${student?.fullName ?? 'a student'} (${section.label} ${b.term})`,
    });
    return { status, message };
  }
}

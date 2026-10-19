import { Injectable } from '@nestjs/common';
import type { AiProvider, ExamCorrectionConfig, ExamCorrectionExam, Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth-user';
import { conflict, forbidden, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AiService } from '../ai/ai.service';
import { examRole, isManager, PDF_PROVIDERS, visionProblem, type ExamRole } from './ec.util';

export interface AiStatusDto {
  reading_available: boolean;
  reading_reason: string;
  marking_available: boolean;
  marking_reason: string;
  vision_model: string;
  eval_model: string;
}

export interface AiState {
  cfg: ExamCorrectionConfig;
  provider: AiProvider | null;
  /** The provider's adapter accepts PDF pages as documents. */
  pdfOk: boolean;
  status: AiStatusDto;
}

const NO_PROVIDER = 'No AI provider is connected. A Super Admin can connect Claude, Gemini, OpenAI, Groq or OpenRouter under Users & Settings › AI Providers.';

/** Who may do what in Paper Correction, the module settings, and whether AI reading/marking can run. */
@Injectable()
export class EcAccess {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly ai: AiService,
  ) {}

  role(user: AuthUser): ExamRole | null {
    return examRole(user);
  }

  isManager(user: AuthUser): boolean {
    return isManager(examRole(user));
  }

  assertManager(user: AuthUser, what = 'Only exam coordinators and administrators can do this'): void {
    if (!this.isManager(user)) throw forbidden(what);
  }

  /** Examinations the user may open: managers — their campus (or all in group view); teachers — assigned ones. */
  examWhere(user: AuthUser): Prisma.ExamCorrectionExamWhereInput {
    if (this.isManager(user)) {
      const campusId = this.scope.campus(user);
      return campusId ? { OR: [{ campusId }, { campusId: null }] } : {};
    }
    return { teachers: { some: { userId: user.id } } };
  }

  async exam(user: AuthUser, id: string): Promise<ExamCorrectionExam> {
    const exam = await this.prisma.examCorrectionExam.findFirst({ where: { AND: [{ id }, this.examWhere(user)] } });
    if (exam) return exam;
    if (await this.prisma.examCorrectionExam.count({ where: { id } })) throw forbidden('This examination is not assigned to you');
    throw notFound('Examination');
  }

  async submission(user: AuthUser, id: string) {
    const sub = await this.prisma.examCorrectionSubmission.findUnique({ where: { id } });
    if (!sub) throw notFound('Answer sheet');
    const exam = await this.exam(user, sub.examId);
    return { sub, exam };
  }

  async question(user: AuthUser, id: string) {
    const question = await this.prisma.examCorrectionQuestion.findUnique({ where: { id } });
    if (!question) throw notFound('Question');
    const exam = await this.exam(user, question.examId);
    return { question, exam };
  }

  async answer(user: AuthUser, id: string) {
    const answer = await this.prisma.examCorrectionAnswer.findUnique({ where: { id }, include: { question: true } });
    if (!answer) throw notFound('Answer');
    const { sub, exam } = await this.submission(user, answer.submissionId);
    return { answer, sub, exam };
  }

  async page(user: AuthUser, id: string) {
    const page = await this.prisma.examCorrectionPage.findUnique({ where: { id } });
    if (!page) throw notFound('Page');
    const { sub, exam } = await this.submission(user, page.submissionId);
    return { page, sub, exam };
  }

  /** Marks and sheets are frozen once results are approved or published. */
  assertOpen(exam: Pick<ExamCorrectionExam, 'resultsStatus'>, what = 'answer sheets or marks'): void {
    if (exam.resultsStatus === 'approved' || exam.resultsStatus === 'published') {
      throw conflict(`Results are ${exam.resultsStatus}. An exam coordinator moves them back to draft before ${what} can change.`);
    }
  }

  // -------------------------------------------------------------------------
  // Settings and AI readiness
  // -------------------------------------------------------------------------

  async config(): Promise<ExamCorrectionConfig> {
    return (
      (await this.prisma.examCorrectionConfig.findUnique({ where: { id: 'default' } })) ??
      this.prisma.examCorrectionConfig.upsert({ where: { id: 'default' }, create: { id: 'default' }, update: {} })
    );
  }

  async aiState(): Promise<AiState> {
    const [cfg, provider] = await Promise.all([this.config(), this.ai.providerFor('paper_correction')]);
    let reading = '';
    let marking = '';
    if (!provider) reading = marking = NO_PROVIDER;
    else if (!cfg.aiEnabled) reading = marking = 'AI reading and marking are switched off in Paper Correction › AI configuration.';
    else if (!cfg.externalAck) {
      reading = marking = `An administrator must first acknowledge that student pages are sent to ${provider.label} (Paper Correction › AI configuration).`;
    } else {
      reading = visionProblem(provider) ?? '';
    }
    return {
      cfg,
      provider,
      pdfOk: !!provider && PDF_PROVIDERS.has(provider.provider),
      status: {
        reading_available: !reading,
        reading_reason: reading,
        marking_available: !marking,
        marking_reason: marking,
        vision_model: provider ? provider.visionModel || provider.model : '',
        eval_model: provider ? provider.model : '',
      },
    };
  }
}

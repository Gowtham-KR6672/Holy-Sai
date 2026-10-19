import { Module, OnModuleInit } from '@nestjs/common';
import { can } from '../../common/auth-user';
import { PrismaService } from '../../common/prisma.service';
import { AcademicsModule } from '../academics/academics.module';
import { OperationsModule } from '../operations/operations.module';
import { SearchService } from '../search/search.service';
import { EcAnswersController } from './ec-answers.controller';
import { EcExamsController } from './ec-exams.controller';
import { EcQuestionsController } from './ec-questions.controller';
import { EcSettingsController } from './ec-settings.controller';
import { EcSheetsController } from './ec-sheets.controller';
import { EcStatusController } from './ec-status.controller';
import { EcAccess } from './ec.access';
import { EcAi } from './ec.ai.service';
import { EcAudit } from './ec.audit';
import { EcPages } from './ec.pages.service';
import { EcPipeline } from './ec.pipeline.service';
import { EcQueue } from './ec.queue.service';
import { EcReports } from './ec.reports.service';
import { EcRoster } from './ec.roster.service';
import { EcViews } from './ec.views.service';

/**
 * Paper Correction (the EXAM Vision engine, built in): examinations, questions and rubrics, answer-sheet
 * upload (photos and PDFs split into pages), background AI reading and marking through AiService
 * ("paper_correction"), teacher review with full history, approval, reports, and sending approved marks
 * to an Academics assessment. Files are stored with the operations StorageService.
 */
@Module({
  imports: [OperationsModule, AcademicsModule],
  controllers: [EcStatusController, EcExamsController, EcQuestionsController, EcSheetsController, EcAnswersController, EcSettingsController],
  providers: [EcAccess, EcAudit, EcAi, EcPages, EcViews, EcPipeline, EcQueue, EcReports, EcRoster],
})
export class ExamCorrectionModule implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: EcAccess,
    private readonly search: SearchService,
  ) {}

  onModuleInit() {
    // Examinations in the global search (Ctrl K) for staff who use Paper Correction.
    this.search.register(async (user, q) => {
      if (!can(user, 'assessments.manage')) return [];
      const rows = await this.prisma.examCorrectionExam.findMany({
        where: { AND: [this.access.examWhere(user), { OR: [{ name: { contains: q, mode: 'insensitive' } }, { subject: { contains: q, mode: 'insensitive' } }] }] },
        orderBy: { createdAt: 'desc' },
        take: 4,
      });
      return rows.map((e) => ({ group: 'Paper Correction', label: e.name, meta: `${e.className}${e.section ? ` ${e.section}` : ''} · ${e.subject}`, icon: 'scan', route: `/paper-correction/exams/${e.id}` }));
    });
  }
}

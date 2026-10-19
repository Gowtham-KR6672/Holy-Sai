import { Module, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { SearchService } from '../search/search.service';
import { AcademicsAccess } from './academics.access';
import { AssessmentsController } from './assessments.controller';
import { AssessmentsService } from './assessments.service';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { ClassesController } from './classes.controller';
import { CurriculumService } from './curriculum.service';
import { HomeworkController } from './homework.controller';
import { LessonPlansController } from './lesson-plans.controller';
import { ObjectivesController } from './objectives.controller';
import { PerformanceController } from './performance.controller';
import { QuestionBankController } from './question-bank.controller';
import { ReportCardsController } from './report-cards.controller';
import { ReportCardsService } from './report-cards.service';
import { TeacherDashboardController } from './teacher-dashboard.controller';
import { TimetableController } from './timetable.controller';
import { TimetableService } from './timetable.service';

/**
 * Academics and student attendance: classes and subjects, timetable and cover, registers,
 * lesson plans, homework, question bank, Cambridge objectives, assessments, report cards and performance.
 */
@Module({
  controllers: [
    TeacherDashboardController,
    ClassesController,
    ObjectivesController,
    ReportCardsController,
    TimetableController,
    AttendanceController,
    HomeworkController,
    LessonPlansController,
    QuestionBankController,
    AssessmentsController,
    PerformanceController,
  ],
  providers: [AcademicsAccess, TimetableService, AttendanceService, AssessmentsService, CurriculumService, ReportCardsService],
  exports: [AcademicsAccess, AttendanceService, AssessmentsService, TimetableService],
})
export class AcademicsModule implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly search: SearchService,
    private readonly timetable: TimetableService,
    private readonly curriculum: CurriculumService,
    private readonly assessments: AssessmentsService,
  ) {}

  async onModuleInit() {
    // Teachers also see the sections they teach or cover in the timetable (not only their form class).
    this.scope.registerTeacherSections((employeeId) => this.timetable.teacherSections(employeeId));
    await this.curriculum.seedDefaults();

    this.search.register(async (user, q) => {
      if (!user.permissions.has('academics.read')) return [];
      const [assessments, plans] = await Promise.all([
        this.prisma.assessment.findMany({
          where: { AND: [await this.assessments.scopeWhere(user), { OR: [{ code: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] }] },
          take: 4,
          orderBy: { heldOn: 'desc' },
        }),
        this.prisma.lessonPlan.findMany({ where: { title: { contains: q, mode: 'insensitive' }, ...(user.employeeId && user.scope === 'class' ? { authorId: user.employeeId } : {}) }, take: 3, orderBy: { updatedAt: 'desc' } }),
      ]);
      return [
        ...assessments.map((a) => ({ group: 'Assessments', label: `${a.code} · ${a.name}`, meta: a.status, icon: 'clipboard', route: `/assessments?q=${encodeURIComponent(a.code)}` })),
        ...plans.map((p) => ({ group: 'Lesson plans', label: p.title, meta: p.status, icon: 'bookOpen', route: `/lesson-plans?q=${encodeURIComponent(p.title)}` })),
      ];
    });
  }
}

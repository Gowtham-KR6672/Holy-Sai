// Feature modules. Every module is registered here up front; each module build fills in its own folder.
import type { Type } from '@nestjs/common';
import { AcademicsModule } from './academics/academics.module';
import { AdmissionsModule } from './admissions/admissions.module';
import { FinanceModule } from './finance/finance.module';
import { WorkforceModule } from './workforce/workforce.module';
import { ParentsModule } from './parents/parents.module';
import { OperationsModule } from './operations/operations.module';
import { SafetyModule } from './safety/safety.module';
import { TransportModule } from './transport/transport.module';
import { InnovationModule } from './innovation/innovation.module';
import { StudentsModule } from './students/students.module';
import { FamilyModule } from './family/family.module';
import { IntelligenceModule } from './intelligence/intelligence.module';
import { InsightsModule } from './insights/insights.module';
import { ExamCorrectionModule } from './exam-correction/exam-correction.module';

export const FEATURE_MODULES: Type<unknown>[] = [
  AcademicsModule,
  AdmissionsModule,
  FinanceModule,
  WorkforceModule,
  ParentsModule,
  OperationsModule,
  SafetyModule,
  TransportModule,
  InnovationModule,
  StudentsModule,
  FamilyModule,
  IntelligenceModule,
  InsightsModule,
  ExamCorrectionModule,
];

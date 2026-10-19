import { Module } from '@nestjs/common';
import { AdmissionsModule } from '../admissions/admissions.module';
import { OperationsModule } from '../operations/operations.module';
import { ParentsModule } from '../parents/parents.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { CopilotController } from './copilot.controller';
import { CopilotService } from './copilot.service';
import { EarlyWarningController } from './early-warning.controller';
import { EarlyWarningService } from './early-warning.service';
import { IntelligenceHooks } from './intelligence.hooks';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeLive } from './knowledge.live';
import { KnowledgeService } from './knowledge.service';
import { IntelPeople } from './people.service';
import { PortfolioController } from './portfolio.controller';
import { StudentExtrasService } from './student-extras.service';
import { TalentController } from './talent.controller';
import { TalentService } from './talent.service';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';

/**
 * Intelligence: Early Warning (daily and on-demand signal check, teacher review, interventions; Teacher
 * Dashboard watchlist and the post-register check through the academics hooks), Talent Discovery, Student
 * Portfolio, the AI Teacher Co-Pilot, School Knowledge AI, Analytics, and the WhatsApp AI assistant webhook.
 * Also contributes skills, talent, activities, interests and interventions to the Student 360 profile.
 *
 * WhatsApp enquiries go through the admissions LeadsService, so they follow the same lead lifecycle as every other.
 */
@Module({
  imports: [OperationsModule, ParentsModule, AdmissionsModule],
  controllers: [EarlyWarningController, TalentController, PortfolioController, CopilotController, KnowledgeController, AnalyticsController, WhatsappController],
  providers: [
    IntelPeople,
    StudentExtrasService,
    EarlyWarningService,
    TalentService,
    CopilotService,
    KnowledgeService,
    KnowledgeLive,
    AnalyticsService,
    WhatsappService,
    IntelligenceHooks,
  ],
  exports: [EarlyWarningService, TalentService, KnowledgeService],
})
export class IntelligenceModule {}

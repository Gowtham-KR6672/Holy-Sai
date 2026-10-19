import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module';
import { ParentsModule } from '../parents/parents.module';
import { TransportModule } from '../transport/transport.module';
import { StudentLifecycleService } from './lifecycle.service';
import { StudentProfileService } from './profile.service';
import { StudentRecordsService } from './records.service';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';
import { WellbeingController } from './wellbeing.controller';

/**
 * Students: the student register (/students), the Student 360 profile shared by staff, parents and the student
 * (/students/:id/profile), behaviour notes, observations and achievements, Behaviour & Wellbeing (/wellbeing/*),
 * and the student lifecycle (/students/:id/status — records are kept; leaving disables the related sign-ins).
 *
 * Exported for other modules:
 *  - StudentsService: list/rows (register rows), summary, nextAdmissionNo (HS-<year>-<seq>, shared with Admissions)
 *  - StudentRecordsService: counts(studentIds, from?, to?), recentBehaviour, recentObservations
 *  - StudentLifecycleService: changeStatus(user, id, { status, reason, effectiveOn }), liftGuardianHolds(guardianIds)
 *  - StudentsExtensions (students.extensions.ts): registerProfile(fn) adds skills, talent, activities, interventions
 *    and timeline entries to the profile.
 */
@Module({
  imports: [FinanceModule, TransportModule, ParentsModule],
  controllers: [StudentsController, WellbeingController],
  providers: [StudentsService, StudentProfileService, StudentRecordsService, StudentLifecycleService],
  exports: [StudentsService, StudentRecordsService, StudentLifecycleService],
})
export class StudentsModule {}

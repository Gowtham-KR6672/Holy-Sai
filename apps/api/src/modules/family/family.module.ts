import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module';
import { ParentsModule } from '../parents/parents.module';
import { SafetyModule } from '../safety/safety.module';
import { TransportModule } from '../transport/transport.module';
import { FamilyAccess } from './family-access.service';
import { FamilyController, FamilyParentsController } from './family.controller';
import { FamilyService } from './family.service';

/**
 * Family portal (Parent 360): GET /parents/me, /parents/:pid/children/:cid/{overview,location,location/history}
 * and /family/* (fees and Pay Now, receipts, pickup persons, safety card, circulars, messages, PTM, calendar).
 * Registered after ParentsModule so the directory's GET /parents/:id can step aside for "me".
 * Reuses the exported services of Parents, Safety, Finance and Transport; it has no tables of its own.
 */
@Module({
  imports: [ParentsModule, SafetyModule, FinanceModule, TransportModule],
  controllers: [FamilyParentsController, FamilyController],
  providers: [FamilyAccess, FamilyService],
})
export class FamilyModule {}

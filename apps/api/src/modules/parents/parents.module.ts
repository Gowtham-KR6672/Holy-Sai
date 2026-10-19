import { Module } from '@nestjs/common';
import { AudienceService } from './audience.service';
import { CircularsController } from './circulars.controller';
import { CircularsService } from './circulars.service';
import { CommunicationsController, ThreadsController } from './communications.controller';
import { CommunicationsService } from './communications.service';
import { DirectoryController, ParentsController } from './directory.controller';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { ParentsService } from './parents.service';
import { PtmController } from './ptm.controller';
import { PtmService } from './ptm.service';
import { ThreadsService } from './threads.service';

const SERVICES = [ParentsService, AudienceService, CommunicationsService, ThreadsService, CircularsService, EventsService, PtmService];

/**
 * Parents — Parent Experience: parent directory and records, family communication (all channels, unanswered
 * queue, parent-app conversations), circulars with acknowledgements, the events calendar and PTM sessions.
 * The services are exported for the family portal (bookings, acknowledgements, family messages, family events).
 */
@Module({
  controllers: [DirectoryController, ParentsController, CommunicationsController, ThreadsController, CircularsController, EventsController, PtmController],
  providers: SERVICES,
  exports: SERVICES,
})
export class ParentsModule {}

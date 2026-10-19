import { Global, Module } from '@nestjs/common';
import { AuditService } from '../modules/audit/audit.service';
import { AiService } from '../modules/ai/ai.service';
import { TokensService } from '../modules/auth/tokens.service';
import { IntegrationsService } from '../modules/integrations/integrations.service';
import { MessagingService } from '../modules/integrations/messaging.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { SearchService } from '../modules/search/search.service';
import { SettingsService } from '../modules/settings/settings.service';
import { CountersService } from './counters.service';
import { CryptoService } from './crypto.service';
import { PermissionCacheService } from './permission-cache.service';
import { PrismaService } from './prisma.service';
import { ScopeService } from './scope.service';

const SHARED = [
  PrismaService,
  CryptoService,
  CountersService,
  PermissionCacheService,
  ScopeService,
  AuditService,
  SettingsService,
  NotificationsService,
  AiService,
  IntegrationsService,
  MessagingService,
  SearchService,
  TokensService,
];

/** Services every feature module can inject. */
@Global()
@Module({ providers: SHARED, exports: SHARED })
export class CommonModule {}

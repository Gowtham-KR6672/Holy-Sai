import { Global, Module, type Provider } from '@nestjs/common';
import { AuditService } from '../modules/audit/audit.service';
import { AiService } from '../modules/ai/ai.service';
import { TokensService } from '../modules/auth/tokens.service';
import { IntegrationsService } from '../modules/integrations/integrations.service';
import { MessagingService } from '../modules/integrations/messaging.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { SearchService } from '../modules/search/search.service';
import { SettingsService } from '../modules/settings/settings.service';
import { LoginDirectory } from '../tenancy/login-directory.service';
import { PlatformDb } from '../tenancy/platform-db.service';
import { PlatformSettings } from '../tenancy/platform-settings.service';
import { SubscriptionStatusService } from '../tenancy/subscription-status.service';
import { createPrismaProxy } from '../tenancy/prisma.proxy';
import { TenancyMiddleware } from '../tenancy/tenancy.middleware';
import { TenancyService } from '../tenancy/tenancy.service';
import { WorkspaceSeeds } from '../tenancy/workspace-seeds.service';
import { CountersService } from './counters.service';
import { CryptoService } from './crypto.service';
import { PermissionCacheService } from './permission-cache.service';
import { PrismaService } from './prisma.service';
import { ScopeService } from './scope.service';

/** PrismaService is the current workspace's database (see tenancy/prisma.proxy.ts). */
const PRISMA: Provider = { provide: PrismaService, useFactory: createPrismaProxy, inject: [TenancyService] };

const SHARED = [
  PlatformDb,
  PlatformSettings,
  SubscriptionStatusService,
  TenancyService,
  LoginDirectory,
  WorkspaceSeeds,
  TenancyMiddleware,
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
@Module({ providers: [PRISMA, ...SHARED], exports: [PrismaService, ...SHARED] })
export class CommonModule {}

import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthGuard } from './common/auth.guard';
import { CommonModule } from './common/common.module';
import { EnvelopeInterceptor } from './common/envelope';
import { ErrorFilter } from './common/errors';
import { AiController } from './modules/ai/ai.controller';
import { AuditController } from './modules/audit/audit.controller';
import { AuthController } from './modules/auth/auth.controller';
import { AuthService } from './modules/auth/auth.service';
import { IntegrationsController } from './modules/integrations/integrations.controller';
import { LookupsController } from './modules/lookups/lookups.controller';
import { NotificationsController } from './modules/notifications/notifications.controller';
import { PublicController } from './modules/public/public.controller';
import { SearchController } from './modules/search/search.controller';
import { SettingsController } from './modules/settings/settings.controller';
import { SetupController } from './modules/setup/setup.controller';
import { RolesController, UsersController } from './modules/users/users.controller';
import { FEATURE_MODULES } from './modules';

@Module({
  imports: [
    JwtModule.register({ global: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1200 }]),
    ScheduleModule.forRoot(),
    CommonModule,
    ...FEATURE_MODULES,
  ],
  controllers: [
    PublicController,
    AuthController,
    LookupsController,
    SearchController,
    UsersController,
    RolesController,
    SettingsController,
    SetupController,
    AuditController,
    NotificationsController,
    AiController,
    IntegrationsController,
  ],
  providers: [
    AuthService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule {}

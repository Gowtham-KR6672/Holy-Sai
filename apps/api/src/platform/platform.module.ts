import { Module } from '@nestjs/common';
import { PaymentWebhooksController, PlatformBillingController, SchoolSubscriptionController } from './billing/billing.controllers';
import { BillingJobs } from './billing/billing.jobs';
import { BillingService } from './billing/billing.service';
import { GatewayConfigs } from './billing/gateways';
import { PlatformMailer } from './billing/platform-mailer.service';
import { PlatformAdminsController } from './platform-admins.controller';
import { PlatformAudit } from './platform-audit.service';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformGuard } from './platform.guard';
import { PlatformJobs } from './platform.jobs';
import { ProvisioningService } from './provisioning.service';
import { SupportService } from './support.service';
import { SupportController, WorkspacesController } from './workspaces.controller';

/** We School's own console: platform admins, schools (workspaces), support access and billing. */
@Module({
  controllers: [
    PlatformAuthController,
    WorkspacesController,
    SupportController,
    PlatformAdminsController,
    PlatformBillingController,
    SchoolSubscriptionController,
    PaymentWebhooksController,
  ],
  providers: [
    PlatformAudit,
    PlatformAuthService,
    PlatformGuard,
    PlatformJobs,
    ProvisioningService,
    SupportService,
    GatewayConfigs,
    PlatformMailer,
    BillingService,
    BillingJobs,
  ],
  exports: [PlatformAudit, PlatformAuthService, ProvisioningService, BillingService],
})
export class PlatformModule {}

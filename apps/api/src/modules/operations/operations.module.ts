import { Module } from '@nestjs/common';
import { AssetsController } from './assets.controller';
import { CertificateChecksService } from './certificate-checks.service';
import { CertificatesController } from './certificates.controller';
import { ComplianceController } from './compliance.controller';
import { DocumentsController } from './documents.controller';
import { FacilitiesController } from './facilities.controller';
import { InventoryController } from './inventory.controller';
import { MaintenanceController } from './maintenance.controller';
import { OperationsJobs } from './operations.jobs';
import { OpsContext } from './ops.util';
import { StorageService } from './storage.service';

/**
 * Operations: assets, facilities and bookings, maintenance, inventory, documents, certificates and the
 * compliance calendar. StorageService (private file storage) and CertificateChecksService (pluggable
 * fee/clearance checks) are exported for other modules.
 */
@Module({
  controllers: [
    AssetsController,
    FacilitiesController,
    MaintenanceController,
    InventoryController,
    DocumentsController,
    CertificatesController,
    ComplianceController,
  ],
  providers: [OpsContext, StorageService, CertificateChecksService, OperationsJobs],
  exports: [StorageService, CertificateChecksService],
})
export class OperationsModule {}

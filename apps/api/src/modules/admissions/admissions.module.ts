import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { can } from '../../common/auth-user';
import { like } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { SearchService } from '../search/search.service';
import { AdmissionsController } from './admissions.controller';
import { ApplicationsController } from './applications.controller';
import { CrmController, VendorRenewals } from './crm.controller';
import { EnquiriesController } from './enquiries.controller';
import { LeadsService } from './leads.service';
import { ReferralsController } from './referrals.controller';
import { StudentsModule } from '../students/students.module';

/** Adds leads and applications to the global (Ctrl K) search. */
@Injectable()
export class AdmissionsSearch implements OnModuleInit {
  constructor(
    private readonly search: SearchService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.search.register(async (user, q) => {
      if (!can(user, 'admissions.read', 'admissions.manage')) return [];
      const campus = user.scope === 'school' ? {} : user.campusId ? { campusId: user.campusId } : {};
      const [leads, apps] = await Promise.all([
        this.prisma.admissionLead.findMany({
          where: { ...campus, OR: [{ code: like(q) }, { studentName: like(q) }, { parentName: like(q) }] },
          take: 5,
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.admissionApplication.findMany({
          where: { ...campus, applicationNo: like(q) },
          include: { lead: { select: { code: true } } },
          take: 3,
          orderBy: { createdAt: 'desc' },
        }),
      ]);
      return [
        ...leads.map((l) => ({ group: 'Leads', label: l.studentName, meta: `${l.code} · ${l.grade} · ${l.stage} · ${l.parentName}`, icon: 'target', route: `/leads?lead=${l.code}` })),
        ...apps.map((a) => ({ group: 'Applications', label: a.studentName, meta: `${a.applicationNo} · ${a.grade} · ${a.status}`, icon: 'fileText', route: `/applications?lead=${a.lead.code}` })),
      ];
    });
  }
}

/** Admissions & CRM: leads, follow-ups, visits, applications, enrolment, referrals, analytics, alumni, vendors and partners. */
@Module({
  imports: [StudentsModule],
  controllers: [AdmissionsController, EnquiriesController, ApplicationsController, ReferralsController, CrmController],
  providers: [LeadsService, VendorRenewals, AdmissionsSearch],
  exports: [LeadsService],
})
export class AdmissionsModule {}

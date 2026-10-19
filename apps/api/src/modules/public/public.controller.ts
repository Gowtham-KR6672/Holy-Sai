import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators';
import { PrismaService } from '../../common/prisma.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { SettingsService } from '../settings/settings.service';

/** What the sign-in screen and maps need before anyone has signed in. */
@Controller('public')
export class PublicController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly integrations: IntegrationsService,
  ) {}

  @Public()
  @Get('config')
  async config() {
    const [values, year, students, staff, campuses, maps] = await Promise.all([
      this.settings.publicValues(),
      this.prisma.academicYear.findFirst({ where: { isCurrent: true } }),
      this.prisma.student.count({ where: { status: 'active' } }),
      this.prisma.employee.count({ where: { employmentStatus: { not: 'exited' }, archivedAt: null } }),
      this.prisma.campus.count({ where: { isActive: true } }),
      this.integrations.get('maps'),
    ]);
    return {
      schoolName: (values['school.name'] as string) ?? 'Holy Sai International School',
      productName: (values['school.product_name'] as string) ?? 'Holy Sai Smart School 360',
      tagline: (values['school.tagline'] as string) ?? '',
      languages: (values['school.languages'] as string[]) ?? ['en'],
      currency: (values['school.currency'] as string) ?? 'INR',
      timezone: (values['school.timezone'] as string) ?? 'Asia/Kolkata',
      academicYear: year?.label ?? null,
      stats: { students, staff, campuses },
      map: maps.isEnabled && maps.config.tileUrl ? { tileUrl: maps.config.tileUrl, attribution: maps.config.attribution ?? '' } : undefined,
      setupRequired: campuses === 0 || !year,
    };
  }

  @Public()
  @Get('health')
  health() {
    return { ok: true, time: new Date().toISOString() };
  }
}

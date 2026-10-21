import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators';
import { PrismaService } from '../../common/prisma.service';
import { currentWorkspaceOrNull } from '../../tenancy/context';
import { IntegrationsService } from '../integrations/integrations.service';
import { SettingsService } from '../settings/settings.service';

/**
 * What the sign-in screen and maps need before anyone has signed in. Without a school (the shared We School sign-in
 * page) it describes We School itself; with one (/api/w/<code>/public/config, or a signed-in request) that school.
 */
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
    const ws = currentWorkspaceOrNull();
    if (!ws) {
      return {
        schoolName: null, productName: 'We School', tagline: '', languages: ['en', 'ta', 'hi'], currency: 'INR', timezone: 'Asia/Kolkata',
        academicYear: null, stats: { students: 0, staff: 0, campuses: 0 }, map: undefined, setupRequired: false, platform: true,
      };
    }
    const [values, year, students, staff, campuses, maps] = await Promise.all([
      this.settings.publicValues(),
      this.prisma.academicYear.findFirst({ where: { isCurrent: true } }),
      this.prisma.student.count({ where: { status: 'active' } }),
      this.prisma.employee.count({ where: { employmentStatus: { not: 'exited' }, archivedAt: null } }),
      this.prisma.campus.count({ where: { isActive: true } }),
      this.integrations.get('maps'),
    ]);
    return {
      schoolName: (values['school.name'] as string) ?? ws.name,
      productName: 'We School',
      tagline: (values['school.tagline'] as string) ?? '',
      languages: (values['school.languages'] as string[]) ?? ['en'],
      currency: (values['school.currency'] as string) ?? 'INR',
      timezone: (values['school.timezone'] as string) ?? 'Asia/Kolkata',
      academicYear: year?.label ?? null,
      stats: { students, staff, campuses },
      map: maps.isEnabled && maps.config.tileUrl ? { tileUrl: maps.config.tileUrl, attribution: maps.config.attribution ?? '' } : undefined,
      setupRequired: campuses === 0 || !year,
      platform: false,
      workspace: { code: ws.code, name: ws.name },
    };
  }

  @Public()
  @Get('health')
  health() {
    return { ok: true, time: new Date().toISOString() };
  }
}

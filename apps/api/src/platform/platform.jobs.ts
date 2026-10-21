import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LoginDirectory } from '../tenancy/login-directory.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { SUPPORT_EMAIL_DOMAIN } from './provisioning.service';

/** Platform housekeeping: keeps the sign-in directory in step with every school's accounts. */
@Injectable()
export class PlatformJobs implements OnApplicationBootstrap {
  private readonly log = new Logger('PlatformJobs');

  constructor(
    private readonly tenancy: TenancyService,
    private readonly directory: LoginDirectory,
  ) {}

  onApplicationBootstrap() {
    setTimeout(() => void this.reconcileDirectory(), 30_000).unref?.();
  }

  /** Adds missing directory entries, removes those of deleted accounts and reports clashes between schools. */
  @Cron('20 3 * * *', { timeZone: 'Asia/Kolkata', name: 'login-directory-reconcile' })
  async reconcileDirectory() {
    let schools;
    try {
      schools = await this.tenancy.workspaces();
    } catch (err) {
      this.log.warn(`Sign-in directory not checked: ${(err as Error).message}`);
      return;
    }
    for (const ws of schools) {
      try {
        const users = await this.tenancy.withSchool(ws, () => this.tenancy.current().user.findMany({
          where: { NOT: { email: { endsWith: `.${SUPPORT_EMAIL_DOMAIN}` } } },
          select: { id: true, email: true, phone: true },
        }));
        const r = await this.directory.reconcileWorkspace(ws.id, users);
        if (r.added || r.removed) this.log.log(`${ws.code}: sign-in directory +${r.added} / -${r.removed}`);
      } catch (err) {
        this.log.warn(`${ws.code}: sign-in directory not checked — ${(err as Error).message}`);
      }
    }
  }
}

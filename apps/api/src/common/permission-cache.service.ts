import { Injectable } from '@nestjs/common';
import { PerWorkspace } from '../tenancy/context';
import { PrismaService } from './prisma.service';

/** Role → permission set, cached in memory per school and refreshed when a role changes. */
@Injectable()
export class PermissionCacheService {
  private readonly cache = new PerWorkspace(() => new Map<string, { perms: Set<string>; loadedAt: number }>());
  private readonly ttlMs = 60_000;

  constructor(private readonly prisma: PrismaService) {}

  async forRole(roleId: string): Promise<Set<string>> {
    const cache = this.cache.get();
    const hit = cache.get(roleId);
    if (hit && Date.now() - hit.loadedAt < this.ttlMs) return hit.perms;
    const rows = await this.prisma.rolePermission.findMany({ where: { roleId }, select: { permissionKey: true } });
    const perms = new Set(rows.map((r) => r.permissionKey));
    cache.set(roleId, { perms, loadedAt: Date.now() });
    return perms;
  }

  invalidate(roleId?: string) {
    const cache = this.cache.get();
    if (roleId) cache.delete(roleId);
    else cache.clear();
  }
}

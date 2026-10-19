import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/** Role → permission set, cached in memory and refreshed when a role changes. */
@Injectable()
export class PermissionCacheService {
  private cache = new Map<string, { perms: Set<string>; loadedAt: number }>();
  private readonly ttlMs = 60_000;

  constructor(private readonly prisma: PrismaService) {}

  async forRole(roleId: string): Promise<Set<string>> {
    const hit = this.cache.get(roleId);
    if (hit && Date.now() - hit.loadedAt < this.ttlMs) return hit.perms;
    const rows = await this.prisma.rolePermission.findMany({ where: { roleId }, select: { permissionKey: true } });
    const perms = new Set(rows.map((r) => r.permissionKey));
    this.cache.set(roleId, { perms, loadedAt: Date.now() });
    return perms;
  }

  invalidate(roleId?: string) {
    if (roleId) this.cache.delete(roleId);
    else this.cache.clear();
  }
}

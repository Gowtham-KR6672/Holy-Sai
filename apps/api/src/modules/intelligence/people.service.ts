import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { NotificationsService, type NotifyInput, type TaskInput } from '../notifications/notifications.service';

/** Who to tell: class teachers, owners, the front office and permission holders (user accounts). */
@Injectable()
export class IntelPeople {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async employeeNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (!list.length) return new Map();
    const rows = await this.prisma.employee.findMany({ where: { id: { in: list } }, select: { id: true, fullName: true } });
    return new Map(rows.map((e) => [e.id, e.fullName]));
  }

  /** Active user account of each employee. */
  async usersOfEmployees(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (!list.length) return new Map();
    const rows = await this.prisma.user.findMany({ where: { employeeId: { in: list }, status: 'active' }, select: { id: true, employeeId: true } });
    return new Map(rows.map((u) => [u.employeeId!, u.id]));
  }

  /** Class teacher's user account per section. */
  async classTeacherUsers(sectionIds: (string | null | undefined)[]): Promise<Map<string, string>> {
    const list = [...new Set(sectionIds.filter((x): x is string => !!x))];
    if (!list.length) return new Map();
    const sections = await this.prisma.section.findMany({ where: { id: { in: list } }, select: { id: true, classTeacherId: true } });
    const users = await this.usersOfEmployees(sections.map((s) => s.classTeacherId));
    const out = new Map<string, string>();
    for (const s of sections) if (s.classTeacherId && users.get(s.classTeacherId)) out.set(s.id, users.get(s.classTeacherId)!);
    return out;
  }

  /** Active users holding a permission (optionally on one campus, plus campus-less and group users). */
  async usersWithPermission(permission: string, campusId?: string | null, staffOnly = true): Promise<string[]> {
    const users = await this.prisma.user.findMany({
      where: {
        status: 'active',
        role: { permissions: { some: { permissionKey: permission } }, ...(staffOnly ? { key: { notIn: ['parent', 'student'] } } : {}) },
        ...(campusId ? { OR: [{ campusId }, { campusId: null }] } : {}),
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  /** The front office (Office role) for a campus; when there is none, staff who manage admissions. */
  async frontOffice(campusId?: string | null): Promise<string[]> {
    const office = await this.prisma.user.findMany({
      where: { status: 'active', role: { key: 'office' }, ...(campusId ? { OR: [{ campusId }, { campusId: null }] } : {}) },
      select: { id: true },
    });
    if (office.length) return office.map((u) => u.id);
    const managers = await this.usersWithPermission('admissions.manage', campusId);
    if (managers.length) return managers;
    return this.usersWithPermission('communication.send', campusId);
  }

  async notify(userIds: string[], input: NotifyInput) {
    await this.notifications.notifyUsers(userIds, input);
  }

  async tasks(userIds: string[], input: Omit<TaskInput, 'assigneeId'>) {
    for (const id of [...new Set(userIds)]) await this.notifications.createTask({ ...input, assigneeId: id });
  }
}

import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/** Atomic sequences for human-readable references such as T-551 or HS-2026-1077. */
@Injectable()
export class CountersService {
  constructor(private readonly prisma: PrismaService) {}

  async next(key: string, start = 1): Promise<number> {
    const row = await this.prisma.counter.upsert({
      where: { key },
      create: { key, value: start },
      update: { value: { increment: 1 } },
    });
    return row.value;
  }

  /** e.g. reference('T', 'tasks') -> "T-1"; reference('HS-2026', 'students-2026', 4, 1001) -> "HS-2026-1001". */
  async reference(prefix: string, key: string, pad = 0, start = 1): Promise<string> {
    const n = await this.next(key, start);
    return `${prefix}-${pad ? String(n).padStart(pad, '0') : n}`;
  }
}

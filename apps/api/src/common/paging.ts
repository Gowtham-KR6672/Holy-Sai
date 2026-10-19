import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Query parameters every list endpoint accepts: q, page, pageSize, sort, dir, campusId. */
export class ListQuery {
  @IsOptional() @IsString()
  q?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500)
  pageSize?: number;

  @IsOptional() @IsString()
  sort?: string;

  @IsOptional() @IsIn(['asc', 'desc'])
  dir?: 'asc' | 'desc';

  @IsOptional() @IsString()
  campusId?: string;
}

export function pageOf(q: { page?: number; pageSize?: number }, defaultSize = 25) {
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? defaultSize;
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/** Maps a public sort key to a Prisma orderBy, from an allow-list; unknown keys fall back. */
export function sortBy<T>(sort: string | undefined, dir: 'asc' | 'desc' | undefined, map: Record<string, (d: 'asc' | 'desc') => T>, fallback: string): T {
  const key = sort && map[sort] ? sort : fallback;
  return map[key](dir ?? 'asc');
}

/** Case-insensitive "contains" for Prisma string filters. */
export const like = (q: string) => ({ contains: q.trim(), mode: 'insensitive' as const });

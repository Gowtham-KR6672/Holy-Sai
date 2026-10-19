import { CallHandler, ExecutionContext, Injectable, NestInterceptor, StreamableFile } from '@nestjs/common';
import { map, type Observable } from 'rxjs';

/**
 * Every JSON response uses the envelope the web and mobile apps expect:
 *   { success: true, data, message, meta? }     meta = { page, pageSize, total, totalPages } for lists
 *   { success: false, message, error, details? } (see errors.ts)
 */
export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export class ApiResult<T> {
  constructor(
    public readonly data: T,
    public readonly message = 'OK',
    public readonly meta?: PageMeta,
  ) {}
}

/** A successful response with a message the app shows as a toast. */
export function ok<T>(data: T, message = 'OK'): ApiResult<T> {
  return new ApiResult(data, message);
}

/** A page of rows with paging meta. */
export function paged<T>(rows: T[], total: number, p: { page: number; pageSize: number }, message = 'OK'): ApiResult<T[]> {
  return new ApiResult(rows, message, {
    page: p.page,
    pageSize: p.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / p.pageSize)),
  });
}

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((value) => {
        if (value instanceof StreamableFile || Buffer.isBuffer(value)) return value;
        if (value instanceof ApiResult) {
          return { success: true, data: value.data ?? null, message: value.message, ...(value.meta ? { meta: value.meta } : {}) };
        }
        if (value && typeof value === 'object' && (value as { success?: unknown }).success !== undefined && 'data' in (value as object)) {
          return value;
        }
        return { success: true, data: value ?? null, message: 'OK' };
      }),
    );
  }
}

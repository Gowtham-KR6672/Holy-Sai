import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import type { ValidationError } from 'class-validator';
import type { Response } from 'express';

export interface FieldIssue {
  field: string;
  message: string;
}

/** An error with a machine code and, for forms, per-field messages. */
export class AppError extends HttpException {
  constructor(
    status: number,
    public readonly code: string,
    message: string,
    public readonly details?: FieldIssue[] | Record<string, unknown>,
  ) {
    super(message, status);
  }
}

export const badRequest = (message: string, details?: FieldIssue[]) => new AppError(400, details ? 'VALIDATION_ERROR' : 'BAD_REQUEST', message, details);
/** A form error on one field, shown next to that field. */
export const fieldError = (field: string, message: string) => new AppError(400, 'VALIDATION_ERROR', message, [{ field, message }]);
export const notFound = (what = 'Record') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const forbidden = (message = 'You do not have permission for this action') => new AppError(403, 'FORBIDDEN', message);
export const conflict = (message: string, details?: Record<string, unknown>) => new AppError(409, 'CONFLICT', message, details);
export const unavailable = (message: string) => new AppError(503, 'UNAVAILABLE', message);

const CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'TOO_LARGE',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
  503: 'UNAVAILABLE',
};

/** Builds the 400 response for class-validator failures. */
export function validationError(errors: ValidationError[]): AppError {
  const details: FieldIssue[] = [];
  const walk = (list: ValidationError[], prefix = '') => {
    for (const e of list) {
      const field = prefix ? `${prefix}.${e.property}` : e.property;
      const msgs = Object.values(e.constraints ?? {});
      if (msgs.length) details.push({ field, message: msgs[0] });
      if (e.children?.length) walk(e.children, field);
    }
  };
  walk(errors);
  return new AppError(400, 'VALIDATION_ERROR', details[0]?.message ?? 'Check the highlighted fields', details);
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('Error');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) return;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Something went wrong. Please try again.';
    let details: unknown;

    if (exception instanceof AppError) {
      status = exception.getStatus();
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof ThrottlerException) {
      status = 429;
      code = 'RATE_LIMITED';
      message = 'Too many requests. Please wait a moment and try again.';
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = CODES[status] ?? `HTTP_${status}`;
      const body = exception.getResponse();
      const m = typeof body === 'string' ? body : (body as { message?: string | string[] }).message;
      message = Array.isArray(m) ? m[0] : (m ?? exception.message);
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = 409;
        code = 'CONFLICT';
        const target = (exception.meta?.target as string[] | undefined)?.join(', ');
        message = target ? `A record with this ${target} already exists` : 'This record already exists';
      } else if (exception.code === 'P2025' || exception.code === 'P2023') {
        // P2023: a malformed id (e.g. not a UUID) in the URL — nothing can match it.
        status = 404;
        code = 'NOT_FOUND';
        message = 'Record not found';
      } else if (exception.code === 'P2003') {
        status = 409;
        code = 'CONFLICT';
        message = 'This record is linked to other records and cannot be changed this way';
      } else {
        this.log.error(exception.message);
      }
    } else {
      this.log.error(exception instanceof Error ? exception.stack ?? exception.message : String(exception));
    }

    res.status(status).json({ success: false, message, error: code, ...(details ? { details } : {}) });
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { today } from './ops.util';

export const CERTIFICATE_TYPES = ['Transfer certificate', 'Bonafide certificate', 'Conduct certificate', 'Study certificate', 'Achievement certificate'];

/** Prefix of the verification code for each certificate type, e.g. "BC-2026-1182". */
export const CODE_PREFIX: Record<string, string> = {
  'Transfer certificate': 'TC',
  'Bonafide certificate': 'BC',
  'Conduct certificate': 'CC',
  'Study certificate': 'SC',
  'Achievement certificate': 'AC',
};

export interface CertificateCheck {
  key: string;
  label: string;
  passed: boolean;
  /** Shown when the check fails, e.g. "₹12,400 outstanding". */
  detail: string;
  /** A failing blocking check stops approval and issue; others are advisory for the type. */
  blocking: boolean;
}

export type CertificateCheckProvider = (input: { studentId: string; certificateType: string }) => Promise<CertificateCheck | CertificateCheck[] | null>;

const TRANSFER = 'Transfer certificate';

/**
 * The automatic checks run before a certificate is approved or issued: enrolment, fee dues, student
 * documents and (for transfer certificates) clearance. Other modules can plug in their data with
 * register(): register('fees', fn) replaces the built-in fee check (Finance), and any other key adds a
 * clearance check (e.g. 'library').
 */
@Injectable()
export class CertificateChecksService {
  private readonly log = new Logger(CertificateChecksService.name);
  private readonly providers = new Map<string, CertificateCheckProvider>();
  private feeWarned = false;

  constructor(private readonly prisma: PrismaService) {}

  register(key: string, provider: CertificateCheckProvider) {
    this.providers.set(key, provider);
  }

  private async fromProvider(key: string, studentId: string, certificateType: string): Promise<CertificateCheck[] | null> {
    const p = this.providers.get(key);
    if (!p) return null;
    try {
      const r = await p({ studentId, certificateType });
      return r == null ? [] : Array.isArray(r) ? r : [r];
    } catch (err) {
      this.log.warn(`Certificate check '${key}' failed: ${(err as Error).message}`);
      return [{ key, label: key === 'fees' ? 'Fee dues cleared' : `${key[0].toUpperCase()}${key.slice(1)} clearance`, passed: false, detail: 'Could not be checked', blocking: false }];
    }
  }

  /**
   * Built-in fee check: overdue balances on the Finance ledger (FinanceCharge). Read with SQL so this
   * module does not depend on Finance's generated types; if the ledger is not available it passes.
   */
  private async feeCheck(studentId: string): Promise<CertificateCheck> {
    const base = { key: 'fees', label: 'Fee dues cleared' };
    try {
      const rows = await this.prisma.$queryRaw<{ due: string | null; n: bigint }[]>`
        SELECT COALESCE(SUM("balance"), 0)::text AS due, COUNT(*) AS n
        FROM "FinanceCharge"
        WHERE "studentId" = ${studentId}::uuid AND "balance" > 0 AND "dueDate" <= ${today()}::date`;
      const due = Number(rows[0]?.due ?? 0);
      const n = Number(rows[0]?.n ?? 0);
      if (due <= 0) return { ...base, passed: true, detail: 'No dues outstanding', blocking: true };
      return { ...base, passed: false, detail: `₹${Math.round(due).toLocaleString('en-IN')} outstanding on ${n} charge${n === 1 ? '' : 's'}`, blocking: true };
    } catch (err) {
      if (!this.feeWarned) {
        this.feeWarned = true;
        const reason = (err as Error).message.split(/\r?\n/).find((l) => l.trim()) ?? 'unknown error';
        this.log.warn(`Fee check unavailable (${reason.trim()}); passing it until the Finance ledger exists.`);
      }
      return { ...base, passed: true, detail: 'No fee ledger to check', blocking: true };
    }
  }

  async run(studentId: string, certificateType: string): Promise<CertificateCheck[]> {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      select: { id: true, status: true, transport: { select: { route: { select: { code: true, name: true } } } } },
    });
    if (!student) throw notFound('Student');
    const transfer = certificateType === TRANSFER;
    const checks: CertificateCheck[] = [];

    if (['Bonafide certificate', 'Study certificate', 'Conduct certificate'].includes(certificateType)) {
      const active = student.status === 'active';
      checks.push({
        key: 'enrolment',
        label: 'Currently enrolled',
        passed: active,
        detail: active ? 'Enrolled' : `Record is ${student.status}`,
        blocking: certificateType !== 'Conduct certificate',
      });
    }

    // Fee dues block a transfer certificate and are advisory for the others.
    const fees = (await this.fromProvider('fees', studentId, certificateType)) ?? [await this.feeCheck(studentId)];
    checks.push(...fees.map((c) => ({ ...c, blocking: transfer })));

    const docs = await this.prisma.opsDocument.findMany({ where: { studentId }, select: { status: true, expiresOn: true } });
    const t = today();
    const requested = docs.filter((d) => d.status === 'Pending').length;
    const toVerify = docs.filter((d) => d.status === 'Submitted').length;
    const rejected = docs.filter((d) => d.status === 'Rejected').length;
    const expired = docs.filter((d) => d.status === 'Expired' || (d.status === 'Verified' && d.expiresOn && d.expiresOn < t)).length;
    const gaps = [
      requested && `${requested} requested, not uploaded`,
      toVerify && `${toVerify} awaiting verification`,
      rejected && `${rejected} rejected`,
      expired && `${expired} expired`,
    ].filter(Boolean) as string[];
    checks.push({ key: 'documents', label: 'Student documents verified', passed: gaps.length === 0, detail: gaps.join(' · ') || 'Complete', blocking: transfer });

    if (transfer) {
      const route = student.transport?.route;
      checks.push({
        key: 'transport',
        label: 'Transport clearance',
        passed: !route,
        detail: route ? `Still assigned to route ${route.code} (${route.name})` : 'Not on a route',
        blocking: false,
      });
      for (const key of this.providers.keys()) {
        if (key === 'fees') continue;
        const extra = await this.fromProvider(key, studentId, certificateType);
        if (extra) checks.push(...extra);
      }
    }
    return checks;
  }
}

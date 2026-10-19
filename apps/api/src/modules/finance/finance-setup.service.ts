import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { like } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { CertificateChecksService } from '../operations/certificate-checks.service';
import { ParentsService } from '../parents/parents.service';
import { SearchService, type SearchHit } from '../search/search.service';
import { EXPENSE_CATEGORIES, FEE_HEADS, inr, num, r2, today } from './finance.util';
import { FinanceLedgerService } from './ledger.service';

/**
 * Seeds the finance reference catalogs (fee heads, expense categories), registers finance records in global
 * search, and plugs the ledger into other modules: children's fee status (ParentsService.registerFeeStatus)
 * and the certificate fee-clearance check (CertificateChecksService.register('fees')).
 */
@Injectable()
export class FinanceSetupService implements OnModuleInit {
  private readonly log = new Logger('Finance');

  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
    private readonly ledger: FinanceLedgerService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** A provider from another feature module, if that module is loaded (no module import, so no cycle). */
  private optional<T>(token: new (...args: never[]) => T): T | null {
    try {
      return this.moduleRef.get(token, { strict: false });
    } catch {
      return null;
    }
  }

  private wireOtherModules() {
    const parents = this.optional(ParentsService);
    parents?.registerFeeStatus(async (studentIds) => {
      const out = new Map<string, string>();
      for (const [id, s] of await this.ledger.accountSummaries(studentIds)) if (s.feeStatus !== 'No charges') out.set(id, s.feeStatus);
      return out;
    });

    const checks = this.optional(CertificateChecksService);
    checks?.register('fees', async ({ studentId, certificateType }) => {
      // A transfer certificate needs every due cleared; other certificates are blocked only by overdue fees.
      const transfer = certificateType === 'Transfer certificate';
      const open = await this.prisma.financeCharge.findMany({
        where: { studentId, balance: { gt: 0 }, ...(transfer ? {} : { dueDate: { lt: today() } }) },
        select: { balance: true },
      });
      const due = r2(open.reduce((s, c) => s + num(c.balance), 0));
      const base = { key: 'fees', label: 'Fee dues cleared', blocking: true };
      if (due <= 0) return { ...base, passed: true, detail: transfer ? 'No dues outstanding' : 'No overdue fees' };
      return { ...base, passed: false, detail: `${inr(due)} ${transfer ? 'outstanding' : 'overdue'} on ${open.length} charge${open.length === 1 ? '' : 's'}` };
    });
    this.log.log(`Finance hooks: parents fee status ${parents ? 'on' : 'unavailable'}, certificate fee check ${checks ? 'on' : 'unavailable'}`);
  }

  async onModuleInit() {
    this.wireOtherModules();
    this.search.register(async (user, q): Promise<SearchHit[]> => {
      if (!user.permissions.has('finance.read')) return [];
      const [payments, expenses, claims] = await Promise.all([
        this.prisma.financePayment.findMany({ where: { OR: [{ receiptNo: like(q) }, { gatewayRef: like(q) }] }, take: 4, orderBy: { paidAt: 'desc' } }),
        this.prisma.financeExpense.findMany({ where: { OR: [{ code: like(q) }, { description: like(q) }] }, take: 3, orderBy: { createdAt: 'desc' } }),
        this.prisma.financeReimbursement.findMany({ where: { code: like(q) }, take: 3, orderBy: { createdAt: 'desc' } }),
      ]);
      return [
        ...payments.map((p) => ({
          group: 'Finance', label: p.receiptNo ?? p.gatewayRef ?? 'Payment', meta: `${inr(num(p.amount))} · ${p.method} · ${p.status}`, icon: 'receipt',
          route: `/payments?q=${encodeURIComponent(p.receiptNo ?? p.gatewayRef ?? '')}`,
        })),
        ...expenses.map((e) => ({ group: 'Finance', label: `${e.code} · ${e.description}`, meta: `${inr(num(e.amount))} · ${e.status}`, icon: 'fileText', route: `/expenses?q=${encodeURIComponent(e.code)}` })),
        ...claims.map((r) => ({ group: 'Finance', label: `${r.code} · ${r.description}`, meta: `${inr(num(r.amount))} · ${r.status}`, icon: 'refresh', route: `/reimbursements?q=${encodeURIComponent(r.code)}` })),
      ];
    });
    await this.seedDefaults();
  }

  /** Idempotent: each catalog is filled only when it is empty. */
  async seedDefaults() {
    try {
      if ((await this.prisma.financeFeeHead.count()) === 0) {
        await this.prisma.financeFeeHead.createMany({ data: FEE_HEADS.map((name, i) => ({ name, sortOrder: i + 1 })), skipDuplicates: true });
        this.log.log('Seeded fee heads');
      }
      if ((await this.prisma.financeExpenseCategory.count()) === 0) {
        await this.prisma.financeExpenseCategory.createMany({ data: EXPENSE_CATEGORIES.map((name, i) => ({ name, sortOrder: i + 1 })), skipDuplicates: true });
        this.log.log('Seeded expense categories');
      }
    } catch (err) {
      // Tables not migrated yet; the catalogs are seeded on the next start.
      this.log.warn(`Finance catalogs not seeded: ${(err as Error).message.split('\n')[0]}`);
    }
  }
}

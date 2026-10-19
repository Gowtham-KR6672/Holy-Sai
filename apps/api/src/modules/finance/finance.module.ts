import { Module } from '@nestjs/common';
import { FinanceAllowancesController } from './allowances.controller';
import { FinanceBudgetsService } from './budgets.service';
import { FinanceConcessionsController } from './concessions.controller';
import { FinanceFeesController } from './fees.controller';
import { FinanceFeesService } from './fees.service';
import { FinanceSetupService } from './finance-setup.service';
import { FinanceLedgerService } from './ledger.service';
import { PaymentGatewayService } from './payment-gateway.service';
import { FinancePaymentsController } from './payments.controller';
import { FinancePayrollService } from './payroll-inputs.service';
import { FinanceReconciliationController } from './reconciliation.controller';
import { FinanceReportsController } from './reports.controller';
import { FinanceReportsService } from './reports.service';
import { FinanceSpendingController } from './spending.controller';

/**
 * Finance: fee structures, student ledgers, payments and receipts (counter and Razorpay), concessions and
 * scholarships, expenses, reimbursements, allowances, budgets, reconciliation and financial reports.
 *
 * Exported for other modules:
 *  - FinanceLedgerService: account(studentId), accountSummaries(ids), recordPayment(...), receipt(id), feeSnapshot(), pendingApprovals()
 *  - PaymentGatewayService: createOrder(...), verify(...), isConfigured()
 *  - FinancePayrollService: allowancesFor(...), reimbursementsFor(...), markReimbursementsPaid(...), payrollInputs(...)
 */
@Module({
  controllers: [
    FinanceFeesController,
    FinancePaymentsController,
    FinanceConcessionsController,
    FinanceSpendingController,
    FinanceAllowancesController,
    FinanceReconciliationController,
    FinanceReportsController,
  ],
  providers: [
    FinanceSetupService,
    FinanceLedgerService,
    FinanceFeesService,
    FinanceBudgetsService,
    PaymentGatewayService,
    FinancePayrollService,
    FinanceReportsService,
  ],
  exports: [FinanceLedgerService, PaymentGatewayService, FinancePayrollService],
})
export class FinanceModule {}

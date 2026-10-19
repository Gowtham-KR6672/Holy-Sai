/** Shapes returned by the finance API (/finance/*). Money values are plain numbers in rupees. */

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------
export interface FinanceLookups {
  feeHeads: { id: string; name: string }[];
  expenseCategories: string[];
  vendors: { id: string; name: string }[];
  employees: { id: string; code: string; fullName: string; department: string; category: string; employeeType: string; campusId: string }[];
  employeeCategories: string[];
  paymentMethods: string[];
}

// ---------------------------------------------------------------------------
// Fee structures
// ---------------------------------------------------------------------------
export interface StructureSummaryRow {
  campusId: string;
  campus: string;
  stage: string;
  fromGrade: number;
  toGrade: number;
  /** Annual amount per student (highest class in the stage). */
  tuition: number;
  transport: number;
  activities: number;
  terms: number;
  students: number;
  status: 'Active' | 'Draft' | 'Archived' | string;
}

export interface StructureRow {
  id: string;
  classId: string;
  class: string;
  stage: string;
  campusId: string;
  campus: string;
  feeHeadId: string;
  head: string;
  /** Term 1 | Term 2 | Term 3 | Annual */
  term: string;
  amount: number;
  dueDate: string;
  /** Student accounts this line has been raised on. */
  applied: number;
  status: 'Active' | 'Draft' | 'Archived' | string;
}

// ---------------------------------------------------------------------------
// Student accounts
// ---------------------------------------------------------------------------
export type FeeStatus = 'Paid' | 'Partial' | 'Pending' | 'Overdue' | 'No charges';

export interface AccountRow {
  id: string;
  fullName: string;
  admissionNo: string;
  grade: string | null;
  section: string | null;
  campus: string;
  campusId: string;
  /** Net of concessions. */
  billed: number;
  paid: number;
  balance: number;
  overdue: number;
  nextDue: string | null;
  feeStatus: FeeStatus | string;
}

export interface AccountLine {
  id: string;
  description: string;
  head: string;
  feeHeadId: string;
  amountDue: number;
  concession: number;
  amountPaid: number;
  balance: number;
  dueDate: string;
  /** Paid | Partial | Pending | Overdue | Waived */
  status: string;
  daysOverdue: number;
  /** Accrued late fee (days overdue × finance.late_fee_per_day), informational. */
  lateFee: number;
}

export interface Account {
  student: {
    id: string;
    fullName: string;
    admissionNo: string;
    grade: string | null;
    section: string | null;
    campus: string;
    campusId: string;
    parentName: string | null;
    parentPhone: string | null;
    status: string;
  };
  summary: {
    /** Gross billed this academic year (plus earlier outstanding charges). */
    billed: number;
    concession: number;
    paid: number;
    outstanding: number;
    overdue: number;
    nextDue: string | null;
    nextDueAmount: number;
    lateFee: number;
    lateFeePerDay: number;
  };
  lines: AccountLine[];
  payments: { id: string; receiptNo: string; amount: number; method: string; paidAt: string; status: string }[];
  concessions: { id: string; type: string; percent: number | null; amount: number; approvedBy: string | null; validUntil: string | null; status: string }[];
}

// ---------------------------------------------------------------------------
// Fee collection dashboard and reminders
// ---------------------------------------------------------------------------
export interface FeeDashboard {
  kpis: {
    billed: number;
    collected: number;
    collectionPct: number;
    collected30d: number;
    /** % change of the last 30 days' collection against the 30 days before; null without a baseline. */
    collected30dDelta: number | null;
    outstanding: number;
    outstandingAccounts: number;
    /** Outstanding more than 30 days past due. */
    overdue: number;
    overdueAccounts: number;
    /** Everything past due. */
    overdueAll: number;
    /** Instalments falling due for the rest of this month. */
    expected: number;
  };
  methods: { label: string; amount: number; pct: number }[];
  trend: { month: string; label: string; billed: number; collected: number }[];
  ageing: { label: string; value: number }[];
  byCampus: { campusId: string; label: string; collected: number; outstanding: number }[];
  byHead: { head: string; billed: number; collected: number }[];
  attention: {
    id: string;
    fullName: string;
    admissionNo: string;
    grade: string | null;
    section: string | null;
    campus: string;
    outstanding: number;
    overdue: number;
    ageDays: number;
    feeStatus: string;
  }[];
  academicYear: string;
  generatedAt: string;
}

export interface ReminderAudience {
  outstanding: number;
  overdue30: number;
  due7: number;
}

// ---------------------------------------------------------------------------
// Payments and receipts
// ---------------------------------------------------------------------------
export interface PaymentRow {
  id: string;
  receiptNo: string;
  gatewayRef: string | null;
  collectedBy: string | null;
  paidBy: string | null;
  studentId: string;
  studentName: string;
  admissionNo: string;
  grade: string | null;
  section: string | null;
  campus: string;
  amount: number;
  /** UPI | Card | Net Banking | Cash / DD */
  method: string;
  instrument: string;
  source: 'counter' | 'online' | string;
  paidAt: string;
  /** Success | Initiated | Failed | Refunded */
  status: string;
  failureReason: string | null;
  reconciled: boolean;
  delivery: 'Delivered' | 'Pending';
  receiptSentAt: string | null;
}

export interface PaymentSummary {
  collectedToday: number;
  transactionsToday: number;
  collected30d: number;
  failedOrPending: number;
  unreconciled: number;
  receiptsDelivered: number;
  receiptsPending: number;
}

export interface Receipt {
  id: string;
  receiptNo: string;
  status: string;
  amount: number;
  /** The instrument used: Cash, DD, Cheque, UPI, Card, Net Banking … */
  method: string;
  methodGroup: string;
  gatewayRef: string | null;
  paidAt: string;
  paidBy: string | null;
  collectedBy: string | null;
  receiptSentAt: string | null;
  delivery: 'Delivered' | 'Pending';
  academicYear: string | null;
  student: { id: string; fullName: string; admissionNo: string; grade: string | null; section: string | null; campus: string; campusShort: string };
  lines: { feeId: string; description: string; head: string; amount: number; balanceAfter: number }[];
}

// ---------------------------------------------------------------------------
// Concessions and scholarships
// ---------------------------------------------------------------------------
export interface ConcessionRow {
  id: string;
  studentId: string;
  studentName: string;
  admissionNo: string;
  grade: string | null;
  section: string | null;
  campus: string;
  type: string;
  reason: string | null;
  amount: number;
  percent: number | null;
  appliedAmount: number;
  /** Submitted | Under Review | Approved | Rejected */
  status: string;
  requestedBy: string | null;
  reviewedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  rejectionReason: string | null;
  validUntil: string | null;
  scholarshipId: string | null;
  scholarship: string | null;
  createdAt: string;
}

export interface ConcessionSummary {
  types: { type: string; students: number; value: number; pending: number }[];
  tuitionBilled: number;
  scholarships: { awards: number; value: number; underReview: number };
  academicYear: string;
}

export interface Scholarship {
  id: string;
  name: string;
  criteria: string | null;
  amount: number;
  seats: number;
  awarded: number;
  /** Open | Closed */
  status: string;
  createdAt: string;
  closedAt: string | null;
}

// ---------------------------------------------------------------------------
// Expenses and reimbursements
// ---------------------------------------------------------------------------
export interface ExpenseRow {
  id: string;
  code: string;
  campusId: string;
  campus: string;
  category: string;
  description: string;
  vendorId: string | null;
  vendor: string | null;
  amount: number;
  submittedById: string | null;
  raisedBy: string | null;
  expenseDate: string;
  /** Draft | Submitted | Under Review | Approved | Rejected | Paid */
  status: string;
  rejectionReason: string | null;
  reviewedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface ExpenseSummary {
  flow: {
    draft: number;
    submitted: number;
    underReview: number;
    approved: number;
    paid: number;
    rejected: number;
    approvedThisWeek: number;
    rejected30d: number;
    pendingValue: number;
  };
  byCategory: { label: string; value: number }[];
}

export interface ReimbursementRow {
  id: string;
  code: string;
  employeeId: string;
  employee: string;
  employeeCode: string | null;
  department: string;
  claimType: string;
  description: string;
  amount: number;
  claimDate: string;
  status: string;
  rejectionReason: string | null;
  reviewedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  /** YYYY-MM payroll month that pays the claim. */
  payrollMonth: string | null;
  paidVia: 'payroll' | 'manual' | string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface ReimbursementSummary {
  pending: number;
  pendingValue: number;
  approvedUnpaid: number;
  approvedCount: number;
  paidThisMonth: number;
  rejected: number;
}

// ---------------------------------------------------------------------------
// Allowances
// ---------------------------------------------------------------------------
export interface AllowanceSummaryRow {
  allowanceType: string;
  appliesTo: string;
  frequency: string;
  minAmount: number;
  maxAmount: number;
  pctOfBasic: number | null;
  employees: number;
  monthlyCost: number;
  pendingCount: number;
  pendingCost: number;
  /** Active | Proposed | Stopped | Rejected */
  status: string;
}

export interface AllowanceRow {
  id: string;
  allowanceType: string;
  employeeId: string;
  employee: string;
  employeeCode: string | null;
  category: string;
  department: string;
  appliesTo: string;
  mode: 'amount' | 'percent' | string;
  percentOfBasic: number | null;
  amount: number;
  frequency: string;
  effectiveMonth: string;
  endMonth: string | null;
  /** Submitted | Approved | Rejected | Stopped */
  status: string;
  proposedBy: string | null;
  decidedBy: string | null;
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------
export interface BudgetRow {
  /** Null for a category with spend but no budget line (or several campuses combined). */
  id: string | null;
  campusId: string | null;
  category: string;
  allocated: number;
  actual: number;
  committed: number;
  projected: number;
  variance: number;
  utilisation: number | null;
  owner: string | null;
}

export interface Budgets {
  kpis: {
    allocated: number;
    spent: number;
    committed: number;
    projected: number;
    projectedVariance: number;
    yearElapsedPct: number;
    overBudget: { category: string; variance: number } | null;
  };
  rows: BudgetRow[];
  academicYear: string;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------
export interface ReconSummary {
  latestDate: string | null;
  matchedLatest: number;
  settlementLatest: number;
  exceptions: number;
  unmatched: number;
  inTransit: number;
}

export interface ReconLine {
  id: string;
  statementDate: string;
  reference: string;
  channel: string;
  amount: number;
  /** Matched | Unmatched | Exception | Resolved */
  status: string;
  note: string | null;
  paymentId: string | null;
  receiptNo: string | null;
  studentName: string | null;
  settlementId: string | null;
  matchedBy: string | null;
  matchedAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
}

export interface ReconCandidate {
  id: string;
  receiptNo: string;
  gatewayRef: string | null;
  method: string;
  studentId: string;
  studentName: string;
  admissionNo: string;
  amount: number;
  amountDiff: number;
  paidAt: string;
  referenceMatch: boolean;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
export interface Report {
  key: string;
  title: string;
  sub: string;
  academicYear: string;
  campus: string | null;
  generatedAt: string;
  columns: { key: string; label: string; money?: boolean }[];
  rows: Record<string, unknown>[];
}

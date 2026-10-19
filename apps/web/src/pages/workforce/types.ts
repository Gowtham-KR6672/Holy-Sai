/** API shapes for the workforce module (employees, attendance, rosters, leave, overtime, workload, CPD, payroll). */

export type EmployeeType = 'teaching' | 'non_teaching';

/** Today's attendance status: Present | Late | Half Day | Absent | On Leave | Not marked. */
export type TodayStatus = string;

export type RunStatus = 'Draft' | 'Inputs' | 'Calculated' | 'Under Review' | 'Approved' | 'Released' | 'Paid';

export interface LabelValue {
  label: string;
  value: number;
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------
export interface EmployeeRow {
  id: string;
  code: string;
  fullName: string;
  designation: string;
  department: string;
  employeeType: EmployeeType;
  category: string;
  campusId: string;
  shift: string | null;
  today: TodayStatus;
  /** Days left across all leave types this year. */
  leaveBalance: number;
  /** Overtime hours this month. */
  overtime: number;
  /** Periods per week. */
  workload: number;
  /** CPD hours this year. */
  cpd: number;
}

export interface WorkforceSummary {
  kpis: {
    total: number;
    teaching: number;
    nonTeaching: number;
    present: number;
    late: number;
    halfDay: number;
    absent: number;
    leave: number;
    notMarked: number;
    uncoveredToday: number;
    openLeave: number;
    overtimeHours: number;
    overtimePending: number;
    payrollPending: number;
    cpdHours: number;
    avgWorkload: number | null;
  };
  journey: {
    joinedThisYear: number;
    active: number;
    openLeave: number;
    overtimeHours: number;
    pendingApprovals: number;
    currentRun: { id: string; payMonth: string; status: RunStatus } | null;
  };
  categories: LabelValue[];
  departments: string[];
}

export interface EmployeeDetail {
  id: string;
  code: string;
  fullName: string;
  gender: string | null;
  phone: string | null;
  email: string | null;
  campusId: string;
  campusName: string;
  campusFullName: string;
  department: string;
  designation: string;
  employeeType: EmployeeType;
  category: string;
  shift: string | null;
  joinDate: string | null;
  employmentStatus: 'active' | 'on_notice' | 'exited' | string;
  /** Only present for holders of payroll.read. */
  basicSalary?: number;
  bankAccount?: string | null;
  workload: number;
  maxPeriodsWeek: number;
  backgroundVerified: boolean;
  qualification: string | null;
  specialisation: string | null;
  licenceNoMasked: string | null;
  licenceExpiry: string | null;
  today: TodayStatus;
  leaveBalance: number;
  leaveEntitled: number;
  overtime: number;
  cpd: number;
  userLinked: boolean;
}

export interface FlowStep {
  label: string;
  meta?: string;
  state?: 'done' | 'active';
}

export interface EmployeeProfile {
  employee: EmployeeDetail;
  attendance: { pct: number | null; present: number; late: number; halfDay: number; absent: number; leave: number; marked: number };
  journey: FlowStep[];
  documents: { id: string; name: string; status: string }[];
  leaveBalances: LeaveBalance[];
  leaveRequests: (LeaveRow & { type: string })[];
  overtime: OvertimeRow[];
  cpd: CpdRecord[];
  roster: { id: string; date: string; post: string; shift: string; status: string; coveredBy: string | null }[];
  payslips: { id: string; runId: string; payMonth: string; monthLabel: string; gross: number; net: number; status: string }[];
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------
export interface AttendanceCounts {
  total: number;
  present: number;
  late: number;
  halfDay: number;
  absent: number;
  leave: number;
  notMarked: number;
}

export interface AttendanceSummary {
  date: string;
  counts: AttendanceCounts;
  /** Daily present % (leave excluded), oldest first. */
  trend: { date: string; present: number }[];
  byDepartment: { label: string; value: number | null }[];
  byShift: { shift: string; expected: number; present: number; absent: number; uncovered: number }[];
  months: LabelValue[];
}

export interface AttendanceRow {
  id: string;
  code: string;
  fullName: string;
  designation: string;
  department: string;
  employeeType: EmployeeType;
  shift: string | null;
  post: string | null;
  checkIn: string | null;
  checkOut: string | null;
  status: TodayStatus;
  /** biometric | app | manual | leave */
  source: string | null;
  rosterId: string | null;
  rosterStatus: string | null;
  coveredBy: string | null;
}

// ---------------------------------------------------------------------------
// Shifts and rosters
// ---------------------------------------------------------------------------
export interface Shift {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  splitStartsAt: string | null;
  splitEndsAt: string | null;
  employees: number;
  rosteredToday: number;
}

export interface RosterEntry {
  id: string;
  employeeId: string;
  employeeName: string;
  designation: string;
  employeeType: EmployeeType;
  date: string;
  group: string;
  duty: string | null;
  post: string;
  shiftId: string;
  shiftName: string;
  /** Scheduled | Cover needed | Covered | Completed */
  status: string;
  attendance: string | null;
  coveredById: string | null;
  coveredByName: string | null;
  published: boolean;
}

export interface Roster {
  weekStart: string;
  today: string;
  days: string[];
  groups: string[];
  entries: RosterEntry[];
  gaps: RosterEntry[];
  attention: RosterEntry[];
  published: boolean;
}

export interface MyRosterDay {
  date: string;
  shift: string | null;
  group: string | null;
  duty: string | null;
  onLeave: boolean;
  attendance: string | null;
  rosterStatus: string | null;
}

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------
export interface LeaveType {
  id: string;
  code: string;
  name: string;
  entitlementDays: number;
  isPaid: boolean;
}

export interface LeaveBalance {
  leaveTypeId: string;
  code: string;
  type: string;
  entitled: number;
  used: number;
  pending: number;
  balance: number;
}

export interface LeaveRow {
  id: string;
  code: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  employeeType: EmployeeType;
  designation: string;
  leaveTypeId: string;
  leaveType: string;
  fromDate: string;
  toDate: string;
  halfDay: boolean;
  days: number;
  reason: string | null;
  coverArrangement: string | null;
  status: string;
  /** Days left of this leave type. */
  balance: number;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export interface LeaveSummary {
  counts: { submitted: number; underReview: number; approvedThisWeek: number; noCover: number };
  types: { id: string; name: string }[];
  byMonth: LabelValue[];
  typeMix: LabelValue[];
  totalDays: number;
}

// ---------------------------------------------------------------------------
// Overtime
// ---------------------------------------------------------------------------
export interface OvertimeRow {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  designation: string;
  department: string;
  workDate: string;
  hours: number;
  reason: string;
  rate: number;
  cost: number;
  status: string;
  decidedBy: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export interface OvertimeSummary {
  kpis: { hours: number; employees: number; approvedHours: number; pendingCount: number; pendingHours: number; cost: number };
  byDepartment: LabelValue[];
  trend: LabelValue[];
}

// ---------------------------------------------------------------------------
// Workload and CPD
// ---------------------------------------------------------------------------
export interface WorkloadRow {
  id: string;
  fullName: string;
  designation: string;
  department: string;
  category: string;
  campusName: string;
  sections: number;
  assigned: number;
  timetabled: number;
  recorded: number;
  periods: number;
  max: number;
  band: 'over' | 'near' | 'ok';
}

export interface Workload {
  kpis: { teachers: number; average: number; over: number; near: number };
  rows: WorkloadRow[];
  suggestions: { employeeId: string; text: string }[];
}

export interface CpdRecord {
  id: string;
  programme: string;
  provider: string | null;
  hours: number;
  completedOn: string | null;
  status: string;
  isMandatory: boolean;
}

export interface CpdRow {
  id: string;
  code: string;
  fullName: string;
  designation: string;
  department: string;
  employeeType: EmployeeType;
  hours: number;
  target: number;
  mandatoryComplete: boolean;
  planned: number;
}

export interface CpdSummary {
  kpis: {
    hoursLogged: number;
    avgPerTeacher: number | null;
    targetTeaching: number;
    targetNonTeaching: number;
    belowTarget: number;
    mandatoryPct: number | null;
    mandatoryOutstanding: number;
  };
  upcoming: { programme: string; status: string; staff: number; hours: number }[];
}

// ---------------------------------------------------------------------------
// Payroll and payslips
// ---------------------------------------------------------------------------
export interface PayrollRun {
  id: string;
  campusId: string;
  campusName: string | null;
  payMonth: string;
  monthLabel: string;
  status: RunStatus;
  employeeCount: number;
  gross: number;
  deductions: number;
  net: number;
  overtime: number;
  allowances: number;
  reimbursements: number;
  createdAt: string;
  calculatedBy: string | null;
  calculatedAt: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  reviewNote: string | null;
  releasedAt: string | null;
  releasedSlips: number;
  paidAt: string | null;
}

export interface RunInputs {
  pendingCount: number;
  pendingItems: { what: string; count: number; value: number }[];
  attendance: { marked: number; lastMarked: string | null; absentDays: number; halfDays: number };
  leave: { approvedDays: number; requests: number };
  overtime: { hours: number; value: number; items: number };
  allowances: { approved: number; items: number };
  reimbursements: { approved: number; items: number };
}

export interface RunDetail {
  run: PayrollRun;
  stages: RunStatus[];
  stage: number;
  actions: {
    canPrepare: boolean;
    canSubmit: boolean;
    canApprove: boolean;
    makerChecker: boolean;
    canReturn: boolean;
    canRelease: boolean;
    canPay: boolean;
  };
  inputs: RunInputs | null;
  byCategory: { label: string; count: number; gross: number; net: number }[];
}

export interface PayslipRow {
  id: string;
  runId: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  designation: string;
  department: string;
  employeeType: EmployeeType;
  /** Draft | Released */
  status: string;
  previousStatus: string | null;
  gross: number;
  net: number;
}

export interface Payslip {
  id: string;
  runId: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  designation: string;
  department: string;
  employeeType: EmployeeType;
  joinDate: string | null;
  campusName: string | null;
  campusAddress: string | null;
  payMonth: string;
  monthLabel: string;
  monthEnd: string;
  earnings: { label: string; amount: number }[];
  deductions: { label: string; amount: number }[];
  gross: number;
  totalDeductions: number;
  net: number;
  workingDays: number;
  daysWorked: number;
  leaveDays: number;
  lopDays: number;
  overtimeHours: number;
  paymentDate: string | null;
  bankAccount: string | null;
  status: string;
  runStatus: RunStatus;
}

// ---------------------------------------------------------------------------
// Staff self-service
// ---------------------------------------------------------------------------
export interface MyEmployee {
  today: string;
  employee: EmployeeDetail & { checkIn: string | null; checkOut: string | null };
  shift: { id: string; name: string; startsAt: string; endsAt: string } | null;
  rosterToday: { id: string; group: string; duty: string | null; shiftName: string; status: string } | null;
  overtime: { hours: number; pending: number };
  lastPayslip: { id: string; monthLabel: string; net: number } | null;
}

export interface TaskRow {
  id: string;
  code: string;
  title: string;
  module: string;
  dueOn: string | null;
  priority: 'High' | 'Medium' | 'Low' | string;
  status: string;
  overdue: boolean;
  route: string | null;
}

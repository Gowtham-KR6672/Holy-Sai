import type { AuthUser } from '../../common/auth-user';

export type ReportGroup = 'Students' | 'Academics' | 'Operations' | 'Management' | 'System';
export type ReportFilter = 'date' | 'range';

export interface ReportDef {
  key: string;
  group: ReportGroup;
  title: string;
  description: string;
  /** Any one of these permissions makes the report available. */
  requires: string[];
  /** …and all of these as well. */
  alsoRequires?: string[];
  /** Platform reports: listed and run for Super Admin only. */
  restricted?: boolean;
  filters: ReportFilter[];
  /** Default window for the range filter: days back from today, or the academic year. */
  defaultRange?: number | 'year';
  /** Default end of the range: today, or the end of the academic year (to include what is already planned). */
  defaultTo?: 'today' | 'yearEnd';
}

/**
 * The standard reports. The catalog lives in code (the UI cannot create reports); every report is built
 * from live records by ReportsService with the same definition for the on-screen preview and the CSV.
 * Financial statements stay on Finance › Financial Reports (/finance/reports/:key) and are not repeated here.
 */
export const REPORTS: ReportDef[] = [
  // Students
  {
    key: 'student-register', group: 'Students', title: 'Student register',
    description: 'Every student on roll with class, campus, admission details and primary guardian.',
    requires: ['students.read'], filters: [],
  },
  {
    key: 'attendance-daily', group: 'Students', title: 'Daily attendance by class',
    description: 'Present, late, absent and on leave for each class on a date, with who saved the register.',
    requires: ['attendance.read', 'attendance.mark'], filters: ['date'],
  },
  {
    key: 'attendance-low', group: 'Students', title: 'Attendance below threshold',
    description: 'Students whose attendance this academic year is under the Early Warning threshold.',
    requires: ['attendance.read'], alsoRequires: [], filters: [],
  },
  {
    key: 'students-at-risk', group: 'Students', title: 'Students needing attention',
    description: 'Students in the At Risk and Developing Risk bands with attendance, results and open signals.',
    requires: ['earlywarning.read', 'students.read'], filters: [],
  },
  // Academics
  {
    key: 'assessment-results', group: 'Academics', title: 'Assessment results',
    description: 'Every assessment in the period with marks entered, average, highest, lowest and results below the pass mark.',
    requires: ['academics.read', 'assessments.manage'], filters: ['range'], defaultRange: 'year',
  },
  {
    key: 'class-performance', group: 'Academics', title: 'Class performance',
    description: 'Average score, attendance and students needing attention for every class this academic year.',
    requires: ['academics.read'], filters: [],
  },
  {
    key: 'homework-completion', group: 'Academics', title: 'Homework completion',
    description: 'Homework due in the period with submissions, late hand-ins and the completion rate.',
    requires: ['academics.read', 'academics.manage'], filters: ['range'], defaultRange: 30,
  },
  {
    key: 'lesson-plan-status', group: 'Academics', title: 'Lesson plan status',
    description: 'Lesson plans by teacher: drafts, waiting for review, approved and returned.',
    requires: ['academics.read', 'academics.manage'], filters: [],
  },
  // Operations
  {
    key: 'safety-log', group: 'Operations', title: 'Safety incident log',
    description: 'Incidents and safeguarding concerns in the period with severity, status, owner and closure.',
    requires: ['safety.read', 'safety.manage'], filters: ['range'], defaultRange: 90,
  },
  {
    key: 'visitor-log', group: 'Operations', title: 'Visitor log',
    description: 'Visitors in the period with purpose, host, arrival, departure and time on site.',
    requires: ['safety.read', 'safety.manage'], filters: ['range'], defaultRange: 30,
  },
  {
    key: 'transport-routes', group: 'Operations', title: 'Transport routes and occupancy',
    description: 'Every route with its bus, crew, stops, students assigned, seat occupancy and today’s run.',
    requires: ['transport.read', 'transport.manage'], filters: [],
  },
  {
    key: 'staff-attendance', group: 'Operations', title: 'Staff attendance',
    description: 'Every staff member’s attendance on a date: status, check-in, check-out and source.',
    requires: ['hr.read'], filters: ['date'],
  },
  {
    key: 'maintenance-open', group: 'Operations', title: 'Open maintenance requests',
    description: 'Maintenance requests not yet completed, with priority, age and estimated cost.',
    requires: ['operations.read', 'operations.manage'], filters: [],
  },
  {
    key: 'compliance-calendar', group: 'Operations', title: 'Compliance calendar',
    description: 'Statutory and safety requirements with authority, owner, due date and completion this year.',
    requires: ['operations.read', 'operations.manage'], filters: [],
  },
  // Management
  {
    key: 'admissions-funnel', group: 'Management', title: 'Admissions funnel by source',
    description: 'Enquiries in the period by source, how far they progressed, conversion and cost per admission.',
    requires: ['admissions.read', 'admissions.manage'], filters: ['range'], defaultRange: 'year',
  },
  {
    key: 'fee-defaulters', group: 'Management', title: 'Overdue fee accounts',
    description: 'Families with fees past due: overdue and total outstanding, oldest due date and days overdue.',
    requires: ['finance.read'], filters: [],
  },
  {
    key: 'staff-summary', group: 'Management', title: 'Staff by department',
    description: 'Headcount by campus and department, teaching and non-teaching, present today, workload and checks.',
    requires: ['hr.read'], filters: [],
  },
  {
    key: 'leave-register', group: 'Management', title: 'Leave register',
    description: 'Leave requests in the period with type, days, status and who decided.',
    requires: ['hr.read', 'hr.approve'], filters: ['range'], defaultRange: 'year', defaultTo: 'yearEnd',
  },
  {
    key: 'pending-approvals', group: 'Management', title: 'Pending approvals',
    description: 'Every request waiting on a decision — expenses, concessions, reimbursements, allowances, leave, overtime and payroll.',
    requires: ['finance.approve', 'hr.approve', 'payroll.approve', 'audit.read'], filters: [],
  },
  {
    key: 'campus-summary', group: 'Management', title: 'Campus summary',
    description: 'Headline figures campus by campus: students, staff, attendance, fee collection, admissions and incidents.',
    requires: ['group.read', 'dashboard.group'], filters: [],
  },
  // System (Super Admin only)
  {
    key: 'user-access', group: 'System', title: 'User accounts and access',
    description: 'Every sign-in account with role, campus, status, last sign-in, failed attempts and locks.',
    requires: ['users.manage'], restricted: true, filters: [],
  },
  {
    key: 'sign-in-activity', group: 'System', title: 'Sign-in activity',
    description: 'Sign-ins, failed sign-ins and sign-outs in the period, with address and device.',
    requires: ['users.manage', 'audit.read'], restricted: true, filters: ['range'], defaultRange: 30,
  },
  {
    key: 'role-matrix', group: 'System', title: 'Role and permission matrix',
    description: 'Every permission against every role, with the accounts holding each role.',
    requires: ['users.manage'], restricted: true, filters: [],
  },
  {
    key: 'audit-trail', group: 'System', title: 'Audit trail',
    description: 'Every recorded action in the period: who, what, which record, from where.',
    requires: ['audit.read'], restricted: true, filters: ['range'], defaultRange: 7,
  },
];

export const isSuperAdmin = (user: AuthUser) => user.roleKey === 'super_admin';

/** Reports this user may see listed (platform reports only for Super Admin). */
export function visibleReports(user: AuthUser): ReportDef[] {
  return REPORTS.filter((r) => !r.restricted || isSuperAdmin(user));
}

export function available(user: AuthUser, r: ReportDef): boolean {
  return r.requires.some((p) => user.permissions.has(p)) && (r.alsoRequires ?? []).every((p) => user.permissions.has(p));
}

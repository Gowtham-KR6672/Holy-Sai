// The 61 permissions, in the order the Users & Roles screen lists them.
// Keys match the original Holy Sai Smart School 360 build.

export interface PermissionDef {
  key: string;
  area: string;
  label: string;
}

export const PERMISSIONS = [
  { key: 'academics.manage', area: 'ACADEMICS', label: 'Manage curriculum, timetable, lesson plans and homework' },
  { key: 'academics.read', area: 'ACADEMICS', label: 'View curriculum, timetable, assessments and report cards' },
  { key: 'admissions.manage', area: 'ADMISSIONS', label: 'Manage enquiries, follow-ups and applications' },
  { key: 'admissions.read', area: 'ADMISSIONS', label: 'View enquiries, follow-ups and applications' },
  { key: 'ai.use', area: 'AI', label: 'Use the AI Teacher Co-Pilot and School Knowledge AI' },
  { key: 'assessments.manage', area: 'ASSESSMENTS', label: 'Create assessments and enter marks' },
  { key: 'attendance.mark', area: 'ATTENDANCE', label: 'Mark student attendance' },
  { key: 'attendance.read', area: 'ATTENDANCE', label: 'View student attendance' },
  { key: 'audit.read', area: 'AUDIT', label: 'View the audit trail' },
  { key: 'communication.read', area: 'COMMUNICATION', label: 'View parent communication, circulars, PTM and events' },
  { key: 'communication.send', area: 'COMMUNICATION', label: 'Send messages and publish circulars and events' },
  { key: 'crm.manage', area: 'CRM', label: 'Manage alumni, vendors and partners' },
  { key: 'crm.read', area: 'CRM', label: 'View alumni, vendors and partners' },
  { key: 'dashboard.group', area: 'DASHBOARD', label: 'View the multi-campus group dashboard' },
  { key: 'dashboard.view', area: 'DASHBOARD', label: 'View the dashboard for your role' },
  { key: 'documents.manage', area: 'DOCUMENTS', label: 'Upload, verify and issue documents and certificates' },
  { key: 'documents.read', area: 'DOCUMENTS', label: 'View documents and certificates' },
  { key: 'earlywarning.manage', area: 'EARLYWARNING', label: 'Review and act on Early Warning signals' },
  { key: 'earlywarning.read', area: 'EARLYWARNING', label: 'View Early Warning signals' },
  { key: 'fees.pay_own', area: 'FEES', label: 'View and pay your own children’s fees' },
  { key: 'finance.approve', area: 'FINANCE', label: 'Approve expenses, concessions and reimbursements' },
  { key: 'finance.manage', area: 'FINANCE', label: 'Record payments, raise fees, manage concessions and expenses' },
  { key: 'finance.read', area: 'FINANCE', label: 'View fees, payments and financial reports' },
  { key: 'group.manage', area: 'GROUP', label: 'Manage transfers and group policies' },
  { key: 'group.read', area: 'GROUP', label: 'View campuses and campus comparison' },
  { key: 'hr.approve', area: 'HR', label: 'Approve leave, overtime and allowances' },
  { key: 'hr.manage', area: 'HR', label: 'Manage employee records, shifts, leave and CPD' },
  { key: 'hr.read', area: 'HR', label: 'View employee records, attendance and leave' },
  { key: 'innovation.manage', area: 'INNOVATION', label: 'Manage ideas, projects, milestones and competitions' },
  { key: 'innovation.read', area: 'INNOVATION', label: 'View the Innovation Lab' },
  { key: 'notifications.broadcast', area: 'NOTIFICATIONS', label: 'Send school-wide notifications and emergency alerts' },
  { key: 'operations.manage', area: 'OPERATIONS', label: 'Manage assets, facilities, maintenance, inventory and compliance' },
  { key: 'operations.read', area: 'OPERATIONS', label: 'View assets, facilities, maintenance, inventory and compliance' },
  { key: 'parent_portal.use', area: 'PARENT_PORTAL', label: 'Use the Parent 360 portal' },
  { key: 'parents.manage', area: 'PARENTS', label: 'Create and update parent records' },
  { key: 'parents.read', area: 'PARENTS', label: 'View the parent directory' },
  { key: 'payroll.approve', area: 'PAYROLL', label: 'Approve and release payroll' },
  { key: 'payroll.manage', area: 'PAYROLL', label: 'Prepare payroll runs' },
  { key: 'payroll.read', area: 'PAYROLL', label: 'View payroll runs and payslips' },
  { key: 'prototype.view', area: 'PROTOTYPE', label: 'View demo and hand-off tools (Day in the Life, Automations, Design System)' },
  { key: 'reports.read', area: 'REPORTS', label: 'View analytics and reports' },
  { key: 'safety.manage', area: 'SAFETY', label: 'Record gate, visitor, pickup and incident events' },
  { key: 'safety.read', area: 'SAFETY', label: 'View gate, visitor, pickup, infirmary and incident records' },
  { key: 'selfservice.use', area: 'SELFSERVICE', label: 'Use staff self-service (own attendance, leave, payslips)' },
  { key: 'settings.manage', area: 'SETTINGS', label: 'Manage system settings' },
  { key: 'student_portal.use', area: 'STUDENT_PORTAL', label: 'Use the student portal' },
  { key: 'students.create', area: 'STUDENTS', label: 'Create student records' },
  { key: 'students.archive', area: 'STUDENTS', label: 'Archive (soft delete) student records' },
  { key: 'students.read', area: 'STUDENTS', label: 'View all student records' },
  { key: 'students.read_assigned', area: 'STUDENTS', label: 'View students in your assigned classes' },
  { key: 'students.sensitive', area: 'STUDENTS', label: 'View wellbeing, counselling and medical notes' },
  { key: 'students.update', area: 'STUDENTS', label: 'Update student records' },
  { key: 'tracking.history', area: 'TRACKING', label: 'View student location history' },
  { key: 'tracking.manage', area: 'TRACKING', label: 'Enable, pause or disable tracking for a student' },
  { key: 'tracking.read_all', area: 'TRACKING', label: 'View the current location of any student' },
  { key: 'tracking.read_assigned', area: 'TRACKING', label: 'View the current location of students in your classes' },
  { key: 'tracking.read_own_children', area: 'TRACKING', label: 'View the location of your own children' },
  { key: 'tracking.ingest', area: 'TRACKING', label: 'Record student locations (devices and integrations)' },
  { key: 'transport.manage', area: 'TRANSPORT', label: 'Manage routes and confirm boarding' },
  { key: 'transport.read', area: 'TRANSPORT', label: 'View routes, buses and boarding' },
  { key: 'users.manage', area: 'USERS', label: 'Manage user accounts and roles' },
] as const satisfies readonly PermissionDef[];

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

export const ALL_PERMISSION_KEYS: PermissionKey[] = PERMISSIONS.map((p) => p.key);

/** True when the holder has at least one of the required permissions (an empty list always passes). */
export function hasAnyPermission(held: Iterable<string>, required?: string | readonly string[]): boolean {
  if (!required) return true;
  const list = typeof required === 'string' ? [required] : required;
  if (list.length === 0) return true;
  const set = held instanceof Set ? (held as Set<string>) : new Set(held);
  return list.some((p) => set.has(p));
}

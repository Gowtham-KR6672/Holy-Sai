// Sidebar and mobile navigation, mirroring the original build's menu configuration.
import type { IconName } from './icons';
import type { RoleKey } from './roles';

export type Hue = 'brand' | 'blue' | 'plum' | 'rose' | 'terracotta' | 'sage' | 'amber' | 'steel' | 'teal' | 'indigo';

export interface NavItem {
  label: string;
  icon: IconName;
  to: string;
  /** Any one of these permissions shows the item. */
  perm?: string[];
  /** Only these roles see the item. */
  roles?: RoleKey[];
  /** These roles never see the item. */
  hideRoles?: RoleKey[];
  badge?: 'alerts' | 'tasks';
  tone?: 'alert' | 'amber';
  /** The item points at the signed-in role's own home page. */
  dynamicHome?: boolean;
}

export interface NavGroup {
  /** Section heading the group sits under (none for the top Overview group). */
  section?: string;
  group: string;
  /** Collapsible group label shown in the sidebar (defaults to group). */
  label?: string;
  hue: Hue;
  icon: IconName;
  /** Pinned shortcuts shown under the group when it is collapsed. */
  quick?: { to: string; label?: string }[];
  items: NavItem[];
}

const ADMIN_HIDE: RoleKey[] = ['super_admin', 'school_admin', 'principal'];
const STUDENTS_READ = ['students.read', 'students.read_assigned'];
const TRACKING_READ = ['tracking.read_all', 'tracking.read_assigned'];
const TRACKING_MANAGE = ['tracking.read_all', 'tracking.manage'];

export const SECTION_ORDER = [
  'Student Management',
  'Admissions',
  'Finance',
  'HR & Workforce',
  'Transport & Safety',
  'Operations',
  'Insights & Innovation',
  'Administration',
] as const;

export const NAV: NavGroup[] = [
  {
    group: 'Overview',
    hue: 'brand',
    icon: 'grid',
    items: [
      { label: 'Dashboard', icon: 'home', to: '/command-center', dynamicHome: true },
      { label: 'Owner Overview', icon: 'shield', to: '/overview', perm: ['audit.read'], roles: ['super_admin', 'school_admin'] },
      { label: 'Command Center', icon: 'pulse', to: '/command-center', perm: ['dashboard.group'] },
      { label: 'Teacher Dashboard', icon: 'bookOpen', to: '/teacher', perm: ['attendance.mark'], hideRoles: ADMIN_HIDE },
      { label: 'Parent 360', icon: 'heart', to: '/parent-360', perm: ['parent_portal.use'], hideRoles: ADMIN_HIDE },
      { label: 'My Profile', icon: 'user', to: '/my-profile', perm: ['student_portal.use'], hideRoles: ADMIN_HIDE },
      { label: 'Staff Self-Service', icon: 'idCard', to: '/staff-self', perm: ['selfservice.use'], hideRoles: ADMIN_HIDE },
      { label: 'Notifications', icon: 'bell', to: '/notifications', badge: 'alerts', tone: 'alert' },
      { label: 'My Tasks', icon: 'checkSquare', to: '/my-tasks', badge: 'tasks' },
    ],
  },
  {
    section: 'Student Management',
    group: 'Student Management',
    label: 'Students',
    hue: 'brand',
    icon: 'users',
    quick: [{ to: '/student-360' }, { to: '/attendance' }],
    items: [
      { label: 'Students', icon: 'users', to: '/students', perm: STUDENTS_READ },
      { label: 'Student 360', icon: 'user', to: '/student-360', perm: STUDENTS_READ },
      { label: 'Student Tracking', icon: 'mapPin', to: '/student-tracking', perm: TRACKING_READ },
      { label: 'Attendance', icon: 'checkSquare', to: '/attendance', perm: ['attendance.read'] },
      { label: 'Academic Performance', icon: 'trending', to: '/academic-performance', perm: STUDENTS_READ },
      { label: 'Assessments', icon: 'clipboard', to: '/assessments', perm: ['academics.read'] },
      { label: 'Behaviour & Wellbeing', icon: 'heart', to: '/wellbeing', perm: STUDENTS_READ },
      { label: 'Student Portfolio', icon: 'folder', to: '/portfolio', perm: STUDENTS_READ },
      { label: 'Talent Discovery', icon: 'sparkle', to: '/talent', perm: [...STUDENTS_READ, 'ai.use'] },
      { label: 'Early Warning', icon: 'alert', to: '/early-warning', perm: ['earlywarning.read'], tone: 'alert' },
    ],
  },
  {
    section: 'Admissions',
    group: 'Admissions & CRM',
    label: 'Enquiries & Admissions',
    hue: 'blue',
    icon: 'target',
    quick: [{ to: '/pipeline', label: 'Counselling' }, { to: '/applications' }],
    items: [
      { label: 'Admissions Dashboard', icon: 'target', to: '/admissions', perm: ['admissions.read'] },
      { label: 'Leads', icon: 'list', to: '/leads', perm: ['admissions.read'] },
      { label: 'Enquiries', icon: 'message', to: '/enquiries', perm: ['admissions.read'] },
      { label: 'Counselling Pipeline', icon: 'layers', to: '/pipeline', perm: ['admissions.read'] },
      { label: 'Applications', icon: 'fileText', to: '/applications', perm: ['admissions.read'] },
      { label: 'Campus Visits', icon: 'mapPin', to: '/visits', perm: ['admissions.read'] },
      { label: 'Conversion Analytics', icon: 'percent', to: '/conversion', perm: ['admissions.read'] },
      { label: 'Parent Referrals', icon: 'link', to: '/referrals', perm: ['admissions.read'] },
      { label: 'Alumni', icon: 'graduation', to: '/alumni', perm: ['crm.read'] },
      { label: 'Vendors & Partners', icon: 'briefcase', to: '/vendors', perm: ['crm.read'] },
    ],
  },
  {
    section: 'Student Management',
    group: 'Academics',
    hue: 'plum',
    icon: 'book',
    quick: [{ to: '/report-cards' }],
    items: [
      { label: 'Curriculum', icon: 'bookOpen', to: '/curriculum', perm: ['academics.read'] },
      { label: 'Classes', icon: 'grid', to: '/classes', perm: ['academics.read'] },
      { label: 'Subjects', icon: 'book', to: '/subjects', perm: ['academics.read'] },
      { label: 'Timetable', icon: 'calendar', to: '/timetable', perm: ['academics.read'] },
      { label: 'Lesson Plans', icon: 'clipboard', to: '/lesson-plans', perm: ['academics.read'] },
      { label: 'Homework', icon: 'edit', to: '/homework', perm: ['academics.read'] },
      { label: 'Question Bank', icon: 'helpCircle', to: '/question-bank', perm: ['academics.read'] },
      { label: 'Assessments', icon: 'checkSquare', to: '/assessments', perm: ['academics.read'] },
      { label: 'Paper Correction', icon: 'scan', to: '/paper-correction', perm: ['assessments.manage'] },
      { label: 'Report Cards', icon: 'fileText', to: '/report-cards', perm: ['academics.read'] },
      { label: 'Cambridge Objectives', icon: 'target', to: '/objectives', perm: ['academics.read'] },
    ],
  },
  {
    section: 'Student Management',
    group: 'Parent Experience',
    label: 'Parent Experience',
    hue: 'rose',
    icon: 'heart',
    items: [
      { label: 'Parent Directory', icon: 'users', to: '/parent-directory', perm: ['parents.read'] },
      { label: 'Parent Communication', icon: 'message', to: '/parent-communication', perm: ['communication.read'] },
      { label: 'PTM', icon: 'calendar', to: '/ptm', perm: ['communication.read'] },
      { label: 'Circulars', icon: 'megaphone', to: '/circulars', perm: ['communication.read'] },
      { label: 'Events', icon: 'star', to: '/events', perm: ['communication.read'] },
      { label: 'Acknowledgements', icon: 'checkSquare', to: '/acknowledgements', perm: ['communication.read'] },
    ],
  },
  {
    section: 'Transport & Safety',
    group: 'Safety & Transport',
    label: 'GPS & Safety',
    hue: 'terracotta',
    icon: 'mapPin',
    quick: [{ to: '/student-tracking', label: 'GPS Tracking' }, { to: '/bus-tracking', label: 'Transport' }],
    items: [
      { label: 'Smart Gate', icon: 'door', to: '/smart-gate', perm: ['safety.read'] },
      { label: 'Gate Entry/Exit', icon: 'scan', to: '/gate-log', perm: ['safety.read'] },
      { label: 'Pickup Authorisation', icon: 'key', to: '/pickup', perm: ['safety.read'] },
      { label: 'Visitor Management', icon: 'idCard', to: '/visitors', perm: ['safety.read'] },
      { label: 'Student Tracking', icon: 'mapPin', to: '/student-tracking', perm: TRACKING_READ },
      { label: 'GPS Devices', icon: 'navigation', to: '/gps-devices', perm: TRACKING_MANAGE },
      { label: 'Device Assignments', icon: 'link', to: '/device-assignments', perm: TRACKING_MANAGE },
      { label: 'Bus Tracking', icon: 'bus', to: '/bus-tracking', perm: ['transport.read'] },
      { label: 'Routes', icon: 'route', to: '/routes', perm: ['transport.read'] },
      { label: 'Boarding/De-boarding', icon: 'navigation', to: '/boarding', perm: ['transport.read'] },
      { label: 'Emergency Alerts', icon: 'megaphone', to: '/emergency', perm: ['safety.read'] },
      { label: 'Safeguarding', icon: 'shieldCheck', to: '/safeguarding', perm: ['safety.read'] },
      { label: 'Health & Infirmary', icon: 'stethoscope', to: '/infirmary', perm: ['safety.read'] },
      { label: 'Counselling', icon: 'heart', to: '/counselling', perm: ['safety.read'] },
    ],
  },
  {
    section: 'Finance',
    group: 'Finance',
    label: 'Fee Management',
    hue: 'sage',
    icon: 'wallet',
    quick: [{ to: '/payments' }, { to: '/expenses' }, { to: '/financial-reports', label: 'Reports' }],
    items: [
      { label: 'Fee Structures', icon: 'layers', to: '/fee-structures', perm: ['finance.read'] },
      { label: 'Fee Collection', icon: 'wallet', to: '/fees', perm: ['finance.read'] },
      { label: 'Student Accounts', icon: 'user', to: '/student-accounts', perm: ['finance.read'] },
      { label: 'Payments', icon: 'creditCard', to: '/payments', perm: ['finance.read'] },
      { label: 'Receipts', icon: 'receipt', to: '/receipts', perm: ['finance.read'] },
      { label: 'Concessions', icon: 'percent', to: '/concessions', perm: ['finance.read'] },
      { label: 'Scholarships', icon: 'award', to: '/scholarships', perm: ['finance.read'] },
      { label: 'Expenses', icon: 'fileText', to: '/expenses', perm: ['finance.read'] },
      { label: 'Reimbursements', icon: 'refresh', to: '/reimbursements', perm: ['finance.read'] },
      { label: 'Allowances', icon: 'plus', to: '/allowances', perm: ['finance.read'] },
      { label: 'Budgets', icon: 'pieChart', to: '/budgets', perm: ['finance.read'] },
      { label: 'Reconciliation', icon: 'check', to: '/reconciliation', perm: ['finance.read'] },
      { label: 'Financial Reports', icon: 'barChart', to: '/financial-reports', perm: ['finance.read'] },
    ],
  },
  {
    section: 'HR & Workforce',
    group: 'Workforce',
    label: 'Staff',
    hue: 'amber',
    icon: 'users',
    quick: [{ to: '/staff-attendance', label: 'Attendance' }, { to: '/leave' }, { to: '/payroll' }],
    items: [
      { label: 'Employee Directory', icon: 'users', to: '/workforce', perm: ['hr.read'] },
      { label: 'Teaching Staff', icon: 'graduation', to: '/teaching-staff', perm: ['hr.read'] },
      { label: 'Non-Teaching Staff', icon: 'tool', to: '/non-teaching-staff', perm: ['hr.read'] },
      { label: 'Attendance', icon: 'checkSquare', to: '/staff-attendance', perm: ['hr.read'] },
      { label: 'Shifts & Rosters', icon: 'clock', to: '/shifts', perm: ['hr.read'] },
      { label: 'Leave', icon: 'calendar', to: '/leave', perm: ['hr.read'] },
      { label: 'Overtime', icon: 'clock', to: '/overtime', perm: ['hr.read'] },
      { label: 'Allowances', icon: 'plus', to: '/staff-allowances', perm: ['hr.read', 'finance.read'] },
      { label: 'Workload', icon: 'barChart', to: '/workload', perm: ['hr.read'] },
      { label: 'CPD', icon: 'award', to: '/cpd', perm: ['hr.read'] },
      { label: 'Payroll', icon: 'wallet', to: '/payroll', perm: ['payroll.read'], tone: 'amber' },
      { label: 'Payslips', icon: 'receipt', to: '/payslips', perm: ['payroll.read'] },
    ],
  },
  {
    section: 'Operations',
    group: 'Operations',
    label: 'Facilities & Assets',
    hue: 'steel',
    icon: 'box',
    items: [
      { label: 'Assets', icon: 'box', to: '/assets', perm: ['operations.read'] },
      { label: 'Facilities', icon: 'building', to: '/facilities', perm: ['operations.read'] },
      { label: 'Maintenance', icon: 'wrench', to: '/maintenance', perm: ['operations.read'] },
      { label: 'Inventory', icon: 'layers', to: '/inventory', perm: ['operations.read'] },
      { label: 'Documents', icon: 'folder', to: '/documents', perm: ['documents.read'] },
      { label: 'Certificates', icon: 'award', to: '/certificates', perm: ['documents.read'] },
      { label: 'Circulars', icon: 'megaphone', to: '/op-circulars', perm: ['operations.read'] },
      { label: 'Compliance Calendar', icon: 'shield', to: '/compliance', perm: ['operations.read'], tone: 'alert' },
      { label: 'Audit Trail', icon: 'list', to: '/audit', perm: ['audit.read'] },
    ],
  },
  {
    section: 'Insights & Innovation',
    group: 'Innovation',
    hue: 'amber',
    icon: 'rocket',
    items: [
      { label: 'My Ideas', icon: 'lightbulb', to: '/my-ideas', perm: ['student_portal.use'] },
      { label: 'Innovation Lab', icon: 'rocket', to: '/innovation', perm: ['innovation.read'] },
      { label: 'Ideas', icon: 'lightbulb', to: '/ideas', perm: ['innovation.read'] },
      { label: 'Projects', icon: 'puzzle', to: '/projects', perm: ['innovation.read'] },
      { label: 'Mentors', icon: 'users', to: '/mentors', perm: ['innovation.read'] },
      { label: 'Milestones', icon: 'flag', to: '/milestones', perm: ['innovation.read'] },
      { label: 'Competitions', icon: 'award', to: '/competitions', perm: ['innovation.read'] },
      { label: 'Achievements', icon: 'star', to: '/achievements', perm: ['innovation.read'] },
    ],
  },
  {
    section: 'Insights & Innovation',
    group: 'Intelligence',
    hue: 'teal',
    icon: 'brain',
    items: [
      { label: 'AI Teacher Co-Pilot', icon: 'sparkle', to: '/copilot', perm: ['ai.use'] },
      { label: 'School Knowledge AI', icon: 'brain', to: '/knowledge-ai', perm: ['ai.use'] },
      { label: 'Talent Discovery', icon: 'star', to: '/talent', perm: [...STUDENTS_READ, 'ai.use'] },
      { label: 'Early Warning', icon: 'alert', to: '/early-warning', perm: ['earlywarning.read'] },
      { label: 'Analytics', icon: 'chart', to: '/analytics', perm: ['reports.read'] },
      { label: 'Reports', icon: 'fileText', to: '/reports', perm: ['reports.read'] },
    ],
  },
  {
    section: 'Administration',
    group: 'Group Management',
    hue: 'indigo',
    icon: 'building',
    items: [
      { label: 'Campuses', icon: 'building', to: '/campuses', perm: ['group.read'] },
      { label: 'Group Dashboard', icon: 'globe', to: '/group-dashboard', perm: ['dashboard.group'] },
      { label: 'Campus Comparison', icon: 'barChart', to: '/campus-comparison', perm: ['group.read'] },
      { label: 'Transfers', icon: 'refresh', to: '/transfers', perm: ['group.read'] },
      { label: 'Group Policies', icon: 'shield', to: '/group-policies', perm: ['group.read'] },
    ],
  },
  {
    section: 'Administration',
    group: 'Administration',
    label: 'Users & Settings',
    hue: 'steel',
    icon: 'settings',
    items: [
      { label: 'Report Centre', icon: 'barChart', to: '/admin/reports', perm: ['users.manage'] },
      { label: 'Users & Roles', icon: 'users', to: '/admin/users', perm: ['users.manage'] },
      { label: 'System Settings', icon: 'settings', to: '/admin/settings', perm: ['settings.manage'] },
      { label: 'AI Providers', icon: 'sparkle', to: '/admin/ai', perm: ['settings.manage'] },
      { label: 'Integrations', icon: 'link', to: '/admin/integrations', perm: ['settings.manage'] },
    ],
  },
  {
    section: 'Administration',
    group: 'Prototype',
    hue: 'steel',
    icon: 'play',
    items: [
      { label: 'Day in the Life', icon: 'clock', to: '/day-in-life', perm: ['prototype.view'] },
      { label: 'Automation Flows', icon: 'zap', to: '/automations', perm: ['prototype.view'] },
      { label: 'WhatsApp AI', icon: 'message', to: '/whatsapp-ai', perm: ['prototype.view'] },
      { label: 'Design System', icon: 'layers', to: '/design-system', perm: ['prototype.view'] },
    ],
  },
];

export interface BottomNavItem {
  label: string;
  icon: IconName;
  to: string;
  drawer?: boolean;
}

/** Bottom navigation for phones, per role (the original's mobile layout). */
export const BOTTOM_NAV: Partial<Record<RoleKey, BottomNavItem[]>> = {
  principal: [
    { label: 'Pulse', icon: 'pulse', to: '/command-center' },
    { label: 'Students', icon: 'users', to: '/students' },
    { label: 'Alerts', icon: 'bell', to: '/notifications' },
    { label: 'Tracking', icon: 'mapPin', to: '/student-tracking' },
    { label: 'More', icon: 'menu', to: '', drawer: true },
  ],
  teacher: [
    { label: 'Home', icon: 'home', to: '/teacher' },
    { label: 'Attendance', icon: 'checkSquare', to: '/attendance' },
    { label: 'Co-Pilot', icon: 'sparkle', to: '/copilot' },
    { label: 'Students', icon: 'users', to: '/students' },
    { label: 'More', icon: 'menu', to: '', drawer: true },
  ],
  parent: [
    { label: 'Home', icon: 'home', to: '/parent-360' },
    { label: 'Track', icon: 'mapPin', to: '/parent-360?tab=track' },
    { label: 'Academics', icon: 'bookOpen', to: '/parent-360?tab=academics' },
    { label: 'Fees', icon: 'wallet', to: '/parent-360?tab=fees' },
    { label: 'More', icon: 'menu', to: '', drawer: true },
  ],
  office: [
    { label: 'Admissions', icon: 'target', to: '/admissions' },
    { label: 'Fees', icon: 'wallet', to: '/fees' },
    { label: 'Students', icon: 'users', to: '/students' },
    { label: 'Tasks', icon: 'checkSquare', to: '/my-tasks' },
    { label: 'More', icon: 'menu', to: '', drawer: true },
  ],
  staff: [
    { label: 'Home', icon: 'home', to: '/staff-self' },
    { label: 'Transport', icon: 'bus', to: '/bus-tracking' },
    { label: 'Gate', icon: 'scan', to: '/gate-log' },
    { label: 'Alerts', icon: 'bell', to: '/notifications' },
    { label: 'More', icon: 'menu', to: '', drawer: true },
  ],
  student: [
    { label: 'Me', icon: 'user', to: '/my-profile' },
    { label: 'Alerts', icon: 'bell', to: '/notifications' },
    { label: 'Tasks', icon: 'checkSquare', to: '/my-tasks' },
    { label: 'More', icon: 'menu', to: '', drawer: true },
  ],
};

export function bottomNavFor(role: RoleKey, home: string): BottomNavItem[] {
  return (
    BOTTOM_NAV[role] ?? [
      { label: 'Home', icon: 'home', to: home },
      { label: 'Alerts', icon: 'bell', to: '/notifications' },
      { label: 'Tasks', icon: 'checkSquare', to: '/my-tasks' },
      { label: 'More', icon: 'menu', to: '', drawer: true },
    ]
  );
}

/** Sidebar groups visible to a user, with items filtered by permission and role. */
export function visibleNav(role: RoleKey, permissions: Iterable<string>): NavGroup[] {
  const held = new Set(permissions);
  const canSee = (item: NavItem) => {
    if (item.roles && !item.roles.includes(role)) return false;
    if (item.hideRoles && item.hideRoles.includes(role)) return false;
    if (!item.perm || item.perm.length === 0) return true;
    return item.perm.some((p) => held.has(p));
  };
  return NAV.map((g) => ({ ...g, items: g.items.filter(canSee) })).filter((g) => g.items.length > 0);
}

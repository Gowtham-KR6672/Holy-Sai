import { ALL_PERMISSION_KEYS, PermissionKey } from './permissions';

/** Which records a role can see: the whole campus, its classes, its own family, or only itself. */
export type DataScope = 'school' | 'class' | 'family' | 'self';

export type RoleKey =
  | 'super_admin'
  | 'school_admin'
  | 'principal'
  | 'management'
  | 'office'
  | 'finance'
  | 'hr'
  | 'teacher'
  | 'staff'
  | 'parent'
  | 'student';

export interface RoleDef {
  key: RoleKey;
  name: string;
  scope: DataScope;
  description: string;
  /** Where the role lands after sign-in. */
  home: string;
  permissions: PermissionKey[];
}

// Permission sets are taken by position from the original Users & Roles screen.
const pick = (...indexes: number[]): PermissionKey[] => indexes.map((i) => ALL_PERMISSION_KEYS[i]);
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

export const ROLES: RoleDef[] = [
  {
    key: 'super_admin',
    name: 'Super Admin',
    scope: 'school',
    description: 'Platform administration with every permission, including settings and user accounts.',
    home: '/overview',
    permissions: [...ALL_PERMISSION_KEYS],
  },
  {
    key: 'school_admin',
    name: 'School Admin',
    scope: 'school',
    description: 'Runs every staff-side module, including settings and users.',
    home: '/overview',
    permissions: pick(...range(0, 18), ...range(20, 32), ...range(34, 42), 44, ...range(46, 55), ...range(57, 60)),
  },
  {
    key: 'principal',
    name: 'Principal',
    scope: 'school',
    description: 'Academic and operational leadership; approves finance, HR and payroll.',
    home: '/command-center',
    permissions: pick(...range(0, 18), 20, ...range(22, 25), ...range(27, 32), 34, 35, 36, ...range(38, 42), 48, ...range(50, 54), 58, 59),
  },
  {
    key: 'management',
    name: 'Management',
    scope: 'school',
    description: 'Trustees and management with read-only oversight of every module.',
    home: '/command-center',
    permissions: pick(1, 3, 4, 7, 8, 9, 12, 13, 14, 16, 18, 22, 24, 27, 29, 32, 35, 38, 39, 40, 42, 48, 52, 54, 59),
  },
  {
    key: 'office',
    name: 'Office',
    scope: 'school',
    description: 'Front office and admissions: enquiries, parents, documents, payments, gate and visitors.',
    home: '/admissions',
    permissions: pick(1, 2, 3, 7, 8, 9, 10, 11, 12, 14, 15, 16, 18, 21, 22, 27, 29, 31, 32, 34, 35, 38, 40, 41, 42, 46, 48, 51, 54, 59),
  },
  {
    key: 'finance',
    name: 'Finance',
    scope: 'school',
    description: 'Fees, payments, concessions, expenses, budgets and reconciliation.',
    home: '/fees',
    permissions: pick(14, 16, 20, 21, 22, 35, 38, 40, 48),
  },
  {
    key: 'hr',
    name: 'HR',
    scope: 'school',
    description: 'Employee records, shifts, leave, CPD and payroll preparation.',
    home: '/workforce',
    permissions: pick(8, 14, 15, 16, 25, 26, 27, 37, 38, 40),
  },
  {
    key: 'teacher',
    name: 'Teacher',
    scope: 'class',
    description: 'Teaching, attendance, assessments and early warning for assigned classes.',
    home: '/teacher',
    permissions: pick(0, 1, 4, 5, 6, 7, 9, 10, 14, 16, 17, 18, 28, 29, 35, 40, 42, 49, 55, 59),
  },
  {
    key: 'staff',
    name: 'Non-Teaching Staff',
    scope: 'self',
    description: 'Staff self-service, gate and visitor events, transport and boarding.',
    home: '/staff-self',
    permissions: pick(41, 42, 43, 58, 59),
  },
  {
    key: 'parent',
    name: 'Parent',
    scope: 'family',
    description: 'Parent 360: own children’s progress, fees and location.',
    home: '/parent-360',
    permissions: pick(19, 33, 56),
  },
  {
    key: 'student',
    name: 'Student',
    scope: 'self',
    description: 'Student portal: own profile, homework and Innovation Lab ideas.',
    home: '/my-profile',
    permissions: pick(45),
  },
];

export const ROLE_BY_KEY: Record<RoleKey, RoleDef> = Object.fromEntries(ROLES.map((r) => [r.key, r])) as Record<RoleKey, RoleDef>;

/** Roles that see the owner/administrator views rather than a personal portal. */
export const ADMIN_ROLES: RoleKey[] = ['super_admin', 'school_admin', 'principal'];

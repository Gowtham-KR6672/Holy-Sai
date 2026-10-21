/** API shapes read by the mobile screens — the same fields the web pages read. */
import type { RoleKey } from '@holysai/shared';

export interface SessionUser {
  id: string;
  fullName: string;
  email: string;
  phone?: string | null;
  title: string | null;
  role: { key: RoleKey; name: string; scope: 'school' | 'class' | 'family' | 'self'; homeRoute: string };
  permissions: string[];
  campusId: string | null;
  campus_name: string | null;
  academic_year?: string | null;
  parentId: string | null;
  studentId: string | null;
  employeeId: string | null;
  mustChangePassword?: boolean;
}

export interface LoginPayload {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: SessionUser;
}

export interface PublicConfig {
  schoolName?: string | null;
  productName?: string;
  tagline?: string;
  academicYear?: string | null;
  map?: { tileUrl: string; attribution: string };
}

export interface NotificationItem {
  id: string;
  title: string;
  body: string | null;
  category: 'Critical' | 'Attention' | 'Information' | 'Completed';
  tone: 'critical' | 'warning' | 'info' | 'success';
  icon: string;
  module: string | null;
  route: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationCounts {
  total: number;
  unread: number;
  critical: number;
  attention: number;
  information: number;
  completed: number;
  alerts: number;
  openTasks: number;
}

export interface TaskItem {
  id: string;
  code: string;
  title: string;
  module: string;
  dueOn: string | null;
  priority: 'High' | 'Medium' | 'Low';
  status: 'Pending' | 'Under Review' | 'Completed';
  overdue: boolean;
  route: string | null;
}

export interface StudentRow {
  id: string;
  admissionNo: string;
  fullName: string;
  firstName: string;
  lastName: string;
  grade: string;
  section: string;
  sectionId: string;
  classId: string;
  campusId: string;
  campusName?: string;
  house: string | null;
  today: string;
  attendance: number | null;
  average: number | null;
  trend: number | null;
  risk: 'On Track' | 'Developing Risk' | 'At Risk' | string;
  feeStatus: string;
  busRoute: string | null;
  parentName?: string | null;
  photoUrl?: string | null;
}

export interface StudentProfile {
  student: {
    id: string; admissionNo: string; fullName: string; firstName: string; lastName: string; photoUrl: string | null;
    gender: string; bloodGroup: string | null; campusName: string; grade: string | null; section: string | null; rollNo: number | null;
    house: string | null; status: string; risk: string; classTeacher: string | null; attendance: number | null; average: number | null;
    trend: number; feeStatus: string | null; today: string; phone?: string | null; email?: string | null;
  };
  guardians: { id: string; fullName: string; relationship: string; isPrimary: boolean; phone: string | null; email: string | null }[];
  attendance: {
    months: { label: string; value: number }[];
    totals: { marked: number; present: number; late: number; absent: number; leave: number } | null;
    recent: { date: string; status: string; arrivalTime: string | null; remarks: string | null }[];
  };
  academics: {
    subjects: { name: string; score: number; grade: string; target: number | null; trend: number | null; teacher: string | null }[];
    termTrend: { label: string; value: number }[];
    assessments: { code: string; name: string; subject: string; heldOn: string; maxMarks: number; marks: number | null; grade: string | null; isAbsent: boolean; pct: number | null }[];
  };
  activities: { name: string; category: string; role: string; since: string; hours: number; status: string }[];
  achievements: { id: string; title: string; type: string; level: string | null; date: string; verified: boolean }[];
  transport: {
    routeCode: string; routeName: string; area: string; runStatus: string; delayMinutes: number; eta: string | null; busNo: string | null;
    stopName: string | null; pickupTime: string | null; dropTime: string | null;
  } | null;
  fees?: { billed: number; paid: number; outstanding: number; nextDue: string | null };
}

/** A student's current location (GET /parents/:pid/children/:cid/location, /students/:id/location). */
export interface CurrentLocation {
  studentId: string;
  fullName: string;
  admissionNo: string;
  grade?: string | null;
  section?: string | null;
  campusName?: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  recordedAt: string | null;
  displayStatus: string;
  placeLabel?: string | null;
  locationStatusLabel?: string | null;
  isStale?: boolean;
  trackingEnabled?: boolean;
  batteryPct?: number | null;
  speed?: number | null;
  campusLatitude?: number | null;
  campusLongitude?: number | null;
  isSampleData?: boolean;
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface Paged<T> {
  rows: T[];
  meta: PageMeta;
}

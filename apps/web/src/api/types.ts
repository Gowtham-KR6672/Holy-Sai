/**
 * Shared API types. (Reconstructed: type-only modules compile to nothing, so this file was
 * not in the original source maps. Fields are taken from how the pages use them, and the
 * NestJS API returns exactly these shapes.)
 */

/** A permission key such as 'students.read' or 'finance.approve'. */
export type Permission = string;

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

export interface SessionUser {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  title: string | null;
  role: {
    key: RoleKey;
    name: string;
    /** Data scope: school | class | family | self. */
    scope: 'school' | 'class' | 'family' | 'self';
    homeRoute: string;
  };
  permissions: Permission[];
  campusId: string | null;
  campus_name: string | null;
  academic_year?: string;
  /** Set when the account belongs to a parent, a student or an employee. */
  parentId: string | null;
  studentId: string | null;
  employeeId: string | null;
  mustChangePassword?: boolean;
}

export interface Campus {
  id: string;
  code: string;
  name: string;
  shortName: string;
  place: string;
  curriculum: string;
}

export interface AcademicYear {
  id: string;
  label: string;
  startsOn: string;
  endsOn: string;
  isCurrent: boolean;
}

export interface LookupSection {
  id: string;
  name: string;
}

export interface LookupClass {
  id: string;
  name: string;
  gradeLevel: number;
  campusId: string;
  sections: LookupSection[];
}

export interface LookupSubject {
  id: string;
  code: string;
  name: string;
}

export interface LookupStaff {
  id: string;
  employeeId: string;
  fullName: string;
  designation: string;
  department: string;
  employeeType: 'teaching' | 'non_teaching';
  campusId: string | null;
}

export interface LookupStop {
  id: string;
  name: string;
  pickupTime: string | null;
}

export interface LookupRoute {
  id: string;
  code: string;
  name: string;
  /** Area served, e.g. "Urapakkam" */
  area: string;
  campusId: string;
  stops: LookupStop[];
}

export interface Lookups {
  campuses: Campus[];
  academicYears: AcademicYear[];
  classes: LookupClass[];
  subjects: LookupSubject[];
  staff: LookupStaff[];
  routes: LookupRoute[];
  houses: string[];
  roles: { key: RoleKey; name: string }[];
}

export interface NotificationItem {
  id: string;
  title: string;
  body: string | null;
  category: 'Critical' | 'Attention' | 'Information' | 'Completed';
  tone: 'critical' | 'warning' | 'info' | 'success';
  icon: string;
  topic: string | null;
  module: string | null;
  route: string | null;
  readAt: string | null;
  createdAt: string;
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
  campusName: string;
  house: string | null;
  today: string;
  attendance: number | null;
  average: number | null;
  trend: number;
  risk: 'On Track' | 'Developing Risk' | 'At Risk';
  feeStatus: string;
  busRoute: string | null;
  parentName: string | null;
  photoUrl?: string | null;
  /** GPS tracking state for the family portal (active / paused / offline / disabled). */
  trackingStatus?: 'active' | 'paused' | 'offline' | 'disabled' | null;
}

// ---- Student tracking (GPS devices, locations) — shapes served by the transport/tracking module. ----

/** Device contact: online < 2 min, stale < 10 min, offline after that, never = no contact yet. */
export type GpsStatus = 'online' | 'stale' | 'offline' | 'never';
export type DeviceType = 'gps_tracker' | 'id_card_tag' | 'wearable' | 'mobile_app';
export type LocationStatus = 'at_school' | 'in_transit' | 'at_home' | 'on_trip' | 'unknown';
export type TrackingDisplayStatus = 'Tracking Active' | 'Offline' | 'No Location Yet' | 'Tracking Paused' | 'Tracking Disabled';

/** One recorded location (history). Speed in metres per second. */
export interface LocationPoint {
  id: number;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  batteryPct: number | null;
  recordedAt: string;
  locationStatus: LocationStatus;
  locationStatusLabel: string;
  placeLabel: string | null;
  deviceCode: string | null;
  source: string;
}

/** A student's tracking state and current (or last known) location: GET /students/:id/location, /tracking/students rows. */
export interface CurrentLocation {
  studentId: string;
  fullName: string;
  admissionNo: string;
  grade: string | null;
  section: string | null;
  classId: string;
  sectionId: string;
  campusId: string;
  campusName: string;
  /** Campus position for the map (0 when the campus has no coordinates set up). */
  campusLatitude: number;
  campusLongitude: number;
  campusRadiusM: number | null;
  photoUrl: string | null;
  trackingStatus: 'active' | 'paused' | 'disabled';
  trackingEnabled: boolean;
  consentAt: string | null;
  displayStatus: TrackingDisplayStatus;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  /** Metres per second. */
  speed: number | null;
  batteryPct: number | null;
  recordedAt: string | null;
  isStale: boolean;
  locationStatus: LocationStatus | null;
  locationStatusLabel: string;
  placeLabel: string | null;
  source: string | null;
  assignmentId: string | null;
  deviceId: string | null;
  deviceCode: string | null;
  deviceType: DeviceType | null;
  gpsStatus: GpsStatus | null;
  deviceLastSeenAt: string | null;
  isSampleData: boolean;
  staleAfterMinutes?: number;
}

export interface LocationHistory {
  studentId: string;
  date: string;
  from: string | null;
  to: string | null;
  points: LocationPoint[];
  availableDays: { date: string; points: number }[];
  /** Days of history the viewer may see (family portal), null for staff. */
  historyDays: number | null;
  summary: { count: number; distanceKm: number; firstAt: string | null; lastAt: string | null };
}

export interface DeviceSummary {
  total: number;
  assigned: number;
  available: number;
  maintenance: number;
  inactive: number;
  lost: number;
  /** Maintenance + lost. */
  outOfService: number;
  online: number;
  stale: number;
  offline: number;
  never: number;
  lowBattery: number;
  thresholds: { onlineSeconds: number; offlineSeconds: number; lowBatteryPct: number };
}

export interface GpsDevice {
  id: string;
  deviceCode: string;
  deviceType: DeviceType;
  imei: string | null;
  serialNumber: string | null;
  firmwareVersion: string | null;
  campusId: string | null;
  campusName: string | null;
  /** available | assigned | maintenance | inactive | lost */
  status: string;
  statusReason: string | null;
  gpsStatus: GpsStatus;
  lastSeenAt: string | null;
  batteryPct: number | null;
  hasToken: boolean;
  tokenIssuedAt: string | null;
  assignmentId: string | null;
  studentId: string | null;
  studentName: string | null;
  admissionNo: string | null;
  grade: string | null;
  section: string | null;
  assignedAt: string | null;
  /** Set when the device is mounted on a bus. */
  vehicleId: string | null;
  busNo: string | null;
  notes: string | null;
  isSampleData: boolean;
  createdAt: string;
}

export interface GpsDeviceDetail extends GpsDevice {
  assignments: {
    id: string;
    studentId: string;
    studentName: string;
    admissionNo: string;
    status: 'active' | 'inactive';
    assignedAt: string;
    assignedBy: string | null;
    notes: string | null;
    unassignedAt: string | null;
    unassignedBy: string | null;
    unassignReason: string | null;
    locationCount: number;
  }[];
}

export interface DeviceAssignment {
  id: string;
  studentId: string;
  studentName: string;
  admissionNo: string;
  grade: string | null;
  section: string | null;
  deviceId: string;
  deviceCode: string | null;
  deviceType: DeviceType;
  status: 'active' | 'inactive';
  assignedAt: string;
  assignedBy: string | null;
  notes: string | null;
  unassignedAt: string | null;
  unassignedBy: string | null;
  unassignReason: string | null;
  gpsStatus: GpsStatus;
  lastSeenAt: string | null;
  batteryPct: number | null;
}

/** A student pin on the tracking map. */
export interface TrackingMarker {
  studentId: string;
  fullName: string;
  admissionNo: string;
  grade: string | null;
  section: string | null;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  locationStatus: LocationStatus | null;
  locationStatusLabel: string;
  displayStatus: TrackingDisplayStatus;
  recordedAt: string | null;
  isStale: boolean;
  placeLabel: string | null;
  batteryPct: number | null;
  deviceCode: string | null;
  gpsStatus: GpsStatus | null;
}

export interface TrackingMapData {
  summary: {
    total: number;
    active: number;
    paused: number;
    disabled: number;
    offline: number;
    noLocation: number;
    atSchool: number;
    inTransit: number;
    atHome: number;
    onTrip: number;
    withDevice: number;
  };
  markers: TrackingMarker[];
  campuses: { id: string; name: string; latitude: number; longitude: number; radiusM: number | null }[];
  staleAfterMinutes: number;
  generatedAt: string;
}

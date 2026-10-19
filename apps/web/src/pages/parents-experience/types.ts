/**
 * API shapes for the parent experience screens: parent directory, family communication,
 * circulars and acknowledgements, events and parent–teacher meetings.
 * (Reconstructed: type-only modules compile to nothing, so this file was not in the original
 * source maps. Fields are taken from how the pages use them, and the API returns exactly these.)
 */

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------
/** Message channels a staff member can send on, plus the logged kinds (Call, Note). */
export type Channel = 'WhatsApp' | 'SMS' | 'Email' | 'Call' | 'Note' | 'In-app';

export type AudienceKind = 'all' | 'grades' | 'transport' | 'staff';

/** Who a circular or event is for. `grades` are grade levels (e.g. 5 for "Grade 5"). */
export interface Audience {
  kind: AudienceKind;
  grades?: number[];
}

/** A child as shown next to a parent: grade is the class name ("Grade 5"), section its letter ("A"). */
export interface ChildRef {
  id: string;
  fullName: string;
  grade: string | null;
  section?: string | null;
}

// ---------------------------------------------------------------------------
// Parent directory
// ---------------------------------------------------------------------------
export interface DirectoryRow {
  id: string;
  /** e.g. "PAR-1001" */
  parentCode: string;
  fullName: string;
  phone: string;
  email: string | null;
  occupation: string | null;
  /** whatsapp | sms | email | push | call */
  preferredChannel: string;
  /** 0–100 */
  engagement: number;
  lastContactAt: string | null;
  lastContactChannel: string | null;
  hasAppAccount: boolean;
  children: ChildRef[];
  ptmBooked: boolean;
  /** Messages from this family still awaiting a reply. */
  openQueries: number;
}

export interface DirectorySummary {
  parents: number;
  appAccounts: number;
  high: number;
  medium: number;
  low: number;
  averageEngagement: number;
  noContact30d: number;
  contacted7d: number;
}

export interface ParentRecord {
  id: string;
  parentCode: string;
  fullName: string;
  phone: string;
  altPhone: string | null;
  email: string | null;
  occupation: string | null;
  address: string | null;
  preferredChannel: string;
  language: string;
  engagement: number;
  lastContactAt: string | null;
  lastContactChannel: string | null;
  hasAppAccount: boolean;
  createdAt: string;
}

export interface ParentChild {
  id: string;
  fullName: string;
  admissionNo: string;
  grade: string | null;
  section: string | null;
  relationship: string;
  isPrimary: boolean;
  /** Attendance percentage, or null when not yet recorded. */
  attendance: number | null;
  average: number | null;
  /** On Track | Developing Risk | At Risk */
  risk: string;
  feeStatus: string | null;
  status: string;
}

// ---------------------------------------------------------------------------
// Communication
// ---------------------------------------------------------------------------
export interface Communication {
  id: string;
  channel: Channel;
  /** inbound (from the family) | outbound (from the school) | internal (staff note) */
  direction: 'inbound' | 'outbound' | 'internal';
  subject: string;
  body: string | null;
  /** Delivered | Failed | Not delivered | Received | Replied | Connected | No answer | Left voicemail | Internal | Sent */
  status: string;
  needsReply: boolean;
  /** Hours the item has been waiting (items awaiting a reply). */
  ageHours: number | null;
  occurredAt: string;
  parentId: string | null;
  parentName: string | null;
  parentPhone: string | null;
  parentHasApp: boolean;
  /** Who the interaction was with: the parent, a broadcast audience, or free text for notes. */
  counterpart: string;
  /** Families reached (more than 1 for broadcasts). */
  recipients: number;
  studentId: string | null;
  studentName: string | null;
  /** Class and section, e.g. "Grade 5A". */
  grade: string | null;
  sentBy: string | null;
  repliedBy: string | null;
  repliedAt: string | null;
  replyToId: string | null;
  threadId: string | null;
}

export interface CommSummary {
  unanswered: number;
  unansweredOver24h: number;
  oldestHours: number | null;
  unreadThreads: number;
  today: number;
  last30Days: number;
  byChannel: Record<string, number>;
}

export interface ThreadRow {
  id: string;
  parentId: string;
  parentName: string | null;
  studentId: string | null;
  studentName: string | null;
  grade: string | null;
  subject: string;
  /** Open | Closed */
  status: string;
  awaitingReply: boolean;
  unread: boolean;
  lastMessageAt: string;
  messageCount: number;
}

export interface ThreadMessage {
  id: string;
  body: string;
  senderName: string;
  /** parent, or the staff member's role key */
  senderRole: string;
  mine: boolean;
  createdAt: string;
}

export interface ThreadDetail extends ThreadRow {
  participants: { userId: string; name: string; role: string }[];
  messages: ThreadMessage[];
}

// ---------------------------------------------------------------------------
// Circulars and acknowledgements
// ---------------------------------------------------------------------------
export interface Circular {
  id: string;
  reference: string;
  title: string;
  body: string;
  /** Audience label, e.g. "Parents of Grades 5, 6". */
  audience: string;
  audienceFilter: Audience;
  campusId: string | null;
  campus: string | null;
  /** Draft | Under Review | Released | Withdrawn */
  status: string;
  /** push | whatsapp | sms | email */
  channels: string[];
  requiresAck: boolean;
  /** Families (or staff accounts) reached at release; the current audience size before. */
  targetCount: number;
  ackCount: number;
  createdBy: string | null;
  createdAt: string;
  submittedBy: string | null;
  submittedAt: string | null;
  releasedBy: string | null;
  publishedAt: string | null;
  withdrawnAt: string | null;
  lastRemindedAt: string | null;
  reminderCount: number;
}

export interface AckSummary {
  drafts: number;
  underReview: number;
  /** Released circulars that ask families to acknowledge. */
  circulars: number;
  targeted: number;
  acknowledged: number;
  outstanding: number;
  /** Percentage, or null when nothing has been targeted yet. */
  rate: number | null;
  neverAcknowledged: number;
}

export interface AckRow {
  parentId: string;
  parentName: string;
  phone: string;
  engagement: number;
  hasAppAccount: boolean;
  children: { id: string; fullName: string; grade: string | null }[];
  acknowledgedAt: string | null;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
export type EventType = 'School' | 'Academic' | 'Sports' | 'Cultural' | 'PTM' | 'Holiday';

export interface SchoolEvent {
  id: string;
  title: string;
  description: string | null;
  eventType: EventType;
  /** YYYY-MM-DD */
  startsOn: string;
  endsOn: string | null;
  /** HH:MM */
  startsAt: string | null;
  venue: string | null;
  audience: string;
  audienceFilter: Audience;
  campusId: string | null;
  campus: string | null;
  /** Published | Draft | Cancelled */
  status: string;
  notifiedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface EventSummary {
  upcoming: number;
  next30Days: number;
  drafts: number;
  cancelled: number;
}

// ---------------------------------------------------------------------------
// Parent–teacher meetings
// ---------------------------------------------------------------------------
export interface PtmSession {
  id: string;
  employeeId: string;
  teacher: string;
  subjectLabel: string;
  sectionId: string;
  grade: string | null;
  section: string | null;
  campusId: string;
  /** YYYY-MM-DD */
  sessionDate: string;
  /** HH:MM */
  startsAt: string;
  slotMinutes: number;
  totalSlots: number;
  booked: number;
  free: number;
  venue: string | null;
  past: boolean;
}

export interface PtmBookingRef {
  id: string;
  /** Booked | Attended | No-show | Cancelled */
  status: string;
  studentId: string;
  studentName: string;
  parentId: string | null;
  parentName: string;
}

export interface PtmSlot {
  slotNo: number;
  /** HH:MM */
  time: string;
  booking: PtmBookingRef | null;
}

export interface PtmUnbooked {
  studentId: string;
  studentName: string;
  parentId: string | null;
  parentName: string | null;
  parentPhone: string | null;
  hasAppAccount: boolean;
  risk: string;
}

export interface PtmSessionDetail extends PtmSession {
  slots: PtmSlot[];
  unbooked: PtmUnbooked[];
  lastNotifiedAt: string | null;
}

export interface PtmSummary {
  sessions: number;
  totalSlots: number;
  booked: number;
  unbookedFamilies: number;
  unbookedStudents: number;
  prioritiseFamilies: number;
  /** Classes with upcoming sessions, e.g. ["Grade 5", "Grade 6"]. */
  grades: string[];
  firstDate: string | null;
  lastDate: string | null;
  venues: string[];
}

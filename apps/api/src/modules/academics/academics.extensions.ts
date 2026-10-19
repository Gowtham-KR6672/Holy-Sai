// Hooks other modules can register (e.g. Early Warning in the intelligence module) without the
// academics module depending on their tables. Register from your module's onModuleInit:
//   AcademicsExtensions.registerWatchlist(async (studentIds, limit) => ({ rows, total }))
//   AcademicsExtensions.registerAttendanceCheck(async (input) => [{ code: 'EW-118', reason: '3 consecutive absences' }])
import type { AuthUser } from '../../common/auth-user';

/** An open Early Warning signal for a student, as the Teacher Dashboard lists it. */
export interface WatchSignal {
  id: string;
  code: string;
  signal: string;
  /** attendance | academic | behaviour | wellbeing … */
  signalType: string;
  /** 0 = new, then review stages */
  stage: number;
  studentId: string;
  name: string;
  admissionNo: string;
  sectionLabel: string;
}

export interface AttendanceCheckInput {
  sectionId: string;
  campusId: string;
  date: string;
  absentStudentIds: string[];
  lateStudentIds: string[];
  user: AuthUser;
}

type WatchlistProvider = (studentIds: string[], limit: number) => Promise<{ rows: WatchSignal[]; total: number }>;
type AttendanceCheck = (input: AttendanceCheckInput) => Promise<{ code: string; reason: string }[]>;

let watchlist: WatchlistProvider | null = null;
let attendanceCheck: AttendanceCheck | null = null;

export const AcademicsExtensions = {
  registerWatchlist(fn: WatchlistProvider) {
    watchlist = fn;
  },
  registerAttendanceCheck(fn: AttendanceCheck) {
    attendanceCheck = fn;
  },
  async watchlist(studentIds: string[], limit: number): Promise<{ rows: WatchSignal[]; total: number }> {
    if (!watchlist || !studentIds.length) return { rows: [], total: 0 };
    try {
      return await watchlist(studentIds, limit);
    } catch {
      return { rows: [], total: 0 };
    }
  },
  async afterAttendance(input: AttendanceCheckInput): Promise<{ code: string; reason: string }[]> {
    if (!attendanceCheck) return [];
    try {
      return await attendanceCheck(input);
    } catch {
      return [];
    }
  },
};

import type { ComponentType } from 'react';
import type { FeatureKey } from '@/lib/features';
import AccountScreen from './common/Account';
import MoreScreen from './common/More';
import MyTasksScreen from './common/MyTasks';
import NotificationsScreen from './common/Notifications';
import AdmissionsScreen from './leaders/Admissions';
import CommandCenterScreen from './leaders/CommandCenter';
import FeesScreen from './leaders/Fees';
import StudentsScreen from './leaders/Students';
import TrackingScreen from './leaders/Tracking';
import CircularsScreen from './parent/Circulars';
import FamilyAcademicsScreen from './parent/FamilyAcademics';
import FamilyFeesScreen from './parent/FamilyFees';
import FamilyHomeScreen from './parent/FamilyHome';
import FamilyTrackScreen from './parent/FamilyTrack';
import MessagesScreen from './parent/Messages';
import PtmScreen from './parent/Ptm';
import SafetyScreen from './parent/Safety';
import GateLogScreen from './staff/GateLog';
import StaffSelfScreen from './staff/StaffSelf';
import TransportScreen from './staff/Transport';
import MyIdeasScreen from './student/MyIdeas';
import MyProfileScreen from './student/MyProfile';
import AttendanceScreen from './teacher/Attendance';
import CopilotScreen from './teacher/Copilot';
import HomeworkScreen from './teacher/Homework';
import TeacherHomeScreen from './teacher/TeacherHome';

/** Feature key → screen. Tab routes and /view/[key] both render from here. */
export const SCREENS: Record<FeatureKey, ComponentType> = {
  'command-center': CommandCenterScreen,
  students: StudentsScreen,
  notifications: NotificationsScreen,
  tracking: TrackingScreen,
  teacher: TeacherHomeScreen,
  attendance: AttendanceScreen,
  copilot: CopilotScreen,
  homework: HomeworkScreen,
  family: FamilyHomeScreen,
  'family-track': FamilyTrackScreen,
  'family-academics': FamilyAcademicsScreen,
  'family-fees': FamilyFeesScreen,
  circulars: CircularsScreen,
  messages: MessagesScreen,
  ptm: PtmScreen,
  safety: SafetyScreen,
  admissions: AdmissionsScreen,
  fees: FeesScreen,
  tasks: MyTasksScreen,
  'staff-self': StaffSelfScreen,
  transport: TransportScreen,
  gate: GateLogScreen,
  me: MyProfileScreen,
  'my-ideas': MyIdeasScreen,
  account: AccountScreen,
  more: MoreScreen,
};

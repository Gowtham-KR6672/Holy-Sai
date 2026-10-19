// Default system settings, created by the seed when missing (existing values are never overwritten).

export interface SettingDefault {
  key: string;
  value: unknown;
  description: string;
  isPublic: boolean;
}

export const SETTING_DEFAULTS: SettingDefault[] = [
  { key: 'academics.pass_mark', value: 40, description: 'Pass mark (%) used in results and reports', isPublic: false },
  { key: 'admissions.group_target', value: 210, description: 'Group admissions target for the calendar year', isPublic: false },
  { key: 'admissions.referral_reward', value: 5000, description: 'Recognition credited to a referring family per enrolment (INR)', isPublic: false },
  { key: 'admissions.target', value: 120, description: 'Admissions target for the current academic year', isPublic: false },
  { key: 'attendance.absence_alert_channels', value: ['whatsapp', 'push'], description: 'Channels for absence alerts to parents', isPublic: false },
  { key: 'attendance.cutoff_time', value: '08:45', description: 'Arrivals after this time are marked Late', isPublic: false },
  { key: 'auth.session_days', value: 7, description: 'Refresh-token lifetime in days', isPublic: false },
  { key: 'auth.max_failed_logins', value: 5, description: 'Failed sign-ins before an account is locked', isPublic: false },
  { key: 'auth.lockout_minutes', value: 15, description: 'Minutes a locked account stays locked', isPublic: false },
  { key: 'early_warning.attendance_threshold', value: 82, description: 'Attendance % below which a signal is raised', isPublic: false },
  { key: 'early_warning.score_drop_threshold', value: 5, description: 'Drop (points) in the term average compared with the previous term that raises a signal', isPublic: false },
  { key: 'early_warning.fee_overdue_days', value: 60, description: 'Days fees can be overdue before an Early Warning fee signal', isPublic: false },
  { key: 'finance.late_fee_per_day', value: 50, description: 'Late fee after due date (INR/day)', isPublic: false },
  { key: 'school.currency', value: 'INR', description: 'Currency for all money values', isPublic: true },
  { key: 'school.languages', value: ['en', 'ta', 'hi'], description: 'Interface languages', isPublic: true },
  { key: 'school.name', value: 'Holy Sai International School', description: 'School display name', isPublic: true },
  { key: 'school.product_name', value: 'Holy Sai Smart School 360', description: 'Product name', isPublic: true },
  { key: 'school.tagline', value: 'Growing Minds. Inspiring Futures.', description: 'Tagline on the sign-in screen', isPublic: true },
  { key: 'school.timezone', value: 'Asia/Kolkata', description: 'School timezone', isPublic: true },
  { key: 'staffing.target', value: {}, description: 'Approved staff positions per campus (by campus code)', isPublic: false },
  { key: 'tracking.parent_history_days', value: 7, description: 'How many days of history a parent can view', isPublic: false },
  { key: 'tracking.stale_after_minutes', value: 30, description: 'Location older than this is shown as last known', isPublic: false },
  { key: 'payroll.conveyance', value: 1600, description: 'Monthly conveyance allowance (INR)', isPublic: false },
  { key: 'payroll.hra_percent', value: 40, description: 'House rent allowance as % of basic salary', isPublic: false },
  { key: 'payroll.pf_percent', value: 12, description: 'Provident fund contribution (% of PF wage)', isPublic: false },
  { key: 'payroll.pf_wage_ceiling', value: 15000, description: 'PF wage ceiling per month (INR)', isPublic: false },
  { key: 'payroll.special_allowance_percent', value: 10, description: 'Special allowance as % of basic salary', isPublic: false },
  { key: 'payroll.tds_standard_deduction', value: 75000, description: 'Standard deduction used for TDS, new regime (INR/year)', isPublic: false },
  { key: 'transport.afternoon_from', value: '12:00', description: 'Bus runs after this time are the afternoon (drop) run', isPublic: false },
  { key: 'transport.deviation_alert_km', value: 0.5, description: 'Alert when a bus is this far (km) off its route', isPublic: false },
  { key: 'transport.speed_limit_kmph', value: 50, description: 'Alert when a bus exceeds this speed (km/h)', isPublic: false },
  { key: 'workforce.default_start_time', value: '08:30', description: 'Staff start time when no shift is assigned', isPublic: false },
  { key: 'workforce.late_grace_minutes', value: 10, description: 'Minutes after start time before staff are marked Late', isPublic: false },
  { key: 'workforce.overtime_multiplier', value: 2, description: 'Overtime pay multiplier on the hourly rate', isPublic: false },
  { key: 'talent.strong_threshold', value: 82, description: 'Score (%) at which a subject counts as a talent strength', isPublic: false },
];

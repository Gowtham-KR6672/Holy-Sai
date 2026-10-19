/**
 * Narrative content for the prototype / hand-off screens, ported from the
 * wireframe (D.dayInLife, D.automations, D.ai.whatsapp). Figures that exist in
 * the live system are filled in at render time from /dashboard/command-center.
 */

export interface DayStep {
  time: string; title: string; role: string; icon: string; route: string; chain: string[];
  /** Body text; `live` (if present) replaces it when live figures are available. */
  body: string;
  live?: (l: LiveFigures) => string;
}

export interface LiveFigures {
  present: number; marked: number; students: number;
  staffPresent: number; staffTotal: number;
  followUps: number; openSignals: number; awaitingReview: number;
  collectedToday: number | null; approvals: number;
  delayedRoutes: string | null; enquiriesThisMonth: number | null; whatsappEnquiries: number | null;
}

export const DAY_IN_LIFE: DayStep[] = [
  { time: '07:45', title: 'Bus tracking and parent notification', role: 'Parent', icon: 'bus', route: '/bus-tracking',
    body: 'Bus 12 departs the depot. GPS begins streaming. Ranjith opens the Parent app and sees an ETA of 7 minutes for the Lake View Avenue stop.',
    chain: ['Bus starts', 'GPS tracking', 'Parent sees ETA'] },
  { time: '07:52', title: 'Boarding confirmation', role: 'Transport', icon: 'scan', route: '/bus-tracking',
    body: 'Aditya taps in at the door. The attendant confirms every student on the list is onboard. The parent receives "Aditya boarded".',
    chain: ['Student boards', 'Boarding confirmation'] },
  { time: '08:31', title: 'Safe arrival at the gate', role: 'Safety', icon: 'door', route: '/smart-gate',
    body: 'RFID at the Main Gate registers entry at 08:31. At 08:32 the parent is notified that Aditya has arrived safely.',
    chain: ['Student reaches school', 'Safe-arrival notification'] },
  { time: '09:00', title: 'Teacher marks attendance in one tap', role: 'Teacher', icon: 'checkSquare', route: '/attendance',
    body: 'Ms. Priya opens Grade 5A, marks the absentees and late arrivals, and submits. Absence alerts go to those parents on WhatsApp within the minute.',
    chain: ['Teacher marks attendance', 'Attendance saved', 'Absent student identified', 'WhatsApp parent alert'] },
  { time: '09:05', title: 'Command Center reflects the live pulse', role: 'Management', icon: 'pulse', route: '/command-center',
    body: 'The Principal sees attendance, staff presence, admissions follow-ups and the students needing attention as they happen.',
    live: (l) => `The Principal sees ${l.present.toLocaleString('en-IN')} students present (${l.marked} of ${l.students} marked so far), ${l.staffPresent} of ${l.staffTotal} staff in, ${l.followUps} admissions follow-ups overdue and ${l.openSignals} students with open Early Warning signals.`,
    chain: ['Pattern analysed', 'Early Warning if required'] },
  { time: '10:20', title: 'Classroom activity and learning evidence', role: 'Teacher', icon: 'bookOpen', route: '/copilot',
    body: 'The fractions lesson drafted with the AI Co-Pilot runs in R-204. The teacher edited two activities before approving it yesterday.',
    chain: ['Teacher intervention'] },
  { time: '11:30', title: 'Assessment marks feed the profile', role: 'Academics', icon: 'clipboard', route: '/assessments',
    body: 'Science marks are entered for the class. Each score lands in the student profile and updates the learning-gap view.',
    chain: ['Assessment', 'Performance data', 'Learning gap'] },
  { time: '12:15', title: 'Parent communication', role: 'Parent', icon: 'message', route: '/parent-communication',
    body: 'Sanjana\'s absence triggers an automated note. The counsellor follows up by phone and records the outcome against the signal.',
    chain: ['Action recorded in Student 360'] },
  { time: '13:40', title: 'Fee payment and receipt', role: 'Finance', icon: 'wallet', route: '/fees',
    body: 'A Term 3 instalment is paid by UPI from the Parent app. The receipt is issued instantly and sent on WhatsApp.',
    live: (l) => `A Term 3 instalment is paid by UPI from the Parent app. The receipt is issued instantly and sent on WhatsApp.${l.collectedToday != null ? ` Collections recorded so far today: ₹${Math.round(l.collectedToday).toLocaleString('en-IN')}.` : ''}`,
    chain: ['Pay Now', 'Payment success', 'Receipt', 'WhatsApp receipt'] },
  { time: '15:45', title: 'Staff attendance and overtime', role: 'Workforce', icon: 'briefcase', route: '/workforce',
    body: 'Transport staff close their split shift. Overtime hours for the Rear Gate cover flow straight into the payroll input queue.',
    chain: ['Attendance', 'Overtime', 'Approval'] },
  { time: '16:30', title: 'Management review', role: 'Management', icon: 'chart', route: '/early-warning',
    body: 'The Principal reviews the day: new Early Warning signals are accepted or dismissed, interventions move on, and transport delays are assigned.',
    live: (l) => `The Principal reviews the day: ${l.awaitingReview} Early Warning signals are waiting for a teacher decision, ${l.approvals} approvals are queued${l.delayedRoutes ? `, and ${l.delayedRoutes} is assigned to transport` : ''}.`,
    chain: ['Teacher action', 'Intervention'] },
  { time: '17:30', title: 'End-of-day reporting', role: 'Management', icon: 'fileText', route: '/reports',
    body: 'The daily brief is generated: attendance, safety events, admissions movement, collections and open approvals for tomorrow.',
    chain: ['Progress measurement'] },
];

export const ROLE_TONE: Record<string, string> = {
  Parent: 'success', Transport: 'warning', Safety: 'critical', Teacher: 'info', Management: 'info', Academics: 'info', Finance: 'success', Workforce: 'warning',
};

export interface AutomationFlow { id: string; title: string; icon: string; route: string; steps: string[]; note: string }

export const AUTOMATIONS: AutomationFlow[] = [
  { id: 'attendance', title: 'Attendance automation', icon: 'checkSquare', route: '/attendance',
    steps: ['Teacher marks attendance', 'Attendance saved', 'Absent student identified', 'WhatsApp parent alert', 'Pattern analysed', 'Early Warning if required', 'Teacher intervention', 'Action recorded in Student 360'],
    note: 'One tap by the teacher produces the parent alert, the pattern check and, only if the threshold is met, a signal for teacher review.' },
  { id: 'bus', title: 'Bus automation', icon: 'bus', route: '/bus-tracking',
    steps: ['Bus starts', 'GPS tracking', 'Parent sees ETA', 'Student boards', 'Boarding confirmation', 'Student reaches school', 'Safe-arrival notification'],
    note: 'GPS, boarding scans and gate entry combine so a parent knows their child is safe without having to ask.' },
  { id: 'admission', title: 'Admission automation', icon: 'users', route: '/admissions',
    steps: ['Enquiry', 'WhatsApp AI', 'Lead created', 'Counsellor assigned', 'Visit scheduled', 'Application', 'Assessment', 'Offer', 'Admission', 'Student Master created'],
    note: 'The WhatsApp assistant answers the first question and creates the lead. Every later stage is a person, supported by the record.' },
  { id: 'payroll', title: 'Payroll automation', icon: 'wallet', route: '/payroll',
    steps: ['Employee Master', 'Attendance', 'Leave', 'Overtime', 'Allowance', 'Approval', 'Payroll', 'Payslip'],
    note: 'Attendance, leave, overtime and allowances arrive without re-keying. Approval is the only manual step before processing.' },
  { id: 'academic', title: 'Academic intelligence', icon: 'brain', route: '/early-warning',
    steps: ['Assessment', 'Performance data', 'Learning gap', 'Student 360', 'Early Warning / Talent Discovery', 'Teacher action', 'Intervention', 'Progress measurement'],
    note: 'Assessment data becomes a learning gap, then a profile entry, then a teacher action, then a measured outcome.' },
];

export const HUMAN_GATES: [string, string][] = [
  ['Early Warning signal', 'A teacher accepts or dismisses before an intervention exists.'],
  ['AI-generated content', 'Reviewed, edited and approved by a named teacher before publishing.'],
  ['Report card comments', 'Drafted by AI, rewritten freely, approved by the teacher and the section head.'],
  ['Payroll', 'Inputs flow in automatically; the run only starts after approval.'],
  ['Emergency broadcast', 'Never automatic. Always a named person, always audited.'],
  ['Certificates', 'Automatic checks, human approval.'],
];

export interface ChatMessage { from: 'parent' | 'ai'; text: string; time: string; quick?: string[] }

export const WHATSAPP: ChatMessage[] = [
  { from: 'parent', text: 'Hi, does Holy Sai offer Cambridge IGCSE?', time: '09:12' },
  { from: 'ai', text: 'Yes. Holy Sai offers Cambridge IGCSE at the Guduvanchery campus, along with Cambridge Primary, Lower Secondary, AS and A Level. Would you like to know about subjects, transport, or schedule a campus visit?', time: '09:12', quick: ['View Curriculum', 'Transport', 'Book Visit', 'Talk to Counsellor'] },
  { from: 'parent', text: 'What subjects are available for Grade 9?', time: '09:14' },
  { from: 'ai', text: 'At Grade 9 the IGCSE core is English, Mathematics and Combined or Separate Sciences. Options include Computer Science, Business Studies, Economics, Art and Design, and a second language. I can send the full subject sheet, or book a counsellor call.', time: '09:14', quick: ['Send subject sheet', 'Book counsellor call'] },
  { from: 'parent', text: 'Book a visit please, weekend if possible.', time: '09:16' },
  { from: 'ai', text: 'Saturday 10:00 or 11:30 are open. Which suits you? I have noted your preference for weekends on the enquiry.', time: '09:16', quick: ['10:00 Saturday', '11:30 Saturday'] },
];

export const WHATSAPP_CRM = [
  { time: '09:12', title: 'Lead created automatically', body: 'Source: WhatsApp. Campaign: Sep Admissions. Contact number captured.', tone: 'teal' },
  { time: '09:12', title: 'Interest recorded — Cambridge IGCSE', body: 'Curriculum preference set on the lead.' },
  { time: '09:14', title: 'Grade interest recorded — Grade 9', body: 'Subject sheet request logged as a follow-up task.' },
  { time: '09:16', title: 'Visit request captured', body: 'Weekend preference noted. Counsellor Kavitha S. assigned by rota.', tone: 'amber' },
  { time: '09:17', title: 'Lead score 68 — qualified', body: 'Moved to Qualified. A counsellor now owns the conversation.', tone: 'teal' },
];

export const WHATSAPP_GUARDRAILS: [string, string][] = [
  ['Answers from approved information only', 'Curriculum, fees, transport and timings come from school records, not from general knowledge.'],
  ['Hands over cleanly', 'Anything it cannot answer goes to a named counsellor, with the conversation attached.'],
  ['Never quotes a discount', 'Fee concessions are a human conversation. The assistant will not negotiate.'],
  ['Never promises admission', 'It can book a visit or an assessment. It cannot offer a place.'],
];

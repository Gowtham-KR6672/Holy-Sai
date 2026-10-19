// Status vocabularies shared by every module.

/** The standard approval path used by leave, payroll, expenses, certificates, AI content and more. */
export const APPROVAL_STATUSES = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const NOTIFICATION_CATEGORIES = ['CRITICAL', 'ATTENTION', 'INFORMATION', 'COMPLETED'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const PRIORITIES = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const AUDIT_ACTIONS = [
  'VIEW',
  'CREATE',
  'UPDATE',
  'DELETE',
  'APPROVE',
  'REJECT',
  'PUBLISH',
  'EXPORT',
  'ASK',
  'LOGIN',
  'LOGIN_FAILED',
  'LOGOUT',
  'DEVICE_AUTH_FAILED',
  'SEED',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const USER_STATUSES = ['ACTIVE', 'INVITED', 'SUSPENDED', 'DISABLED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const ACADEMIC_YEAR_STATUSES = ['PLANNED', 'ACTIVE', 'ARCHIVED'] as const;
export type AcademicYearStatus = (typeof ACADEMIC_YEAR_STATUSES)[number];

/** AI providers the Super Admin can connect. */
export const AI_PROVIDERS = [
  { id: 'claude', label: 'Claude (Anthropic)', defaultModel: 'claude-sonnet-5-5', baseUrl: 'https://api.anthropic.com' },
  { id: 'gemini', label: 'Gemini (Google)', defaultModel: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com' },
  { id: 'openai', label: 'OpenAI', defaultModel: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1' },
  { id: 'groq', label: 'Groq', defaultModel: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1' },
  { id: 'openrouter', label: 'OpenRouter', defaultModel: 'openrouter/auto', baseUrl: 'https://openrouter.ai/api/v1' },
] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number]['id'];

/** What each connected AI provider can be used for. */
export const AI_PURPOSES = [
  { id: 'copilot', label: 'AI Teacher Co-Pilot' },
  { id: 'knowledge', label: 'School Knowledge AI' },
  { id: 'paper_correction', label: 'Paper Correction' },
  { id: 'whatsapp', label: 'WhatsApp AI' },
  { id: 'report_comments', label: 'Report card comments' },
  { id: 'talent', label: 'Talent Discovery' },
  { id: 'analytics', label: 'Ask in plain language' },
] as const;
export type AiPurpose = (typeof AI_PURPOSES)[number]['id'];

/** External services the school connects (configured under Administration › Integrations). */
export const INTEGRATION_KINDS = [
  { id: 'whatsapp', label: 'WhatsApp Business', providers: ['Meta Cloud API', 'Gupshup', 'Interakt'] },
  { id: 'sms', label: 'SMS', providers: ['MSG91', 'Twilio', 'Textlocal'] },
  { id: 'email', label: 'Email', providers: ['SMTP', 'SendGrid', 'Amazon SES'] },
  { id: 'payment', label: 'Payment gateway (UPI, cards, net banking)', providers: ['Razorpay', 'PayU', 'Cashfree'] },
  { id: 'push', label: 'Mobile push notifications', providers: ['Expo Push', 'Firebase Cloud Messaging'] },
  { id: 'gps', label: 'GPS trackers', providers: ['Device token (HTTP)', 'Traccar'] },
  { id: 'gate', label: 'Gate card and face readers', providers: ['Webhook (HTTP)', 'ZKTeco', 'Hikvision'] },
  { id: 'biometric', label: 'Staff biometric attendance', providers: ['Webhook (HTTP)', 'ZKTeco', 'eSSL'] },
  { id: 'maps', label: 'Maps', providers: ['OpenStreetMap', 'Google Maps'] },
  { id: 'storage', label: 'File storage', providers: ['Local disk', 'Amazon S3', 'Cloudflare R2'] },
] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number]['id'];

export interface IntegrationField {
  key: string;
  label: string;
  /** Stored encrypted and never sent back in full. */
  secret?: boolean;
  placeholder?: string;
}

/** The settings each integration needs. */
export const INTEGRATION_FIELDS: Record<IntegrationKind, IntegrationField[]> = {
  whatsapp: [
    { key: 'phoneNumberId', label: 'Phone number ID' },
    { key: 'businessAccountId', label: 'Business account ID' },
    { key: 'accessToken', label: 'Access token', secret: true },
    { key: 'webhookVerifyToken', label: 'Webhook verify token', secret: true },
    { key: 'appSecret', label: 'App secret (verifies incoming webhooks)', secret: true },
    { key: 'apiBaseUrl', label: 'API base URL', placeholder: 'https://graph.facebook.com/v21.0' },
  ],
  sms: [
    { key: 'senderId', label: 'Sender ID (DLT header)' },
    { key: 'dltEntityId', label: 'DLT entity ID' },
    { key: 'apiKey', label: 'API key / auth token', secret: true },
    { key: 'accountSid', label: 'Account SID (Twilio only)' },
  ],
  email: [
    { key: 'host', label: 'SMTP host' },
    { key: 'port', label: 'SMTP port', placeholder: '587' },
    { key: 'user', label: 'Username' },
    { key: 'password', label: 'Password', secret: true },
    { key: 'fromAddress', label: 'From address', placeholder: 'Holy Sai International <noreply@holysai.edu>' },
  ],
  payment: [
    { key: 'keyId', label: 'Key ID' },
    { key: 'keySecret', label: 'Key secret', secret: true },
    { key: 'webhookSecret', label: 'Webhook secret', secret: true },
  ],
  push: [{ key: 'accessToken', label: 'Access token', secret: true }],
  gps: [
    { key: 'staleAfterMinutes', label: 'Stale after (minutes)', placeholder: '30' },
    { key: 'serverUrl', label: 'Traccar server URL (Traccar only)' },
    { key: 'apiToken', label: 'Traccar API token', secret: true },
  ],
  gate: [
    { key: 'gates', label: 'Gates (comma separated)', placeholder: 'Main Gate, Rear Gate, Visitor Gate, Bus Bay' },
    { key: 'webhookSecret', label: 'Webhook secret', secret: true },
  ],
  biometric: [
    { key: 'deviceSerials', label: 'Device serial numbers (comma separated)' },
    { key: 'webhookSecret', label: 'Webhook secret', secret: true },
  ],
  maps: [
    { key: 'tileUrl', label: 'Tile URL', placeholder: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' },
    { key: 'attribution', label: 'Attribution', placeholder: 'OpenStreetMap contributors' },
    { key: 'apiKey', label: 'API key (Google Maps only)', secret: true },
  ],
  storage: [
    { key: 'bucket', label: 'Bucket' },
    { key: 'region', label: 'Region' },
    { key: 'endpoint', label: 'Endpoint (R2 or S3-compatible)' },
    { key: 'accessKeyId', label: 'Access key ID' },
    { key: 'secretAccessKey', label: 'Secret access key', secret: true },
  ],
};

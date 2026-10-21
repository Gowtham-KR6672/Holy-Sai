// Reads and checks the environment once at start-up.

function required(name: string): string {
  const v = process.env[name];
  if (!v || v === 'change-me') throw new Error(`Environment variable ${name} is missing. See apps/api/.env.example.`);
  return v;
}

export interface AppEnv {
  port: number;
  nodeEnv: string;
  isProduction: boolean;
  webOrigins: string[];
  jwtAccessSecret: string;
  jwtAccessTtl: number;
  /** Signs platform-admin tokens (never accepted by school routes). */
  platformJwtSecret: string;
  /** The web app's public address, for payment return links (PUBLIC_WEB_URL, else the first WEB_ORIGIN). */
  publicWebUrl: string;
  encryptionKey: Buffer;
  uploadDir: string;
}

let cached: AppEnv | null = null;

export function env(): AppEnv {
  if (cached) return cached;
  const key = Buffer.from(required('APP_ENCRYPTION_KEY'), 'base64');
  if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes, base64 encoded.');
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const webOrigins = (process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean);
  const jwtAccessSecret = required('JWT_ACCESS_SECRET');
  const platformJwtSecret = required('PLATFORM_JWT_SECRET');
  if (platformJwtSecret === jwtAccessSecret) throw new Error('PLATFORM_JWT_SECRET must differ from JWT_ACCESS_SECRET.');
  cached = {
    port: Number(process.env.PORT ?? 4000),
    nodeEnv,
    isProduction: nodeEnv === 'production',
    webOrigins,
    jwtAccessSecret,
    jwtAccessTtl: Number(process.env.JWT_ACCESS_TTL ?? 900),
    platformJwtSecret,
    publicWebUrl: (process.env.PUBLIC_WEB_URL ?? webOrigins[0] ?? 'http://localhost:5173').replace(/\/+$/, ''),
    encryptionKey: key,
    uploadDir: process.env.UPLOAD_DIR ?? './uploads',
  };
  return cached;
}

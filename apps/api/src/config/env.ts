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
  encryptionKey: Buffer;
  uploadDir: string;
}

let cached: AppEnv | null = null;

export function env(): AppEnv {
  if (cached) return cached;
  const key = Buffer.from(required('APP_ENCRYPTION_KEY'), 'base64');
  if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes, base64 encoded.');
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  cached = {
    port: Number(process.env.PORT ?? 4000),
    nodeEnv,
    isProduction: nodeEnv === 'production',
    webOrigins: (process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
    jwtAccessSecret: required('JWT_ACCESS_SECRET'),
    jwtAccessTtl: Number(process.env.JWT_ACCESS_TTL ?? 900),
    encryptionKey: key,
    uploadDir: process.env.UPLOAD_DIR ?? './uploads',
  };
  return cached;
}

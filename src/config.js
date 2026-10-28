import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const backendRoot = path.resolve(here, '..');
const repoRoot = path.resolve(backendRoot, '..');

// Root .env first, backend/.env can override
dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true });
dotenv.config({ path: path.join(backendRoot, '.env'), override: true, quiet: true });

const bool = (v, d = false) =>
  v == null || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
const trimSlash = (s) => (s || '').replace(/\/+$/, '');
// Relative DB_PATH / UPLOAD_DIR are resolved from the backend folder
const resolveFromRoot = (p) => (path.isAbsolute(p) ? p : path.resolve(backendRoot, p));

export const config = {
  port: Number(process.env.PORT) || 4000,
  publicUrl: trimSlash(process.env.PUBLIC_URL) || 'http://localhost:5173',
  apiUrl: trimSlash(process.env.API_URL),
  jwtSecret: process.env.JWT_SECRET || 'change-me',
  superadminPassword: process.env.SUPERADMIN_PASSWORD || '',
  isProd: process.env.NODE_ENV === 'production',
  cookieSameSite: (process.env.COOKIE_SAMESITE || 'lax').toLowerCase(),

  paymentEnabled: bool(process.env.PAYMENT_ENABLED),
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',

  maxFileMb: Number(process.env.MAX_FILE_MB) || 25,
  fileRetentionMinutes: Number(process.env.FILE_RETENTION_MINUTES) || 60,

  dbPath: process.env.DB_PATH ? resolveFromRoot(process.env.DB_PATH) : path.join(backendRoot, 'data', 'print.db'),
  uploadDir: process.env.UPLOAD_DIR ? resolveFromRoot(process.env.UPLOAD_DIR) : path.join(backendRoot, 'uploads'),
  clientDist: path.join(repoRoot, 'client', 'dist'),

  // Business rules
  agentOfflineAfterMs: 60_000,
  stuckPrintingMs: 5 * 60_000,
  unpaidJobTtlMs: 30 * 60_000,
  maxFileAgeMs: 24 * 60 * 60_000,
  papers: ['A4', 'A5', 'Letter', 'Legal'],
  orientations: ['auto', 'portrait', 'landscape'],
};

if (config.paymentEnabled && (!config.razorpayKeyId || !config.razorpayKeySecret)) {
  console.warn('[config] PAYMENT_ENABLED=true but Razorpay keys are missing — payments will fail.');
}
if (config.isProd && config.jwtSecret === 'change-me') {
  console.warn('[config] JWT_SECRET is still "change-me". Set a long random secret in production!');
}

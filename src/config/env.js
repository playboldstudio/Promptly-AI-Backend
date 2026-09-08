import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment configuration, validated once at startup with zod.
 * Fails fast so misconfigured deploys don't half-boot.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),

  FIREBASE_PROJECT_ID: z.string().min(1, 'FIREBASE_PROJECT_ID is required'),
  FIRESTORE_DATABASE: z.string().optional().default(''),
  FIREBASE_CLIENT_EMAIL: z.string().optional().default(''),
  FIREBASE_PRIVATE_KEY: z.string().optional().default(''),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional().default(''),
  STORAGE_BUCKET: z.string().optional().default(''),

  PLAY_BILLING_PACKAGE_NAME: z.string().optional().default(''),
  GOOGLE_CLOUD_PROJECT: z.string().optional().default(''),
  RTDN_TOPIC: z.string().optional().default(''),
  RTDN_SUBSCRIPTION: z.string().optional().default(''),

  PUBLIC_BASE_URL: z.string().optional().default(''),
  CORS_ORIGINS: z.string().optional().default(''),

  ADMIN_EMAILS: z.string().optional().default(''),

  DEV_AUTH_PASSWORD: z.string().optional().default(''),

  MIN_WITHDRAWAL_INR: z.coerce.number().int().positive().default(60),

  DEPOSIT_MIN_INR: z.coerce.number().int().positive().default(10),
  DEPOSIT_MAX_INR: z.coerce.number().int().positive().default(10000),
  BONUS_EXPIRY_DAYS: z.coerce.number().int().positive().default(90),
  PLAY_BILLING_FEE_TOLERANCE_INR: z.coerce.number().positive().default(0.01),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

/** Emails allowed to use the admin back-office (from ADMIN_EMAILS env). */
export const ADMIN_EMAILS = (env.ADMIN_EMAILS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** True when the email belongs to a platform admin (admin back-office access). */
export function isAdminEmail(email) {
  return Boolean(email && ADMIN_EMAILS.includes(email));
}

/** True when Play Billing is configured (package name set). */
export const hasPlayBilling = Boolean(env.PLAY_BILLING_PACKAGE_NAME);

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

  RAZORPAY_KEY_ID: z.string().optional().default(''),
  RAZORPAY_KEY_SECRET: z.string().optional().default(''),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional().default(''),

  RAZORPAY_PLAN_PRO_ID: z.string().optional().default(''),
  RAZORPAY_PLAN_CREATOR_ID: z.string().optional().default(''),

  PUBLIC_BASE_URL: z.string().optional().default(''),
  CORS_ORIGINS: z.string().optional().default(''),

  ADMIN_EMAILS: z.string().optional().default(''),

  MIN_WITHDRAWAL_INR: z.coerce.number().int().positive().default(60),
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

export const hasRazorpayKeys = Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);

export const RAZORPAY_PLAN_BY_ID = {
  pro: env.RAZORPAY_PLAN_PRO_ID,
  creator: env.RAZORPAY_PLAN_CREATOR_ID,
};

export function razorpayPlanIdFor(planId) {
  return RAZORPAY_PLAN_BY_ID[planId] ?? '';
}

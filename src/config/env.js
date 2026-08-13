import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment configuration, validated once at startup with zod.
 * Fails fast with a clear message so misconfigured deploys don't half-boot.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),

  // Firebase / Firestore — the datastore. FIREBASE_PROJECT_ID is required.
  FIREBASE_PROJECT_ID: z.string().min(1, 'FIREBASE_PROJECT_ID is required'),
  // Service-account (optional — if unset, ADC / Cloud Run default SA is used).
  FIREBASE_CLIENT_EMAIL: z.string().optional().default(''),
  FIREBASE_PRIVATE_KEY: z.string().optional().default(''),
  // Optional — path to a service-account JSON (equivalent to GOOGLE_APPLICATION_CREDENTIALS).
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional().default(''),
  // Google Cloud Storage bucket for uploaded prompt images (optional — only if uploads used).
  STORAGE_BUCKET: z.string().optional().default(''),

  // Razorpay — all optional so the app boots without them (payments throw 501).
  RAZORPAY_KEY_ID: z.string().optional().default(''),
  RAZORPAY_KEY_SECRET: z.string().optional().default(''),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional().default(''),

  // Razorpay Subscription Plan IDs — map our plan id ("pro"/"creator") → Razorpay's
  // plan id, so the app creates subscriptions with the correct billing plan.
  RAZORPAY_PLAN_PRO_ID: z.string().optional().default(''),
  RAZORPAY_PLAN_CREATOR_ID: z.string().optional().default(''),

  // Deploy / URLs — see src/config/urls.js. Single live API URL (Cloud Run).
  PUBLIC_BASE_URL: z.string().optional().default(''),
  // Extra browser origins CORS should accept (comma-separated), e.g. a web
  // frontend dev server. The live API URL is always allowed.
  CORS_ORIGINS: z.string().optional().default(''),

  // Comma-separated emails allowed to use the admin endpoints
  // (/payments/admin/*: payout approval/back-office). Empty = admin disabled.
  ADMIN_EMAILS: z.string().optional().default(''),

  // Payouts — minimum amount (rupees) a creator can withdraw (default ₹60).
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

// True when both Razorpay keys are configured → payment flows can run.
// Routes/services use this to return 501 ("not configured") instead of crashing.
export const hasRazorpayKeys = Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);

// Map our subscription_plans.id ("pro" / "creator") → the Razorpay plan id the user
// created in the dashboard. Paid plans need a Razorpay plan id; "free" never does.
export const RAZORPAY_PLAN_BY_ID = {
  pro: env.RAZORPAY_PLAN_PRO_ID,
  creator: env.RAZORPAY_PLAN_CREATOR_ID,
};

/** Razorpay plan id for a given subscription plan id, or '' if none is configured. */
export function razorpayPlanIdFor(planId) {
  return RAZORPAY_PLAN_BY_ID[planId] ?? '';
}

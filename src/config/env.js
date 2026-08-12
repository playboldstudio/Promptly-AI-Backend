import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment configuration, validated once at startup with zod.
 * Fails fast with a clear message so misconfigured deploys don't half-boot.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required (e.g. postgresql://user:pass@host:5432/promptly)'),

  // Razorpay — all optional so the app boots without them (payments throw 501).
  RAZORPAY_KEY_ID: z.string().optional().default(''),
  RAZORPAY_KEY_SECRET: z.string().optional().default(''),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional().default(''),

  // Razorpay Subscription Plan IDs — map our plan id ("pro"/"creator") → Razorpay's
  // plan id, so the app creates subscriptions with the correct billing plan.
  RAZORPAY_PLAN_PRO_ID: z.string().optional().default(''),
  RAZORPAY_PLAN_CREATOR_ID: z.string().optional().default(''),

  // Deploy / URLs — see src/config/urls.js. There is no local/test URL anymore:
  // everything uses the single LIVE API URL.
  PUBLIC_BASE_URL: z.string().optional().default(''),
  // Extra browser origins CORS should accept (comma-separated), e.g. a web
  // frontend dev server. The live API URL is always allowed.
  CORS_ORIGINS: z.string().optional().default(''),
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

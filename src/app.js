import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import healthRouter from './routes/health.js';
import authRouter from './routes/auth.js';
import promptsRouter from './routes/prompts.js';
import adminPromptsRouter from './routes/admin-prompts.js';
import meRouter from './routes/me.js';
import paymentsRouter from './routes/payments.js';
import webhooksRouter from './routes/webhooks.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';
import { env } from './config/env.js';
import { allowedOrigins } from './config/urls.js';

export function createApp() {
  const app = express();

  // Cloud Run / Load Balancer sets X-Forwarded-For — trust it so req.ip (used
  // by rate limiting) reflects the real client, not the proxy.
  app.set('trust proxy', true);

  // Helmet with CORP relaxed to cross-origin: the web app embeds backend-served
  // images (watermarked paid covers, avatars) via <img> — "same-origin" would
  // block those cross-origin no-cors loads. Scripted reads stay CORS-guarded.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  // CORS — open in development, locked to known origins in production.
  const origins = allowedOrigins();
  const allowAll = env.NODE_ENV !== 'production';
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin) return cb(null, true); // non-browser caller
        cb(null, allowAll || origins.has(origin));
      },
    }),
  );
  app.use(morgan(env.NODE_ENV === 'development' ? 'dev' : 'combined'));

  // Webhook route needs the RAW body for Razorpay signature verification (HMAC).
  // Mount it BEFORE the JSON parser.
  app.use('/webhooks/razorpay', express.raw({ type: 'application/json' }), webhooksRouter);

  app.use(express.json({ limit: '1mb' }));

  app.use(healthRouter);
  app.use(authRouter);
  app.use(promptsRouter);
  app.use(adminPromptsRouter);
  app.use('/me', meRouter);
  app.use('/payments', paymentsRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

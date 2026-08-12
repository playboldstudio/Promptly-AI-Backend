import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import healthRouter from './routes/health.js';
import authRouter from './routes/auth.js';
import promptsRouter from './routes/prompts.js';
import meRouter from './routes/me.js';
import paymentsRouter from './routes/payments.js';
import webhooksRouter from './routes/webhooks.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';
import { env } from './config/env.js';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(morgan(env.NODE_ENV === 'development' ? 'dev' : 'combined'));

  // Webhook route needs the RAW body for Razorpay signature verification (HMAC).
  // Mount it BEFORE the JSON parser.
  app.use('/webhooks/razorpay', express.raw({ type: 'application/json' }), webhooksRouter);

  // Everything else parses JSON normally.
  app.use(express.json({ limit: '1mb' }));

  app.use(healthRouter);
  app.use(authRouter);
  app.use(promptsRouter);
  app.use('/me', meRouter);
  app.use('/payments', paymentsRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

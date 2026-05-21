import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import pinoHttp from 'pino-http';
import rateLimit from 'express-rate-limit';
import { env } from '@/config/env.js';
import { logger } from '@/config/logger.js';
import { errorHandler, notFound } from '@/middleware/errors.js';
import authRoutes from '@/modules/auth/auth.routes.js';
import hospitalsRoutes from '@/modules/hospitals/hospitals.routes.js';
import interestFormsRoutes from '@/modules/interest-forms/interest-forms.routes.js';
import tasksRoutes from '@/modules/tasks/tasks.routes.js';
import meRoutes from '@/modules/me/me.routes.js';
import staffRoutes from '@/modules/staff/staff.routes.js';
import reportsRoutes from '@/modules/reports/reports.routes.js';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()),
      credentials: true,
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(pinoHttp({ logger }));

  // Auth rate limit
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/auth', authLimiter);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', env: env.NODE_ENV, time: new Date().toISOString() });
  });

  app.use('/auth', authRoutes);
  app.use('/hospitals', hospitalsRoutes);
  app.use('/interest-forms', interestFormsRoutes);
  app.use('/tasks', tasksRoutes);
  app.use('/me', meRoutes);
  app.use('/staff', staffRoutes);
  app.use('/reports', reportsRoutes);

  // TODO: mount other module routes as they're built
  // app.use('/enrollments', enrollmentsRoutes);
  // app.use('/meetings', meetingsRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

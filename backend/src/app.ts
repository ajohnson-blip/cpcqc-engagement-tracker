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
import tasksRoutes from '@/modules/tasks/tasks.routes.js';
import meRoutes from '@/modules/me/me.routes.js';
import staffRoutes from '@/modules/staff/staff.routes.js';
import importsRoutes from '@/modules/imports/imports.routes.js';
import ceRoutes from '@/modules/ce/ce.routes.js';
import publicInterestRouter from '@/modules/annual-interest-forms/public-interest.routes.js';
import reportsRoutes from '@/modules/reports/reports.routes.js';
import issueReportsRoutes from '@/modules/issue-reports/issue-reports.routes.js';
import {
  portalAnnualInterestRouter,
  staffAnnualInterestRouter,
} from '@/modules/annual-interest-forms/annual-interest-forms.routes.js';

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
  app.use('/tasks', tasksRoutes);
  app.use('/me', meRoutes);
  app.use('/staff', staffRoutes);
  // /staff/imports handles xlsx uploads with a route-scoped raw body parser;
  // the global json() parser above ignores non-JSON content types so they
  // coexist cleanly.
  app.use('/staff/imports', importsRoutes);
  // CE certificates: roster uploads use the same raw-body approach as imports.
  app.use('/staff/ce', ceRoutes);
  app.use('/issue-reports', issueReportsRoutes);
  app.use('/reports', reportsRoutes);
  // 2-step annual enrollment, step 1: hospital portal submission + staff triage.
  // Public, UNAUTHENTICATED interest submission — people without a portal
  // account must be able to complete an interest form.
  app.use('/public/interest-forms', publicInterestRouter);
  app.use('/portal/annual-interest-forms', portalAnnualInterestRouter);
  app.use('/staff/annual-interest-forms', staffAnnualInterestRouter);

  // TODO: mount other module routes as they're built
  // app.use('/enrollments', enrollmentsRoutes);
  // app.use('/meetings', meetingsRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

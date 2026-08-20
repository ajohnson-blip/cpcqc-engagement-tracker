/**
 * Public enrollment-form endpoints, mounted at /public/enrollment-forms.
 *
 * UNAUTHENTICATED by design — hospitals must be able to enroll without a portal
 * account. Everything is treated as hostile input, the window is enforced here
 * rather than trusted from the page, and submits are rate-limited because each
 * writes a row and sends mail.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { listHospitalsForPublicForm } from '@/modules/annual-interest-forms/public-interest.service.js';
import {
  ENROLLABLE,
  EHR_OPTIONS,
  CHAMPION_ROLES,
  getEnrollmentStepWindow,
  getEnrollmentContext,
  getChampionsToCopy,
  submitEnrollmentForm,
  verifyEnrollmentForm,
} from './enrollment-forms.service.js';

const router = Router();

const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many submissions from this connection. Please try again later.' },
});

const yearSchema = z.coerce.number().int().min(2020).max(2100);
const codeSchema = z.enum(ENROLLABLE);

/** Static shape of the form, so the page doesn't re-declare roles or EHR options
 *  and drift from what the server validates. */
router.get('/config', (_req, res) => {
  res.json({ initiatives: ENROLLABLE, ehrOptions: EHR_OPTIONS, championRoles: CHAMPION_ROLES });
});

router.get('/window', async (req, res) => {
  res.json(await getEnrollmentStepWindow(yearSchema.parse(req.query.programYear)));
});

router.get('/hospitals', async (_req, res) => {
  res.json({ hospitals: await listHospitalsForPublicForm() });
});

router.get('/context', async (req, res) => {
  const programYear = yearSchema.parse(req.query.programYear);
  const hospitalId = z.string().min(1).parse(req.query.hospitalId);
  const initiativeCode = codeSchema.parse(req.query.initiativeCode);
  res.json(await getEnrollmentContext(hospitalId, initiativeCode, programYear));
});

router.get('/champions-to-copy', async (req, res) => {
  const programYear = yearSchema.parse(req.query.programYear);
  const hospitalId = z.string().min(1).parse(req.query.hospitalId);
  const from = z.string().min(1).parse(req.query.fromInitiative);
  res.json({ champions: await getChampionsToCopy(hospitalId, from, programYear) });
});

const championSchema = z.object({
  role: z.enum(['nurse', 'provider', 'data', 'csuite', 'other']),
  name: z.string().trim().max(200).default(''),
  email: z.string().trim().max(320).default(''),
  title: z.string().trim().max(200).default(''),
  isPrimary: z.boolean().default(false),
  redcapAccess: z.boolean().default(false),
  dashboardAccess: z.boolean().default(false),
});

const submitSchema = z.object({
  programYear: yearSchema,
  hospitalId: z.string().min(1),
  initiativeCode: codeSchema,
  submitterName: z.string().trim().min(1).max(200),
  submitterRole: z.string().trim().min(1).max(200),
  submitterEmail: z.string().trim().email(),
  ehr: z.string().max(200).optional(),
  ehrOther: z.string().max(200).optional(),
  champions: z.array(championSchema).max(10).optional(),
  tttContinuationAttested: z.boolean().optional(),
});

router.post('/', submitLimiter, async (req, res) => {
  const input = submitSchema.parse(req.body);
  const window = await getEnrollmentStepWindow(input.programYear);
  if (window.state !== 'open') {
    res.status(400).json({ message: 'The enrollment window is not open.' });
    return;
  }
  res.status(201).json(await submitEnrollmentForm(input));
});

router.post('/verify', async (req, res) => {
  const token = z.string().min(20).parse((req.body as { token?: string })?.token);
  res.json(await verifyEnrollmentForm(token));
});

export default router;

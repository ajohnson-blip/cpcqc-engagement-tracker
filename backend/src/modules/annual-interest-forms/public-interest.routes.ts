/**
 * Public interest-form endpoints, mounted at /public/interest-forms.
 *
 * Deliberately UNAUTHENTICATED — this is the whole point of the change: people
 * without a portal account must be able to submit. Everything here is therefore
 * treated as hostile input, and the submit endpoint is rate-limited because it
 * both writes a row and sends email.
 *
 * Nothing here exposes anything a hospital would consider private: the hospital
 * list and a hospital's current initiatives are public programme facts.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { getEnrollmentWindow, windowStateFor } from './annual-interest-forms.service.js';
import {
  listHospitalsForPublicForm,
  getPublicHospitalContext,
  submitPublicInterestForm,
  verifyPublicInterestForm,
} from './public-interest.service.js';

const router = Router();

/** Each submit writes a row and sends mail, so it gets a tighter cap than reads. */
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many submissions from this connection. Please try again later.' },
});

const yearSchema = z.coerce.number().int().min(2020).max(2100);

router.get('/window', async (req, res) => {
  const programYear = yearSchema.parse(req.query.programYear);
  const window = await getEnrollmentWindow(programYear);
  // No configured window means the year isn't open for interest yet — report
  // that rather than 500ing, so the page can say so plainly.
  res.json({ window, state: window ? windowStateFor(window) : 'before' });
});

router.get('/hospitals', async (_req, res) => {
  res.json({ hospitals: await listHospitalsForPublicForm() });
});

router.get('/context', async (req, res) => {
  const programYear = yearSchema.parse(req.query.programYear);
  const hospitalId = z.string().min(1).parse(req.query.hospitalId);
  res.json(await getPublicHospitalContext(hospitalId, programYear));
});

const submitSchema = z.object({
  programYear: yearSchema,
  hospitalId: z.string().min(1),
  submitterName: z.string().trim().min(1).max(200),
  submitterRole: z.string().trim().min(1).max(200),
  submitterEmail: z.string().trim().email(),
  intendedInitiativeCount: z.coerce.number().int().min(0).max(2),
  rankedInitiatives: z
    .array(z.object({ code: z.enum(['SPARK', 'SOAR', 'NEST']), rank: z.number().int().min(1).max(3) }))
    .max(3),
  reasoning: z.record(z.enum(['SPARK', 'SOAR', 'NEST']), z.string().max(4000)).default({}),
});

router.post('/', submitLimiter, async (req, res) => {
  const input = submitSchema.parse(req.body);
  const window = await getEnrollmentWindow(input.programYear);
  if (!window || windowStateFor(window) !== 'open') {
    // Checked server-side as well as in the UI — the window is the rule, not a
    // rendering detail, and this endpoint is reachable without the page.
    res.status(400).json({ message: 'The interest window is not open.' });
    return;
  }
  res.status(201).json(await submitPublicInterestForm(input));
});

router.post('/verify', async (req, res) => {
  const token = z.string().min(20).parse((req.body as { token?: string })?.token);
  res.json(await verifyPublicInterestForm(token));
});

export default router;

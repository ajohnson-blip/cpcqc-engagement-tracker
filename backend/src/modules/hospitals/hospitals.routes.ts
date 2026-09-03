import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireStaff } from '@/middleware/auth.js';
import {
  listHospitals,
  getHospital,
  createHospital,
  updateHospital,
} from './hospitals.service.js';
import {
  getHospitalTags,
  listHospitalsForTag,
  listTags,
  setHospitalTags,
} from './hospital-tags.service.js';

const router = Router();

router.get('/', requireAuth, async (req, res) => {
  const query = z
    .object({
      search: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    })
    .parse(req.query);
  const result = await listHospitals(query);
  res.json(result);
});

// ---------- Cohort tags ----------
//
// The collection-level routes sit above /:id: Express matches in order, so
// registering them after would have "tags" parsed as a hospital id.

router.get('/tags', requireAuth, requireStaff, async (req, res) => {
  res.json({ tags: await listTags(req.auth!) });
});

router.get('/tags/:tag/hospitals', requireAuth, requireStaff, async (req, res) => {
  const tag = z.string().min(1).max(80).parse(req.params.tag);
  res.json({ tag, hospitals: await listHospitalsForTag(tag, req.auth!) });
});

router.get('/:id', requireAuth, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const hospital = await getHospital(id);
  res.json({ hospital });
});

const createSchema = z.object({
  name: z.string().min(2).max(200),
  cmsId: z.string().optional().nullable(),
  npi: z.string().optional().nullable(),
  region: z.string().optional().nullable(),
  addressLine1: z.string().optional().nullable(),
  addressLine2: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  state: z.string().optional().nullable(),
  postalCode: z.string().optional().nullable(),
  defaultContactName: z.string().optional().nullable(),
  defaultContactEmail: z.string().email().optional().nullable(),
  notes: z.string().optional().nullable(),
});

router.post('/', requireAuth, requireStaff, async (req, res) => {
  const body = createSchema.parse(req.body);
  const hospital = await createHospital(body);
  res.status(201).json({ hospital });
});

const updateSchema = createSchema.partial().extend({ inGoodStanding: z.boolean().optional() });

router.patch('/:id', requireAuth, requireStaff, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const body = updateSchema.parse(req.body);
  const hospital = await updateHospital(id, body);
  res.json({ hospital });
});

router.get('/:id/tags', requireAuth, requireStaff, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  res.json({ tags: await getHospitalTags(id, req.auth!) });
});

router.put('/:id/tags', requireAuth, requireStaff, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const body = z.object({ tags: z.array(z.string().max(80)).max(20) }).parse(req.body);
  res.json({ tags: await setHospitalTags(id, body.tags, req.auth!) });
});

export default router;

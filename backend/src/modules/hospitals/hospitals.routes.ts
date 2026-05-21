import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireStaff } from '@/middleware/auth.js';
import {
  listHospitals,
  getHospital,
  createHospital,
  updateHospital,
} from './hospitals.service.js';

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

export default router;

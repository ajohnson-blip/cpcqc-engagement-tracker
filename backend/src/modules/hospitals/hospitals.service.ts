import { v4 as uuid } from 'uuid';
import { eq, ilike, sql } from 'drizzle-orm';
import { db, schema } from '@/db/index.js';
import { HttpError } from '@/middleware/errors.js';

export interface HospitalListParams {
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listHospitals(params: HospitalListParams = {}) {
  const { search, limit = 50, offset = 0 } = params;
  const where = search ? ilike(schema.hospitals.name, `%${search}%`) : undefined;

  const rows = await db
    .select()
    .from(schema.hospitals)
    .where(where)
    .orderBy(schema.hospitals.name)
    .limit(limit)
    .offset(offset);

  const totalRow = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.hospitals)
    .where(where);
  const total = totalRow[0]?.count ?? 0;

  return { hospitals: rows, total, limit, offset };
}

export async function getHospital(id: string) {
  const hospital = await db.query.hospitals.findFirst({
    where: eq(schema.hospitals.id, id),
  });
  if (!hospital) throw new HttpError(404, 'Hospital not found');
  return hospital;
}

export async function findHospitalByName(name: string) {
  return db.query.hospitals.findFirst({
    where: sql`lower(${schema.hospitals.name}) = lower(${name})`,
  });
}

export interface CreateHospitalInput {
  name: string;
  cmsId?: string | null;
  npi?: string | null;
  region?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  defaultContactName?: string | null;
  defaultContactEmail?: string | null;
  notes?: string | null;
}

export async function createHospital(input: CreateHospitalInput) {
  const existing = await findHospitalByName(input.name);
  if (existing) throw new HttpError(409, `Hospital "${input.name}" already exists`);
  const id = uuid();
  await db.insert(schema.hospitals).values({
    id,
    name: input.name,
    cmsId: input.cmsId ?? null,
    npi: input.npi ?? null,
    region: input.region ?? null,
    addressLine1: input.addressLine1 ?? null,
    addressLine2: input.addressLine2 ?? null,
    city: input.city ?? null,
    state: input.state ?? 'CO',
    postalCode: input.postalCode ?? null,
    defaultContactName: input.defaultContactName ?? null,
    defaultContactEmail: input.defaultContactEmail ?? null,
    notes: input.notes ?? null,
  });
  return getHospital(id);
}

export async function findOrCreateHospitalByName(name: string, defaults?: Partial<CreateHospitalInput>) {
  const existing = await findHospitalByName(name);
  if (existing) return existing;
  return createHospital({ name, state: 'CO', ...defaults });
}

export interface UpdateHospitalInput extends Partial<CreateHospitalInput> {
  inGoodStanding?: boolean;
}

export async function updateHospital(id: string, input: UpdateHospitalInput) {
  await getHospital(id); // 404 if missing
  await db
    .update(schema.hospitals)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.cmsId !== undefined && { cmsId: input.cmsId }),
      ...(input.npi !== undefined && { npi: input.npi }),
      ...(input.region !== undefined && { region: input.region }),
      ...(input.addressLine1 !== undefined && { addressLine1: input.addressLine1 }),
      ...(input.addressLine2 !== undefined && { addressLine2: input.addressLine2 }),
      ...(input.city !== undefined && { city: input.city }),
      ...(input.state !== undefined && { state: input.state }),
      ...(input.postalCode !== undefined && { postalCode: input.postalCode }),
      ...(input.defaultContactName !== undefined && { defaultContactName: input.defaultContactName }),
      ...(input.defaultContactEmail !== undefined && { defaultContactEmail: input.defaultContactEmail }),
      ...(input.notes !== undefined && { notes: input.notes }),
      ...(input.inGoodStanding !== undefined && { inGoodStanding: input.inGoodStanding }),
      updatedAt: new Date(),
    })
    .where(eq(schema.hospitals.id, id));
  return getHospital(id);
}

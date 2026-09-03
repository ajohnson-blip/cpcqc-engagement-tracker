/**
 * Cohort tags — arbitrary groupings of hospitals CPCQC reports on as a set.
 *
 * Membership changes rarely (roughly once a grant cycle), so this is
 * deliberately small: list the cohorts, read one's members, and set a
 * hospital's tags wholesale. There is no rename, because a rename is
 * indistinguishable from tagging a different cohort and would silently rewrite
 * what a past report referred to.
 */
import { eq, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, schema } from '@/db/index.js';
import { HttpError } from '@/middleware/errors.js';
import type { AuthContext } from '@/middleware/auth.js';

function assertStaff(ctx: AuthContext): void {
  if (ctx.role !== 'cpcqc_staff' && ctx.role !== 'cpcqc_admin') {
    throw new HttpError(403, 'Staff only.');
  }
}

/** Trimmed and whitespace-collapsed; the DB index handles case. */
export function normalizeTag(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

export interface CohortTag {
  tag: string;
  hospitals: number;
}

export async function listTags(ctx: AuthContext): Promise<CohortTag[]> {
  assertStaff(ctx);
  const rows = await db
    .select({
      tag: schema.hospitalTags.tag,
      hospitals: sql<number>`count(*)::int`,
    })
    .from(schema.hospitalTags)
    .groupBy(schema.hospitalTags.tag)
    .orderBy(schema.hospitalTags.tag);
  return rows;
}

export async function listHospitalsForTag(
  tag: string,
  ctx: AuthContext,
): Promise<Array<{ id: string; name: string }>> {
  assertStaff(ctx);
  return db
    .select({ id: schema.hospitals.id, name: schema.hospitals.name })
    .from(schema.hospitalTags)
    .innerJoin(schema.hospitals, eq(schema.hospitals.id, schema.hospitalTags.hospitalId))
    .where(sql`lower(${schema.hospitalTags.tag}) = lower(${normalizeTag(tag)})`)
    .orderBy(schema.hospitals.name);
}

export async function getHospitalTags(hospitalId: string, ctx: AuthContext): Promise<string[]> {
  assertStaff(ctx);
  const rows = await db
    .select({ tag: schema.hospitalTags.tag })
    .from(schema.hospitalTags)
    .where(eq(schema.hospitalTags.hospitalId, hospitalId))
    .orderBy(schema.hospitalTags.tag);
  return rows.map((r) => r.tag);
}

/**
 * Replace a hospital's tags with exactly this set.
 *
 * Wholesale rather than add/remove because the UI edits the whole list, and a
 * partial update would leave the two out of step whenever a tag was removed.
 */
export async function setHospitalTags(
  hospitalId: string,
  tags: string[],
  ctx: AuthContext,
): Promise<string[]> {
  assertStaff(ctx);
  const hospital = await db.query.hospitals.findFirst({
    where: eq(schema.hospitals.id, hospitalId),
  });
  if (!hospital) throw new HttpError(404, 'Hospital not found.');

  // Dedupe case-insensitively, keeping the first spelling, so the write cannot
  // trip the unique index the caller can't see.
  const seen = new Map<string, string>();
  for (const raw of tags) {
    const t = normalizeTag(raw);
    if (!t) continue;
    if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  }
  const next = [...seen.values()];

  await db.transaction(async (tx) => {
    await tx.delete(schema.hospitalTags).where(eq(schema.hospitalTags.hospitalId, hospitalId));
    if (next.length > 0) {
      await tx
        .insert(schema.hospitalTags)
        .values(next.map((tag) => ({ hospitalId, tag })));
    }
  });

  await db.insert(schema.auditLog).values({
    id: uuid(),
    actorUserId: ctx.userId ?? null,
    actorRole: 'cpcqc_staff',
    action: 'hospital.tags_set',
    entityType: 'hospital',
    entityId: hospitalId,
    diff: { to: next },
    note: next.length
      ? `Cohort tags for ${hospital.name}: ${next.join(', ')}.`
      : `Cleared cohort tags for ${hospital.name}.`,
  });

  return next.sort((a, b) => a.localeCompare(b));
}

/** Hospital ids in a cohort — used to scope reports. */
export async function hospitalIdsForTag(tag: string): Promise<string[]> {
  const rows = await db
    .select({ id: schema.hospitalTags.hospitalId })
    .from(schema.hospitalTags)
    .where(sql`lower(${schema.hospitalTags.tag}) = lower(${normalizeTag(tag)})`);
  return rows.map((r) => r.id);
}

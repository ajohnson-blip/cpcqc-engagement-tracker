/**
 * One-off: split UCHealth Memorial into Central and North for program year 2027.
 *
 * In 2026 the two enrolled as a single entity, recorded as one hospital
 * ("UCHealth Memorial Hospital Central/UCHealth Memorial Hospital North",
 * CHA 632). From 2027 each must enroll separately, taking the eligible count
 * from 49 to 50. CPCQC decided (2026-09-15):
 *  - the existing record becomes Central. It already carries Central's CDPHE
 *    ID (10542) and CDPHE name, and keeps the 2026 history, accounts and roster;
 *  - North gets a new record: CDPHE 01A456, and CHA "632b" — a tracker-only ID,
 *    since CHA has none for North;
 *  - both continue TtT year 2 as independent enrollments.
 *
 * North joins the TtT cohort from 2027 only. Its 2026 was covered under the
 * combined record, so it gets no 2026 program year, and it counts toward
 * SB24-175 reporting only from 2027 (metadata.eligibleFromProgramYear).
 *
 * Dry run by default; --apply writes. Idempotent: re-running after a partial
 * apply finishes the job without duplicating anything.
 *
 *   NODE_ENV=production DATABASE_URL=… npx tsx scripts/split-uchealth-memorial.ts [--apply]
 */
import { and, eq, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, schema } from '../src/db/index.js';
import { createEnrollment } from '../src/modules/enrollments/enrollments.service.js';

const COMBINED_ID = 'e9b4118c-0923-44f8-91de-aa172d9da83f';
const COMBINED_NAME = 'UCHealth Memorial Hospital Central/UCHealth Memorial Hospital North';
const CENTRAL_NAME = 'UCHealth Memorial Hospital Central';
const NORTH_NAME = 'UCHealth Memorial Hospital North';
const NORTH_CDPHE_ID = '01A456';
const NORTH_CHA_ID = '632b';
const SPLIT_YEAR = 2027;
const apply = process.argv.includes('--apply');

async function audit(action: string, entityType: string, entityId: string, note: string, diff: unknown) {
  await db.insert(schema.auditLog).values({
    id: uuid(),
    actorUserId: null,
    actorRole: 'cpcqc_admin',
    action,
    entityType,
    entityId,
    diff,
    note,
  });
}

async function main() {
  console.log(apply ? '== APPLYING ==' : '== DRY RUN — pass --apply to write ==');

  // 1. The combined record becomes Central.
  const combined = await db.query.hospitals.findFirst({
    where: eq(schema.hospitals.id, COMBINED_ID),
  });
  if (!combined) throw new Error('Combined Memorial record not found.');
  if (combined.name !== COMBINED_NAME && combined.name !== CENTRAL_NAME) {
    throw new Error(`Unexpected name on ${COMBINED_ID}: "${combined.name}". Stopping.`);
  }
  if (combined.name === COMBINED_NAME) {
    console.log(`1. rename "${COMBINED_NAME}" → "${CENTRAL_NAME}"`);
    if (apply) {
      await db
        .update(schema.hospitals)
        .set({
          name: CENTRAL_NAME,
          notes: [
            combined.notes,
            `Enrolled combined with ${NORTH_NAME} through program year 2026 (one CPCQC entity, CHA 632). ` +
              `Its 2026 records and 2025 birth volume cover both facilities. Separate entities from ${SPLIT_YEAR}.`,
          ]
            .filter(Boolean)
            .join('\n'),
          updatedAt: new Date(),
        })
        .where(eq(schema.hospitals.id, COMBINED_ID));
      await audit(
        'hospital.renamed',
        'hospital',
        COMBINED_ID,
        `Renamed to ${CENTRAL_NAME}: Memorial Central and North enroll separately from ${SPLIT_YEAR}.`,
        { from: COMBINED_NAME, to: CENTRAL_NAME },
      );
    }
  } else {
    console.log(`1. rename: already "${CENTRAL_NAME}" — skipped`);
  }

  // 2. North as its own record.
  let north = await db.query.hospitals.findFirst({ where: eq(schema.hospitals.name, NORTH_NAME) });
  if (north) {
    console.log(`2. create North: already exists (${north.id}) — skipped`);
  } else {
    const northId = uuid();
    const meta = (combined.metadata ?? {}) as Record<string, unknown>;
    const values = {
      id: northId,
      name: NORTH_NAME,
      system: combined.system,
      region: combined.region,
      city: combined.city,
      state: combined.state,
      county: combined.county,
      chaHospitalId: NORTH_CHA_ID,
      cdpheId: NORTH_CDPHE_ID,
      metadata: {
        // County-level attributes, shared with Central. Facility-level ones —
        // NICU level, birth volume, street address, AIM ID — are left for CPCQC
        // to supply rather than guessed.
        rae: meta.rae,
        hsr: meta.hsr,
        urbanicity: meta.urbanicity,
        eligibleFromProgramYear: SPLIT_YEAR,
      },
      notes:
        `Separate entity from program year ${SPLIT_YEAR}. Through 2026 it enrolled combined with ` +
        `${CENTRAL_NAME} (CHA 632). CHA ${NORTH_CHA_ID} is a tracker-only ID; CHA has none for North.`,
    };
    console.log('2. create North:', { ...values, id: '(new)' });
    if (apply) {
      await db.insert(schema.hospitals).values(values);
      await audit(
        'hospital.created',
        'hospital',
        northId,
        `Created ${NORTH_NAME}, split from the combined Memorial record for ${SPLIT_YEAR}.`,
        { cdpheId: NORTH_CDPHE_ID, chaHospitalId: NORTH_CHA_ID, eligibleFromProgramYear: SPLIT_YEAR },
      );
      north = await db.query.hospitals.findFirst({ where: eq(schema.hospitals.id, northId) });
    }
  }

  // 3. North's own TtT year-2 enrollment, in the same cohort as Central's.
  const combinedEnrollment = await db
    .select({ cohortId: schema.enrollments.cohortId, code: schema.initiatives.code })
    .from(schema.enrollments)
    .innerJoin(schema.cohorts, eq(schema.cohorts.id, schema.enrollments.cohortId))
    .innerJoin(schema.initiatives, eq(schema.initiatives.id, schema.cohorts.initiativeId))
    .where(and(eq(schema.enrollments.hospitalId, COMBINED_ID), eq(schema.initiatives.code, 'TTT')));
  if (combinedEnrollment.length !== 1) {
    throw new Error(`Expected exactly one TtT enrollment on the combined record, found ${combinedEnrollment.length}.`);
  }
  const cohortId = combinedEnrollment[0]!.cohortId;

  if (!north) {
    console.log(`3. enroll North: would join TtT cohort ${cohortId} for ${SPLIT_YEAR} only, once the record exists`);
  } else {
    const existing = await db.query.enrollments.findFirst({
      where: and(eq(schema.enrollments.hospitalId, north.id), eq(schema.enrollments.cohortId, cohortId)),
    });
    if (existing) {
      console.log('3. enroll North: already enrolled — skipped');
    } else {
      console.log(`3. enroll North: TtT cohort ${cohortId}, program year ${SPLIT_YEAR} only, enrolled ${SPLIT_YEAR}-01-01`);
      if (apply) {
        const r = await createEnrollment({
          hospitalId: north.id,
          cohortId,
          fromYear: SPLIT_YEAR,
          enrolledOn: `${SPLIT_YEAR}-01-01`,
          status: 'enrolled',
        });
        await audit(
          'enrollment.created',
          'enrollment',
          r.enrollmentId,
          `Enrolled ${NORTH_NAME} in TtT year 2 (${SPLIT_YEAR}) as an independent enrollment.`,
          { programYears: r.programYearIds.length, tasks: r.taskInstanceCount },
        );
        console.log('   created:', r);
      }
    }
  }

  // 4. Verify what's actually in the database now.
  if (apply) {
    const check = await db.execute(sql`
      SELECT h.name, py.year, tt.task_type, count(ti.id)::int AS tasks
      FROM hospitals h
      JOIN enrollments e ON e.hospital_id = h.id
      JOIN program_years py ON py.enrollment_id = e.id
      LEFT JOIN task_instances ti ON ti.program_year_id = py.id
      LEFT JOIN task_templates tt ON tt.id = ti.task_template_id
      WHERE h.name IN (${CENTRAL_NAME}, ${NORTH_NAME})
      GROUP BY h.name, py.year, tt.task_type
      ORDER BY h.name, py.year, tt.task_type`);
    console.log('\n4. verification — program years and tasks:');
    console.table(check.rows);
    const total = await db.execute(sql`SELECT count(*)::int AS n FROM hospitals`);
    console.log('   hospitals on roster:', (total.rows[0] as { n: number }).n);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

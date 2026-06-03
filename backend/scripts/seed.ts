/**
 * Seed initiatives, default thresholds, canonical stages, the 49 active Colorado
 * birthing hospitals (from data/hospitals_master_2026.json — the CHA master list),
 * 2026 cohorts (including TTT's 2-year cohort and the SOAR 2026 sustainability
 * cohort), and the Enrollment Form task template per (initiative × track).
 *
 * Run order:
 *   npm run db:migrate
 *   npm run db:seed                # this script
 *   npm run db:import-templates    # full task template set from XLSX
 *   npm run db:enroll              # auto-create enrollments from participation data
 *   npm run db:import-pm-data      # backfill engagement data
 *
 * Idempotent: re-running won't duplicate rows.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuid } from 'uuid';
import { db, schema, pool } from '../src/db/index.js';
import { REQUIRED_ASSESSMENTS_PER_YEAR } from '../src/modules/compliance/hra.js';
import { eq, and } from 'drizzle-orm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOSPITAL_DATA_PATH = path.resolve(__dirname, '../../data/hospitals_master_2026.json');

interface HospitalRecord {
  chaHospitalId: string | null;
  name: string;
  cdpheName: string | null;
  tableauNickname: string | null;
  system: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  county: string | null;
  cdpheId: string | null;
  aimId: string | null;
  nicuLevel: string | null;
  urbanicity: string | null;
  birthVolume2025: number | null;
  rae: number | null;
  hsr: number | null;
  participation: {
    SOAR: { participating: boolean; status2026: string | null };
    TTT: { participating: boolean };
    SPARK: { participating: boolean };
    NEST: { participating: boolean };
  };
}

interface HospitalDataFile {
  asOf: string;
  source: string;
  taxonomy: string;
  count: number;
  hospitals: HospitalRecord[];
}

function loadHospitals(): HospitalDataFile {
  if (!fs.existsSync(HOSPITAL_DATA_PATH)) {
    throw new Error(
      `Hospital master list not found at ${HOSPITAL_DATA_PATH}. ` +
        `Regenerate it from Hospitals.xlsx (the CHA master list).`,
    );
  }
  return JSON.parse(fs.readFileSync(HOSPITAL_DATA_PATH, 'utf8')) as HospitalDataFile;
}

const INITIATIVES = [
  {
    code: 'TTT' as const,
    name: 'Turning the Tide: Perinatal Substance Use',
    description: 'Statewide QI initiative to improve perinatal substance use care.',
    cohortLengthYears: 2,
    defaultDataCadence: 'monthly' as const,
    brandColor: '#3FA9F5',
    emoji: '🌊',
  },
  {
    code: 'SPARK' as const,
    name: 'SPARK: Postpartum Discharge Transitions',
    description: 'Initiative to strengthen postpartum discharge transitions.',
    cohortLengthYears: 1,
    defaultDataCadence: 'quarterly' as const,
    brandColor: '#F7A23B',
    emoji: '✨',
  },
  {
    code: 'SOAR' as const,
    name: 'SOAR: Primary Cesarean Reduction',
    description: 'Initiative to reduce primary cesarean rates statewide.',
    cohortLengthYears: 1,
    defaultDataCadence: 'monthly' as const,
    brandColor: '#3FB7B0',
    emoji: '🪁',
  },
  {
    code: 'NEST' as const,
    name: 'NEST: Infant Safe Sleep',
    description: 'Initiative to improve infant safe sleep practices.',
    cohortLengthYears: 1,
    defaultDataCadence: 'monthly' as const,
    brandColor: '#E6B655',
    emoji: '🐣',
  },
];

// HRA = Hospital Readiness Assessment. Required bi-annually for every initiative
// and both tracks, so requiredAssessments is the same for all. The two HRAs are
// normally due Q1 + Q4; the SPARK 2026 Q2 + Q4 exception is a per-program-year
// schedule (program_years.hra_schedule), not a change to this count.
const ACTIVE_DEFAULTS = {
  requiredMeetings: 9,
  requiredAdvising: 4,
  requiredAssessments: REQUIRED_ASSESSMENTS_PER_YEAR,
};
const SUSTAINABILITY_DEFAULTS = {
  requiredMeetings: 4,
  requiredAdvising: 2,
  requiredAssessments: REQUIRED_ASSESSMENTS_PER_YEAR,
};

const STAGES_DEF: Array<{
  code: string;
  name: string;
  sequence: number;
  track: 'active' | 'sustainability';
  quarter: number | null;
}> = [
  { code: '1.', name: 'Enrollment', sequence: 1, track: 'active', quarter: null },
  { code: '2.1', name: 'Implementation Q1', sequence: 2, track: 'active', quarter: 1 },
  { code: '2.2', name: 'Implementation Q2', sequence: 3, track: 'active', quarter: 2 },
  { code: '2.3', name: 'Implementation Q3', sequence: 4, track: 'active', quarter: 3 },
  { code: '2.4', name: 'Implementation Q4', sequence: 5, track: 'active', quarter: 4 },
  { code: '1.', name: 'Enrollment', sequence: 1, track: 'sustainability', quarter: null },
  { code: '3.1', name: 'Sustainability Q1', sequence: 2, track: 'sustainability', quarter: 1 },
  { code: '3.2', name: 'Sustainability Q2', sequence: 3, track: 'sustainability', quarter: 2 },
  { code: '3.3', name: 'Sustainability Q3', sequence: 4, track: 'sustainability', quarter: 3 },
  { code: '3.4', name: 'Sustainability Q4', sequence: 5, track: 'sustainability', quarter: 4 },
];

async function upsertInitiative(def: (typeof INITIATIVES)[number]) {
  const existing = await db.query.initiatives.findFirst({
    where: eq(schema.initiatives.code, def.code),
  });
  if (existing) return existing;
  const id = uuid();
  await db.insert(schema.initiatives).values({ id, ...def });
  return (await db.query.initiatives.findFirst({ where: eq(schema.initiatives.id, id) }))!;
}

async function upsertHospital(rec: HospitalRecord) {
  const metadata = {
    nicuLevel: rec.nicuLevel,
    urbanicity: rec.urbanicity,
    birthVolume2025: rec.birthVolume2025,
    rae: rec.rae,
    hsr: rec.hsr,
    cdpheName: rec.cdpheName,
  };
  const values = {
    name: rec.name,
    chaHospitalId: rec.chaHospitalId,
    cdpheId: rec.cdpheId,
    aimId: rec.aimId,
    system: rec.system,
    tableauNickname: rec.tableauNickname,
    addressLine1: rec.address,
    city: rec.city,
    state: rec.state ?? 'CO',
    postalCode: rec.postalCode,
    county: rec.county,
    region: rec.rae != null ? `RAE ${rec.rae}` : null,
    metadata,
  };
  let existing = rec.chaHospitalId
    ? await db.query.hospitals.findFirst({
        where: eq(schema.hospitals.chaHospitalId, rec.chaHospitalId),
      })
    : null;
  if (!existing) {
    existing = await db.query.hospitals.findFirst({ where: eq(schema.hospitals.name, rec.name) });
  }
  if (existing) {
    await db
      .update(schema.hospitals)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(schema.hospitals.id, existing.id));
    return existing;
  }
  const id = uuid();
  await db.insert(schema.hospitals).values({ id, ...values });
  return (await db.query.hospitals.findFirst({ where: eq(schema.hospitals.id, id) }))!;
}

async function upsertConfig(
  initiativeId: string,
  track: 'active' | 'sustainability',
  defaults: typeof ACTIVE_DEFAULTS | typeof SUSTAINABILITY_DEFAULTS,
  cadence: 'monthly' | 'quarterly',
  isSparkActive: boolean,
) {
  const existing = await db.query.initiativeTrackConfig.findFirst({
    where: and(
      eq(schema.initiativeTrackConfig.initiativeId, initiativeId),
      eq(schema.initiativeTrackConfig.track, track),
    ),
  });
  let requiredDataPeriods: number;
  let dataSubmissionsMin: number;
  if (track === 'sustainability') {
    requiredDataPeriods = 1;
    dataSubmissionsMin = 1;
  } else if (cadence === 'monthly') {
    // Active monthly hospitals submit 9 of 12 months (matching the meeting
    // attendance rule: "at least 9 of 12 available" per CPCQC).
    requiredDataPeriods = 12;
    dataSubmissionsMin = 9;
  } else {
    requiredDataPeriods = 4;
    dataSubmissionsMin = isSparkActive ? 3 : 4;
  }
  const values = {
    initiativeId,
    track,
    requiredMeetings: defaults.requiredMeetings,
    requiredAdvising: defaults.requiredAdvising,
    requiredAssessments: defaults.requiredAssessments,
    requiredDataPeriods,
    dataSubmissionsMin,
  };
  if (existing) {
    await db
      .update(schema.initiativeTrackConfig)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(schema.initiativeTrackConfig.id, existing.id));
    return;
  }
  await db.insert(schema.initiativeTrackConfig).values({ id: uuid(), ...values });
}

async function upsertStages(initiativeId: string) {
  for (const s of STAGES_DEF) {
    const existing = await db.query.stages.findFirst({
      where: and(
        eq(schema.stages.initiativeId, initiativeId),
        eq(schema.stages.track, s.track),
        eq(schema.stages.code, s.code),
      ),
    });
    if (existing) continue;
    await db.insert(schema.stages).values({
      id: uuid(),
      initiativeId,
      track: s.track,
      code: s.code,
      name: s.name,
      sequence: s.sequence,
      quarter: s.quarter,
    });
  }
}

async function upsertCohort(
  initiativeId: string,
  track: 'active' | 'sustainability',
  label: string,
  startDate: string,
  endDate: string,
) {
  const existing = await db.query.cohorts.findFirst({
    where: and(
      eq(schema.cohorts.initiativeId, initiativeId),
      eq(schema.cohorts.track, track),
      eq(schema.cohorts.startDate, startDate),
    ),
  });
  if (existing) return existing;
  const id = uuid();
  await db.insert(schema.cohorts).values({ id, initiativeId, track, label, startDate, endDate });
  return (await db.query.cohorts.findFirst({ where: eq(schema.cohorts.id, id) }))!;
}

async function upsertEnrollmentFormTemplate(
  initiativeId: string,
  initiativeCode: string,
  track: 'active' | 'sustainability',
) {
  const stage = await db.query.stages.findFirst({
    where: and(
      eq(schema.stages.initiativeId, initiativeId),
      eq(schema.stages.track, track),
      eq(schema.stages.code, '1.'),
    ),
  });
  if (!stage) return;
  const name = `Submit ${initiativeCode}${track === 'sustainability' ? ' sustainability' : ''} annual enrollment form`;
  const existing = await db.query.taskTemplates.findFirst({
    where: and(
      eq(schema.taskTemplates.initiativeId, initiativeId),
      eq(schema.taskTemplates.track, track),
      eq(schema.taskTemplates.stageId, stage.id),
      eq(schema.taskTemplates.name, name),
    ),
  });
  if (existing) return;
  await db.insert(schema.taskTemplates).values({
    id: uuid(),
    initiativeId,
    track,
    stageId: stage.id,
    name,
    taskType: 'enrollment_form',
    period: 'annual',
    periodLabel: 'Annual',
    dueDateRule: 'Before program year begins',
    countsTowardRequirement: true,
    knowledgeCenterUrl: null,
    notes:
      'Annual requirement: a fresh Enrollment Form is submitted every program year, including ' +
      'Year 2 of TTT. Submission is the only step required for enrollment.',
  });
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('Seeding initiatives, configs, stages, cohorts, hospitals...');

  for (const def of INITIATIVES) {
    const ini = await upsertInitiative(def);
    await upsertConfig(ini.id, 'active', ACTIVE_DEFAULTS, def.defaultDataCadence, def.code === 'SPARK');
    if (def.code === 'SOAR') {
      await upsertConfig(ini.id, 'sustainability', SUSTAINABILITY_DEFAULTS, def.defaultDataCadence, false);
    }
    await upsertStages(ini.id);

    if (def.code === 'TTT') {
      await upsertCohort(ini.id, 'active', '2026–2027 TTT Active Cohort', '2026-01-01', '2027-12-31');
    } else {
      await upsertCohort(ini.id, 'active', `2026 ${def.code} Active Cohort`, '2026-01-01', '2026-12-31');
    }
    if (def.code === 'SOAR') {
      await upsertCohort(
        ini.id,
        'sustainability',
        '2026 SOAR Sustainability Cohort',
        '2026-01-01',
        '2026-12-31',
      );
    }

    await upsertEnrollmentFormTemplate(ini.id, def.code, 'active');
    if (def.code === 'SOAR') {
      await upsertEnrollmentFormTemplate(ini.id, def.code, 'sustainability');
    }
  }

  // Hospitals — read from the CHA master list JSON
  const { hospitals } = loadHospitals();
  // eslint-disable-next-line no-console
  console.log(`Seeding ${hospitals.length} hospitals from CHA master list...`);
  for (const rec of hospitals) {
    await upsertHospital(rec);
  }

  // eslint-disable-next-line no-console
  console.log(
    `Seeded ${INITIATIVES.length} initiatives and ${hospitals.length} hospitals.\n` +
      `Next: run db:import-templates, then db:enroll to auto-create enrollments from participation data.`,
  );
}

main()
  .then(() => pool.end())
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    pool.end();
    process.exit(1);
  });

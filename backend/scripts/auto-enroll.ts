/**
 * Auto-create enrollments from the CHA master list's participation columns.
 *
 *   - SOAR Status 2026 = "Active"      → enroll in 2026 SOAR Active Cohort
 *   - SOAR Status 2026 = "Sustainable" → enroll in 2026 SOAR Sustainability Cohort
 *   - Participating TtT  = Yes         → enroll in 2026–2027 TTT Active Cohort
 *   - Participating SPARK = Yes        → enroll in 2026 SPARK Active Cohort
 *   - Participating NEST  = Yes        → enroll in 2026 NEST Active Cohort
 *
 * Each enrollment is created via the existing createEnrollment service, which
 * generates ProgramYear rows and TaskInstance rows from whatever TaskTemplates
 * are currently in the database. Run this *after* db:import-templates so the
 * generated task instances include the full template set.
 *
 * Idempotent: existing enrollments are detected by (hospital, cohort) uniqueness
 * and skipped.
 *
 * Usage:
 *   npm run db:enroll              # commit
 *   npm run db:enroll -- --dry-run # report what would be created
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { db, schema, pool } from '../src/db/index.js';
import { createEnrollment } from '../src/modules/enrollments/enrollments.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOSPITAL_DATA_PATH = path.resolve(__dirname, '../../data/hospitals_master_2026.json');

interface HospitalRecord {
  chaHospitalId: string | null;
  name: string;
  participation: {
    SOAR: { participating: boolean; status2026: string | null };
    TTT: { participating: boolean };
    SPARK: { participating: boolean };
    NEST: { participating: boolean };
  };
}

interface Args {
  dryRun: boolean;
  programYear: number;
}

function parseArgs(): Args {
  const out: Record<string, string | boolean> = {};
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') out['dry-run'] = true;
    else {
      const m = /^--([a-z-]+)=(.+)$/.exec(arg);
      if (m) out[m[1]!] = m[2]!;
    }
  }
  return {
    dryRun: out['dry-run'] === true,
    programYear: typeof out['year'] === 'string' ? parseInt(out['year'], 10) : 2026,
  };
}

interface PlannedEnrollment {
  hospitalName: string;
  hospitalId: string;
  initiativeCode: string;
  track: 'active' | 'sustainability';
  cohortId: string;
  cohortLabel: string;
}

async function main() {
  const args = parseArgs();
  // eslint-disable-next-line no-console
  console.log(`Auto-enrolling for program year ${args.programYear}${args.dryRun ? ' (dry run)' : ''}`);

  const data = JSON.parse(fs.readFileSync(HOSPITAL_DATA_PATH, 'utf8')) as {
    hospitals: HospitalRecord[];
  };

  // Load lookups
  const initiatives = await db.select().from(schema.initiatives);
  const initiativeByCode = new Map(initiatives.map((i) => [i.code, i.id]));

  const cohorts = await db.select().from(schema.cohorts);
  const cohortKey = (initiativeId: string, track: string, year: number) => {
    return cohorts.find((c) => {
      if (c.initiativeId !== initiativeId || c.track !== track) return false;
      const s = new Date(c.startDate).getUTCFullYear();
      const e = new Date(c.endDate).getUTCFullYear();
      return year >= s && year <= e;
    });
  };

  const hospitals = await db.select().from(schema.hospitals);
  const hospitalByCha = new Map(
    hospitals.filter((h) => h.chaHospitalId).map((h) => [h.chaHospitalId!, h]),
  );
  const hospitalByName = new Map(hospitals.map((h) => [h.name.toLowerCase(), h]));

  function resolveHospital(rec: HospitalRecord) {
    if (rec.chaHospitalId && hospitalByCha.has(rec.chaHospitalId)) {
      return hospitalByCha.get(rec.chaHospitalId)!;
    }
    return hospitalByName.get(rec.name.toLowerCase()) ?? null;
  }

  const planned: PlannedEnrollment[] = [];
  const issues: string[] = [];

  for (const rec of data.hospitals) {
    const hospital = resolveHospital(rec);
    if (!hospital) {
      issues.push(`Hospital "${rec.name}" not found in database. Run db:seed first.`);
      continue;
    }

    const targets: Array<{ initiativeCode: 'TTT' | 'SPARK' | 'SOAR' | 'NEST'; track: 'active' | 'sustainability' }> = [];
    const soarStatus = (rec.participation.SOAR.status2026 ?? '').toLowerCase();
    if (rec.participation.SOAR.participating && soarStatus === 'active') {
      targets.push({ initiativeCode: 'SOAR', track: 'active' });
    } else if (soarStatus === 'sustainable' || soarStatus === 'sustainability') {
      // Note: the CHA source spells it "Sustainable"; we normalize to our schema's "sustainability"
      targets.push({ initiativeCode: 'SOAR', track: 'sustainability' });
    }
    if (rec.participation.TTT.participating) targets.push({ initiativeCode: 'TTT', track: 'active' });
    if (rec.participation.SPARK.participating) targets.push({ initiativeCode: 'SPARK', track: 'active' });
    if (rec.participation.NEST.participating) targets.push({ initiativeCode: 'NEST', track: 'active' });

    for (const t of targets) {
      const initiativeId = initiativeByCode.get(t.initiativeCode);
      if (!initiativeId) {
        issues.push(`No initiative ${t.initiativeCode} in DB`);
        continue;
      }
      const cohort = cohortKey(initiativeId, t.track, args.programYear);
      if (!cohort) {
        issues.push(
          `No ${t.initiativeCode} ${t.track} cohort covering ${args.programYear} found in DB`,
        );
        continue;
      }
      planned.push({
        hospitalName: hospital.name,
        hospitalId: hospital.id,
        initiativeCode: t.initiativeCode,
        track: t.track,
        cohortId: cohort.id,
        cohortLabel: cohort.label,
      });
    }
  }

  // Summarize plan
  const byCohort = new Map<string, number>();
  for (const p of planned) {
    const key = `${p.initiativeCode} ${p.track}`;
    byCohort.set(key, (byCohort.get(key) ?? 0) + 1);
  }
  // eslint-disable-next-line no-console
  console.log(`\nPlanned enrollments: ${planned.length}`);
  for (const [key, n] of [...byCohort.entries()].sort()) {
    // eslint-disable-next-line no-console
    console.log(`  ${key}: ${n}`);
  }

  if (issues.length) {
    // eslint-disable-next-line no-console
    console.warn(`\nIssues (${issues.length}):`);
    for (const i of issues.slice(0, 30)) console.warn('  ' + i);
    if (issues.length > 30) console.warn(`  … and ${issues.length - 30} more`);
  }

  if (args.dryRun) {
    // eslint-disable-next-line no-console
    console.log('\nDry run — no enrollments created.');
    return;
  }

  // Apply
  let created = 0;
  let alreadyExists = 0;
  for (const p of planned) {
    // Pre-check to avoid the createEnrollment 409 throw
    const existing = await db.query.enrollments.findFirst({
      where: and(
        eq(schema.enrollments.hospitalId, p.hospitalId),
        eq(schema.enrollments.cohortId, p.cohortId),
      ),
    });
    if (existing) {
      alreadyExists++;
      continue;
    }
    try {
      await createEnrollment({
        hospitalId: p.hospitalId,
        cohortId: p.cohortId,
        status: 'eligible_to_enroll',
      });
      created++;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `Failed to enroll ${p.hospitalName} in ${p.initiativeCode} ${p.track}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `\nCreated ${created} enrollments. Skipped ${alreadyExists} that already existed.`,
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

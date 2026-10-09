/**
 * One-off: remove REDCap record identifiers from stored task payloads.
 *
 * CPCQC's decision is that per-record detail stays in REDCap — a program
 * manager resolving a duplicate or a missing field works there, not in the
 * tracker. Record identifiers in the tracker's database serve no workflow and
 * weaken the claim that no patient-level data reaches the hosting provider, so
 * they are stripped.
 *
 * Only the SPARK sync ever wrote them: `dataRecordIds` (array) and
 * `primaryRecordId` (string), on 20 task instances in 2026-Q1 and Q2.
 * `duplicateRecords` is a boolean and stays — it tells a PM to go and look
 * without saying which record. The array's length is preserved as
 * `competingRecordCount` so that signal is not lost either.
 *
 * The code that wrote these keys was changed in the same commit, so they do
 * not come back on the next sync. Running this against a database whose
 * services still run the old code would be undone by the next SPARK sync.
 *
 * Dry run by default; --apply writes. Idempotent.
 *
 *   NODE_ENV=production DATABASE_URL=… npx tsx scripts/redact-record-identifiers.ts [--apply]
 */
import { sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, schema } from '../src/db/index.js';

const apply = process.argv.includes('--apply');

interface Row {
  id: string;
  period: string;
  hospital: string;
  recordIds: number;
  hasPrimary: boolean;
}

async function main() {
  console.log(apply ? '== APPLYING ==' : '== DRY RUN — pass --apply to write ==');

  const rows = (
    await db.execute(sql`
      SELECT ti.id,
             ti.period,
             h.name AS hospital,
             CASE WHEN jsonb_typeof(ti.payload->'dataRecordIds') = 'array'
                  THEN jsonb_array_length(ti.payload->'dataRecordIds') ELSE 0 END AS record_ids,
             (ti.payload ? 'primaryRecordId') AS has_primary
      FROM task_instances ti
      JOIN enrollments e ON e.id = ti.enrollment_id
      JOIN hospitals h ON h.id = e.hospital_id
      WHERE ti.payload ? 'dataRecordIds' OR ti.payload ? 'primaryRecordId'
      ORDER BY ti.period, h.name`)
  ).rows as unknown as Array<{ id: string; period: string; hospital: string; record_ids: number; has_primary: boolean }>;

  const found: Row[] = rows.map((r) => ({
    id: r.id,
    period: r.period,
    hospital: r.hospital,
    recordIds: Number(r.record_ids),
    hasPrimary: r.has_primary,
  }));

  if (found.length === 0) {
    console.log('\nNothing to redact — no task payload holds a record identifier.');
    process.exit(0);
  }

  console.log(`\n${found.length} task instance(s) hold record identifiers:`);
  console.table(
    found.map((r) => ({
      period: r.period,
      hospital: r.hospital.slice(0, 40),
      dataRecordIds: r.recordIds,
      primaryRecordId: r.hasPrimary ? 'yes' : '—',
    })),
  );
  console.log(
    `\nWould remove: dataRecordIds, primaryRecordId.\n` +
      `Would keep:   duplicateRecords (boolean), and add competingRecordCount (the array length).`,
  );

  if (!apply) {
    process.exit(0);
  }

  for (const r of found) {
    await db.execute(sql`
      UPDATE task_instances
      SET payload = (payload - 'dataRecordIds' - 'primaryRecordId')
                    || jsonb_build_object('competingRecordCount', ${r.recordIds}::int),
          updated_at = now()
      WHERE id = ${r.id}`);

    await db.insert(schema.auditLog).values({
      id: uuid(),
      actorUserId: null,
      actorRole: 'cpcqc_admin',
      action: 'task.record_identifiers_redacted',
      entityType: 'task_instance',
      entityId: r.id,
      // The diff records that identifiers were removed and how many — never
      // the identifiers themselves, which would defeat the point.
      diff: { removed: ['dataRecordIds', 'primaryRecordId'], competingRecordCount: r.recordIds },
      note:
        `Removed REDCap record identifiers from ${r.hospital} ${r.period}. ` +
        'Per-record detail stays in REDCap by CPCQC decision.',
    });
  }

  const [after] = (
    await db.execute(sql`
      SELECT count(*) FILTER (WHERE payload ? 'dataRecordIds' OR payload ? 'primaryRecordId')::int AS still_present,
             count(*) FILTER (WHERE payload ? 'competingRecordCount')::int AS count_preserved,
             count(*) FILTER (WHERE payload::text ILIKE '%recordid%')::int AS any_recordid_text
      FROM task_instances`)
  ).rows as unknown as Array<{ still_present: number; count_preserved: number; any_recordid_text: number }>;

  console.log(`\napplied to ${found.length} task instance(s)`);
  console.log('verification:', after);
  if (after!.still_present > 0 || after!.any_recordid_text > 0) {
    console.error('FAILED — record identifiers remain.');
    process.exit(1);
  }
  console.log('PASS — no task payload holds a record identifier.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

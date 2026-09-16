/**
 * One-off: repair hospital identifiers mangled by the original spreadsheet import.
 *
 * Excel read the ID columns as numbers, so CHA and AIM IDs are stored as floats
 * ("632.0") and numeric CDPHE facility IDs also lost their leading zero
 * ("010542" → "10542.0"). The annual report prints them verbatim, so CDPHE has
 * been receiving mangled IDs. The padding rule was confirmed against CDPHE's own
 * facility record for UCHealth Memorial Hospital Central (010542).
 *
 * Deliberately leaves alone anything it cannot verify:
 *  - alphanumeric CDPHE IDs (01L581), which are already correct;
 *  - the "NA" placeholders on six hospitals;
 *  - Children's Hospital Colorado's "10O533" — the letter O is probably a
 *    mistyped zero, but that is CPCQC's to confirm with CDPHE.
 *
 * Aborts rather than writing if normalization would make two hospitals share a
 * CHA ID, which the unique index would reject halfway through.
 *
 * Dry run by default; --apply writes. Idempotent.
 *
 *   NODE_ENV=production DATABASE_URL=… npx tsx scripts/normalize-hospital-identifiers.ts [--apply]
 */
import { eq, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, schema } from '../src/db/index.js';
import { normalizeAimId, normalizeCdpheId, normalizeChaId } from '../src/utils/identifiers.js';

const apply = process.argv.includes('--apply');

interface Change {
  id: string;
  name: string;
  cha?: [string | null, string | null];
  cdphe?: [string | null, string | null];
  aim?: [string | null, string | null];
}

async function main() {
  console.log(apply ? '== APPLYING ==' : '== DRY RUN — pass --apply to write ==');

  const rows = await db
    .select({
      id: schema.hospitals.id,
      name: schema.hospitals.name,
      cha: schema.hospitals.chaHospitalId,
      cdphe: schema.hospitals.cdpheId,
      aim: schema.hospitals.aimId,
    })
    .from(schema.hospitals)
    .orderBy(schema.hospitals.name);

  const changes: Change[] = [];
  const finalCha = new Map<string, string[]>();
  for (const r of rows) {
    const cha = normalizeChaId(r.cha);
    const cdphe = normalizeCdpheId(r.cdphe);
    const aim = normalizeAimId(r.aim);
    if (cha !== null) {
      const key = cha.toLowerCase();
      finalCha.set(key, [...(finalCha.get(key) ?? []), r.name]);
    }
    const c: Change = { id: r.id, name: r.name };
    if (cha !== r.cha) c.cha = [r.cha, cha];
    if (cdphe !== r.cdphe) c.cdphe = [r.cdphe, cdphe];
    if (aim !== r.aim) c.aim = [r.aim, aim];
    if (c.cha || c.cdphe || c.aim) changes.push(c);
  }

  const collisions = [...finalCha.entries()].filter(([, names]) => names.length > 1);
  if (collisions.length > 0) {
    console.error('Refusing to write — these CHA IDs would collide:');
    for (const [id, names] of collisions) console.error(`  ${id}: ${names.join(', ')}`);
    process.exit(1);
  }

  console.log(`\n${changes.length} of ${rows.length} hospitals need changes:`);
  console.table(
    changes.map((c) => ({
      hospital: c.name,
      CHA: c.cha ? `${c.cha[0]} → ${c.cha[1]}` : '',
      CDPHE: c.cdphe ? `${c.cdphe[0]} → ${c.cdphe[1]}` : '',
      AIM: c.aim ? `${c.aim[0]} → ${c.aim[1]}` : '',
    })),
  );

  if (apply) {
    for (const c of changes) {
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (c.cha) set.chaHospitalId = c.cha[1];
      if (c.cdphe) set.cdpheId = c.cdphe[1];
      if (c.aim) set.aimId = c.aim[1];
      await db.update(schema.hospitals).set(set).where(eq(schema.hospitals.id, c.id));
      await db.insert(schema.auditLog).values({
        id: uuid(),
        actorUserId: null,
        actorRole: 'cpcqc_admin',
        action: 'hospital.identifiers_normalized',
        entityType: 'hospital',
        entityId: c.id,
        diff: { cha: c.cha, cdphe: c.cdphe, aim: c.aim },
        note:
          `Repaired spreadsheet-import formatting for ${c.name}: ` +
          [
            c.cha && `CHA ${c.cha[0]} → ${c.cha[1]}`,
            c.cdphe && `CDPHE ${c.cdphe[0]} → ${c.cdphe[1]}`,
            c.aim && `AIM ${c.aim[0]} → ${c.aim[1]}`,
          ]
            .filter(Boolean)
            .join(', ') +
          '.',
      });
    }
    console.log(`\napplied to ${changes.length} hospitals`);

    const after = await db.execute(sql`
      SELECT
        count(*) FILTER (WHERE cha_hospital_id ~ '^\\d+\\.0+$')::int AS cha_artifacts_left,
        count(*) FILTER (WHERE aim_id ~ '^\\d+\\.0+$')::int AS aim_artifacts_left,
        count(*) FILTER (WHERE cdphe_id ~ '^\\d+\\.0+$')::int AS cdphe_artifacts_left,
        count(*) FILTER (WHERE cdphe_id ~ '^\\d{1,5}$')::int AS cdphe_short_left,
        count(*) FILTER (WHERE cdphe_id = 'NA')::int AS cdphe_na,
        count(*)::int AS hospitals
      FROM hospitals`);
    console.log('verification:', after.rows[0]);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

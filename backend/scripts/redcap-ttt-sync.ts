/**
 * Run the TtT REDCap sync from the CLI.
 *
 * Usage:
 *   npm run redcap:ttt-sync              # dry-run (no writes) — prints preview
 *   npm run redcap:ttt-sync -- --apply   # write to the database
 *
 * Requires REDCAP_TTT_HOSPITAL_TOKEN + REDCAP_TTT_PATIENT_TOKEN (TtT spans two
 * projects) and DATABASE_URL. Same code path as the staff UI.
 */
import 'dotenv/config';
import { runTttRedcapSync } from '../src/modules/redcap/ttt-sync.service.js';
import { pool } from '../src/db/index.js';

async function main() {
  const apply = process.argv.includes('--apply');
  /* eslint-disable no-console */
  console.log(apply ? 'Running TtT REDCap sync (APPLY — will write)…' : 'Running TtT REDCap sync (dry-run)…');

  const r = await runTttRedcapSync({ dryRun: !apply });

  console.log(
    `\nProgram year ${r.programYear} · ${r.hospitalRecords} hospital rows · ${r.patientRecords} patient rows · ` +
      `${r.requiredFieldCount} required fields · eligibility=${r.eligibilityMode} · ${r.rows.length} hospital×month cells\n`,
  );
  console.log('Counts:', JSON.stringify(r.counts));

  if (r.warnings.length) {
    console.log(`\n${r.warnings.length} warning(s):`);
    for (const w of r.warnings) console.log('  • ' + w);
  }
  if (r.notes.length) {
    console.log(`\n${r.notes.length} note(s):`);
    for (const n of r.notes) console.log('  • ' + n);
  }

  console.log('\nRows:');
  console.log('  ' + ['Period', 'Hospital', 'Category', 'Pos', 'Forms', 'Change'].join(' | '));
  for (const row of r.rows) {
    const change = row.willChange
      ? `${row.currentStatus}/${row.currentOutcome ?? '-'} -> ${row.newStatus}/${row.newOutcome ?? '-'}`
      : 'no change';
    console.log(
      '  ' +
        [
          row.period,
          row.hospitalName.padEnd(40).slice(0, 40),
          row.category.padEnd(15),
          String(row.positiveScreens).padStart(3),
          String(row.patientForms).padStart(5),
          change,
        ].join(' | '),
    );
  }

  const gaps = r.rows.filter((x) => x.submitted && !x.linkageFloor);
  if (gaps.length) {
    console.log(`\nLinkage gaps (positives but no eligible patient form): ${gaps.length}`);
    for (const g of gaps) {
      console.log(`  • ${g.hospitalName} ${g.period}: ${g.positiveScreens} positive(s), ${g.patientForms} form(s)`);
    }
  }

  console.log(
    `\n${apply ? 'Applied' : 'Would apply'} ${r.counts.willChange} change(s).` +
      (apply ? '' : '  Re-run with --apply to write.'),
  );
  /* eslint-enable no-console */
}

main()
  .then(() => pool.end())
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    pool.end();
    process.exit(1);
  });

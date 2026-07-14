/**
 * Run the SOAR REDCap sync from the CLI.
 *
 * Usage:
 *   npm run redcap:soar-sync              # dry-run (no writes) — prints preview
 *   npm run redcap:soar-sync -- --apply   # write to the database
 *
 * Requires REDCAP_SOAR_TOKEN (and DATABASE_URL). Same code path as the staff UI.
 */
import 'dotenv/config';
import { runSoarRedcapSync } from '../src/modules/redcap/soar-sync.service.js';
import { pool } from '../src/db/index.js';

async function main() {
  const apply = process.argv.includes('--apply');
  /* eslint-disable no-console */
  console.log(apply ? 'Running SOAR REDCap sync (APPLY — will write)…' : 'Running SOAR REDCap sync (dry-run)…');

  const r = await runSoarRedcapSync({ dryRun: !apply });

  console.log(
    `\nProgram year ${r.programYear} · ${r.recordsFetched} REDCap rows · ${r.rows.length} hospital×month cells\n`,
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
  console.log('  ' + ['Period', 'Hospital', 'Category', 'NTSV', 'No-NTSV', 'Change'].join(' | '));
  for (const row of r.rows) {
    const change = row.willChange
      ? `${row.currentStatus}/${row.currentOutcome ?? '-'} -> ${row.newStatus}/${row.newOutcome ?? '-'}`
      : 'no change';
    console.log(
      '  ' +
        [
          row.period,
          row.hospitalName.padEnd(46).slice(0, 46),
          row.category.padEnd(14),
          row.ntsvSubmitted ? `${row.ntsvComplete}/${row.ntsvRows}` : '—',
          row.noNtsvSubmitted ? `yes(${row.noNtsvRows})` : '—',
          change,
        ].join(' | '),
    );
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

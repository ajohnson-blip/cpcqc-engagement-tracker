/**
 * Run the NEST REDCap sync from the CLI.
 *
 * Usage:
 *   npm run redcap:nest-sync              # dry-run (no writes) — prints preview
 *   npm run redcap:nest-sync -- --apply   # write to the database
 *
 * Requires REDCAP_NEST_TOKEN (and DATABASE_URL). Same code path as the staff UI.
 */
import 'dotenv/config';
import { runNestRedcapSync } from '../src/modules/redcap/nest-sync.service.js';
import { pool } from '../src/db/index.js';

async function main() {
  const apply = process.argv.includes('--apply');
  /* eslint-disable no-console */
  console.log(apply ? 'Running NEST REDCap sync (APPLY — will write)…' : 'Running NEST REDCap sync (dry-run)…');

  const r = await runNestRedcapSync({ dryRun: !apply });

  console.log(
    `\nProgram year ${r.programYear} · ${r.recordsFetched} REDCap rows · ${r.rows.length} hospital×month cells\n`,
  );
  console.log('Counts:', JSON.stringify(r.counts));

  if (r.warnings.length) {
    console.log(`\n${r.warnings.length} warning(s):`);
    for (const w of r.warnings) console.log('  • ' + w);
  }

  console.log('\nRows:');
  console.log('  ' + ['Period', 'Hospital', 'Category', 'SSP', 'Chart', 'Change'].join(' | '));
  for (const row of r.rows) {
    const change = row.willChange
      ? `${row.currentStatus}/${row.currentOutcome ?? '-'} -> ${row.newStatus}/${row.newOutcome ?? '-'}`
      : 'no change';
    console.log(
      '  ' +
        [
          row.period,
          row.hospitalName.padEnd(48).slice(0, 48),
          row.category.padEnd(14),
          `${row.sspComplete}/${row.sspRows}`,
          `${row.chartComplete}/${row.chartRows}`,
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

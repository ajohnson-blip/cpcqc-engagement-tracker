/**
 * Run the SPARK REDCap sync from the CLI.
 *
 * Usage:
 *   npm run redcap:spark-sync              # dry-run (no writes) — prints preview
 *   npm run redcap:spark-sync -- --apply   # write to the database
 *
 * Requires REDCAP_SPARK_TOKEN (and DATABASE_URL) in the environment. This is the
 * same code path the staff UI uses; handy for verification and as the entry point
 * a future scheduled job would call.
 */
import 'dotenv/config';
import { runSparkRedcapSync } from '../src/modules/redcap/spark-sync.service.js';
import { pool } from '../src/db/index.js';

async function main() {
  const apply = process.argv.includes('--apply');
  /* eslint-disable no-console */
  console.log(apply ? 'Running SPARK REDCap sync (APPLY — will write)…' : 'Running SPARK REDCap sync (dry-run)…');

  const r = await runSparkRedcapSync({ dryRun: !apply });

  console.log(
    `\nProgram year ${r.programYear} · ${r.recordsFetched} REDCap rows fetched · ${r.rows.length} hospital×quarter cells\n`,
  );
  console.log('Counts:', JSON.stringify(r.counts, null, 0));

  if (r.warnings.length) {
    console.log(`\n${r.warnings.length} warning(s):`);
    for (const w of r.warnings) console.log('  • ' + w);
  }

  console.log('\nRows:');
  console.log(
    '  ' +
      ['Quarter', 'Hospital', 'Category', 'Submitted', '%', 'Change'].join(' | '),
  );
  for (const row of r.rows) {
    const change = row.willChange
      ? `${row.currentStatus}/${row.currentOutcome ?? '-'} -> ${row.newStatus}/${row.newOutcome ?? '-'}`
      : 'no change';
    console.log(
      '  ' +
        [
          row.quarter,
          row.hospitalName.padEnd(46).slice(0, 46),
          row.category.padEnd(15),
          row.submitted ? (row.submissionDate ?? 'yes(no date)') : 'no',
          row.pctComplete === null ? '-' : `${row.pctComplete}%`,
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

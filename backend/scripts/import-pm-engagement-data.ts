/**
 * CLI wrapper around src/modules/imports/pm-workbook.service.ts.
 *
 * All the actual import logic — sheet processors, validation, row-error
 * collection — lives in the service so it can also be called from the HTTP
 * upload endpoint (POST /staff/imports/pm-workbook). This file just turns
 * CLI args into a workbook + dry-run flag, calls the service, prints what
 * happened, and exits with the right code.
 *
 * Usage:
 *   npm run db:import-pm-data
 *   npm run db:import-pm-data -- --dry-run
 *   npm run db:import-pm-data -- --file=/abs/path/to/file.xlsx
 */
import 'dotenv/config';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { pool } from '../src/db/index.js';
import { importPmWorkbook } from '../src/modules/imports/pm-workbook.service.js';

interface Args {
  file: string;
  dryRun: boolean;
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
  const defaultPath = path.resolve(
    process.cwd(),
    process.cwd().endsWith('/backend') ? '..' : '.',
    'pm_engagement_data_jan_apr_2026.xlsx',
  );
  return {
    file: typeof out['file'] === 'string' ? out['file'] : defaultPath,
    dryRun: out['dry-run'] === true,
  };
}

async function main() {
  const args = parseArgs();
  // eslint-disable-next-line no-console
  console.log(`Reading ${args.file}${args.dryRun ? ' (dry run)' : ''}`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(args.file);

  const result = await importPmWorkbook(wb, { dryRun: args.dryRun });

  for (const sheet of result.missingSheets) {
    // eslint-disable-next-line no-console
    console.warn(`Sheet "${sheet}" not found — skipping.`);
  }
  // eslint-disable-next-line no-console
  console.log(
    `\n${result.dryRun ? 'Would have' : 'Did'} apply ${result.counts.applied} row update${
      result.counts.applied === 1 ? '' : 's'
    }.`,
  );
  if (result.touchedEnrollmentIds.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `${result.dryRun ? 'Would change' : 'Changed'} ${result.stagesChanged} enrollment stage${
        result.stagesChanged === 1 ? '' : 's'
      } to match the calendar.`,
    );
  }
  if (result.errors.length) {
    // eslint-disable-next-line no-console
    console.error(`\nErrors (${result.errors.length}):`);
    for (const e of result.errors.slice(0, 40)) {
      // eslint-disable-next-line no-console
      console.error(`  [${e.sheet} row ${e.rowNumber}] ${e.reason}`);
    }
    if (result.errors.length > 40) {
      // eslint-disable-next-line no-console
      console.error(`  … and ${result.errors.length - 40} more.`);
    }
    process.exit(1);
  }
}

main()
  .then(() => pool.end())
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    pool.end();
    process.exit(1);
  });

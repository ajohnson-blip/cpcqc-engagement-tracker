/**
 * Import task templates from the canonical XLSX (default: ../task_templates_starter.xlsx).
 *
 * The XLSX's "TaskTemplates" sheet is the source of truth for the
 * `task_templates` table. Run this after `npm run db:seed` (which creates the
 * initiatives, stages, and configs the templates reference) and re-run anytime
 * the spreadsheet changes.
 *
 * Usage:
 *   npm run db:import-templates                    # imports the default file, commits
 *   npm run db:import-templates -- --dry-run       # validates and reports, no DB writes
 *   npm run db:import-templates -- --file=/abs/path/to/file.xlsx
 *
 * Idempotent: existing rows (matched by initiative + track + stage + name) are
 * updated; new rows are inserted; no deletes (delete unused templates manually).
 */
import 'dotenv/config';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { v4 as uuid } from 'uuid';
import { and, eq } from 'drizzle-orm';
import { db, schema, pool } from '../src/db/index.js';

// -------- CLI parsing --------

interface Args {
  file: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const out: Record<string, string | boolean> = {};
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') {
      out['dry-run'] = true;
    } else {
      const m = /^--([a-z-]+)=(.+)$/.exec(arg);
      if (m) out[m[1]!] = m[2]!;
    }
  }
  const defaultPath = path.resolve(
    process.cwd(),
    process.cwd().endsWith('/backend') ? '..' : '.',
    'task_templates_starter.xlsx',
  );
  return {
    file: typeof out['file'] === 'string' ? out['file'] : defaultPath,
    dryRun: out['dry-run'] === true,
  };
}

// -------- Sheet parsing --------

interface SheetRow {
  rowNumber: number;
  initiative: string;
  track: string;
  stage: string;
  stageCode: string;
  taskName: string;
  taskType: string;
  period: string;
  periodLabel: string;
  dueDateRule: string;
  countsTowardRequirement: string;
  knowledgeCenterUrl: string;
  notes: string;
}

const EXPECTED_HEADERS = [
  'ID',
  'Initiative',
  'Track',
  'Stage',
  'Stage Code',
  'Task Name',
  'Task Type',
  'Period',
  'Period Label',
  'Due Date Rule',
  'Counts Toward Legal Requirement',
  'Knowledge Center URL',
  'Notes',
] as const;

function cellString(cell: ExcelJS.Cell): string {
  if (cell.value == null) return '';
  if (typeof cell.value === 'string') return cell.value.trim();
  if (typeof cell.value === 'number') return String(cell.value);
  if (typeof cell.value === 'boolean') return cell.value ? 'Yes' : 'No';
  // Hyperlink cells: { text, hyperlink }
  if (typeof cell.value === 'object' && 'text' in cell.value) return String((cell.value as { text: unknown }).text).trim();
  if ('result' in (cell.value as object)) return String((cell.value as { result: unknown }).result ?? '').trim();
  return String(cell.value).trim();
}

async function readSheet(filePath: string): Promise<SheetRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheet = wb.getWorksheet('TaskTemplates');
  if (!sheet) throw new Error(`Sheet "TaskTemplates" not found in ${filePath}`);

  // Validate headers
  const headerRow = sheet.getRow(1);
  for (let i = 0; i < EXPECTED_HEADERS.length; i++) {
    const got = cellString(headerRow.getCell(i + 1));
    if (got !== EXPECTED_HEADERS[i]) {
      throw new Error(
        `Header mismatch at column ${i + 1}: expected "${EXPECTED_HEADERS[i]}", got "${got}"`,
      );
    }
  }

  const rows: SheetRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const initiative = cellString(row.getCell(2));
    if (!initiative) return; // blank row
    rows.push({
      rowNumber,
      initiative,
      track: cellString(row.getCell(3)),
      stage: cellString(row.getCell(4)),
      stageCode: cellString(row.getCell(5)),
      taskName: cellString(row.getCell(6)),
      taskType: cellString(row.getCell(7)),
      period: cellString(row.getCell(8)),
      periodLabel: cellString(row.getCell(9)),
      dueDateRule: cellString(row.getCell(10)),
      countsTowardRequirement: cellString(row.getCell(11)),
      knowledgeCenterUrl: cellString(row.getCell(12)),
      notes: cellString(row.getCell(13)),
    });
  });
  return rows;
}

// -------- Validation --------

const VALID_INITIATIVES = new Set(['TTT', 'SPARK', 'SOAR', 'NEST']);
const VALID_TRACKS = new Set(['active', 'sustainability']);
const VALID_TASK_TYPES = new Set([
  'enrollment_form',
  'meeting_attendance',
  'qi_advising',
  'data_submission',
  'readiness_assessment',
  'other',
]);
const VALID_PERIODS = new Set(['once', 'annual', 'quarterly', 'monthly']);

interface RowError {
  rowNumber: number;
  field: string;
  reason: string;
}

function validateRow(row: SheetRow): RowError[] {
  const errors: RowError[] = [];
  const need = (field: keyof SheetRow, label: string) => {
    if (!row[field]) errors.push({ rowNumber: row.rowNumber, field: label, reason: 'missing' });
  };
  need('initiative', 'Initiative');
  need('track', 'Track');
  need('stage', 'Stage');
  need('taskName', 'Task Name');
  need('taskType', 'Task Type');
  need('period', 'Period');

  if (row.initiative && !VALID_INITIATIVES.has(row.initiative)) {
    errors.push({
      rowNumber: row.rowNumber,
      field: 'Initiative',
      reason: `unknown value "${row.initiative}"`,
    });
  }
  if (row.track && !VALID_TRACKS.has(row.track)) {
    errors.push({
      rowNumber: row.rowNumber,
      field: 'Track',
      reason: `unknown value "${row.track}"`,
    });
  }
  if (row.taskType && !VALID_TASK_TYPES.has(row.taskType)) {
    errors.push({
      rowNumber: row.rowNumber,
      field: 'Task Type',
      reason: `unknown value "${row.taskType}"`,
    });
  }
  if (row.period && !VALID_PERIODS.has(row.period)) {
    errors.push({
      rowNumber: row.rowNumber,
      field: 'Period',
      reason: `unknown value "${row.period}"`,
    });
  }
  if (
    row.countsTowardRequirement &&
    !['Yes', 'No'].includes(row.countsTowardRequirement)
  ) {
    errors.push({
      rowNumber: row.rowNumber,
      field: 'Counts Toward Legal Requirement',
      reason: `unknown value "${row.countsTowardRequirement}" (expected Yes/No)`,
    });
  }
  return errors;
}

// -------- Lookups --------

interface Lookups {
  initiativesByCode: Map<string, string>; // code → id
  stagesByKey: Map<string, string>; // `${initiativeId}|${track}|${stageName}` → id
}

async function loadLookups(): Promise<Lookups> {
  const inits = await db.select().from(schema.initiatives);
  const initiativesByCode = new Map<string, string>();
  for (const i of inits) initiativesByCode.set(i.code, i.id);

  const stages = await db.select().from(schema.stages);
  const stagesByKey = new Map<string, string>();
  for (const s of stages) {
    stagesByKey.set(`${s.initiativeId}|${s.track}|${s.name.toLowerCase()}`, s.id);
  }
  return { initiativesByCode, stagesByKey };
}

// -------- Upsert --------

interface UpsertCounts {
  inserted: number;
  updated: number;
  skipped: number;
}

async function upsertRows(
  rows: SheetRow[],
  lookups: Lookups,
  dryRun: boolean,
): Promise<{ counts: UpsertCounts; errors: RowError[] }> {
  const counts: UpsertCounts = { inserted: 0, updated: 0, skipped: 0 };
  const errors: RowError[] = [];

  for (const row of rows) {
    const initiativeId = lookups.initiativesByCode.get(row.initiative);
    if (!initiativeId) {
      errors.push({
        rowNumber: row.rowNumber,
        field: 'Initiative',
        reason: `no Initiative row found for code "${row.initiative}" — run db:seed?`,
      });
      continue;
    }
    const stageId = lookups.stagesByKey.get(
      `${initiativeId}|${row.track}|${row.stage.toLowerCase()}`,
    );
    if (!stageId) {
      errors.push({
        rowNumber: row.rowNumber,
        field: 'Stage',
        reason: `no Stage row for (${row.initiative}, ${row.track}, "${row.stage}") — check StageDefinitions and run db:seed`,
      });
      continue;
    }

    const taskTemplateValues = {
      initiativeId,
      track: row.track as 'active' | 'sustainability',
      stageId,
      name: row.taskName,
      taskType: row.taskType as
        | 'enrollment_form'
        | 'meeting_attendance'
        | 'qi_advising'
        | 'data_submission'
        | 'readiness_assessment'
        | 'other',
      period: row.period,
      periodLabel: row.periodLabel || null,
      dueDateRule: row.dueDateRule || null,
      countsTowardRequirement: row.countsTowardRequirement === 'Yes',
      knowledgeCenterUrl: row.knowledgeCenterUrl || null,
      notes: row.notes || null,
    };

    const existing = await db.query.taskTemplates.findFirst({
      where: and(
        eq(schema.taskTemplates.initiativeId, initiativeId),
        eq(schema.taskTemplates.track, taskTemplateValues.track),
        eq(schema.taskTemplates.stageId, stageId),
        eq(schema.taskTemplates.name, row.taskName),
      ),
    });

    if (existing) {
      if (dryRun) {
        counts.updated++;
        continue;
      }
      await db
        .update(schema.taskTemplates)
        .set({ ...taskTemplateValues, updatedAt: new Date() })
        .where(eq(schema.taskTemplates.id, existing.id));
      counts.updated++;
    } else {
      if (dryRun) {
        counts.inserted++;
        continue;
      }
      await db.insert(schema.taskTemplates).values({ id: uuid(), ...taskTemplateValues });
      counts.inserted++;
    }
  }

  return { counts, errors };
}

// -------- Main --------

async function main() {
  const args = parseArgs();
  // eslint-disable-next-line no-console
  console.log(`Reading ${args.file}${args.dryRun ? ' (dry run)' : ''}`);

  const rows = await readSheet(args.file);
  // eslint-disable-next-line no-console
  console.log(`Parsed ${rows.length} task template rows.`);

  // Validate
  const validationErrors: RowError[] = [];
  for (const row of rows) validationErrors.push(...validateRow(row));

  if (validationErrors.length) {
    // eslint-disable-next-line no-console
    console.error(`\nValidation errors (${validationErrors.length}):`);
    for (const e of validationErrors.slice(0, 20)) {
      // eslint-disable-next-line no-console
      console.error(`  Row ${e.rowNumber} [${e.field}]: ${e.reason}`);
    }
    if (validationErrors.length > 20) {
      // eslint-disable-next-line no-console
      console.error(`  ... and ${validationErrors.length - 20} more`);
    }
    // eslint-disable-next-line no-console
    console.error('\nFix the spreadsheet and re-run. No rows imported.');
    process.exit(1);
  }

  const lookups = await loadLookups();
  if (lookups.initiativesByCode.size === 0) {
    // eslint-disable-next-line no-console
    console.error('No Initiative rows found. Run `npm run db:seed` first.');
    process.exit(1);
  }

  const { counts, errors } = await upsertRows(rows, lookups, args.dryRun);
  // eslint-disable-next-line no-console
  console.log(
    `\n${args.dryRun ? 'Would have' : 'Did'} insert ${counts.inserted}, update ${counts.updated}, skip ${counts.skipped}.`,
  );
  if (errors.length) {
    // eslint-disable-next-line no-console
    console.error(`\nLookup errors (${errors.length}):`);
    for (const e of errors.slice(0, 20)) {
      // eslint-disable-next-line no-console
      console.error(`  Row ${e.rowNumber} [${e.field}]: ${e.reason}`);
    }
    if (errors.length > 20) {
      // eslint-disable-next-line no-console
      console.error(`  ... and ${errors.length - 20} more`);
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

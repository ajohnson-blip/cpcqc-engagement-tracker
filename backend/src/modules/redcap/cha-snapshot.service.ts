/**
 * Storing CHA's assessment files and reading them back for syncs.
 *
 * Validation lives in cha-snapshot.ts (pure). This file owns the database.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, lt } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, schema } from '@/db/index.js';
import { HttpError } from '@/middleware/errors.js';
import { logger } from '@/config/logger.js';
import {
  parseSnapshotFile,
  SnapshotRejected,
  type ChaAssessment,
  type ChaProgram,
  type SnapshotFile,
} from './cha-snapshot.js';

/**
 * How long received files are kept (CPCQC decision, October 2026). Older ones
 * are deleted each time a new file arrives, so no separate job is needed; their
 * runs go with them (ON DELETE CASCADE). The audit log's record of each
 * delivery is kept.
 */
export const RETENTION_DAYS = 365;

export interface StoreResult {
  status: 'stored' | 'already_stored';
  snapshotId: string;
}

function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

/**
 * Validate and store a delivered file. Idempotent: the same snapshot delivered
 * again is acknowledged without being stored twice, so CHA can always retry.
 * Nothing is stored unless the whole file is valid.
 */
export async function storeSnapshot(body: Buffer, now: Date = new Date()): Promise<StoreResult> {
  const digest = sha256(body);

  let raw: unknown;
  try {
    raw = JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'The body is not valid JSON.');
  }

  let file: SnapshotFile;
  try {
    file = parseSnapshotFile(raw, now);
  } catch (e) {
    if (e instanceof SnapshotRejected) throw new HttpError(400, e.message, { problems: e.problems });
    throw e;
  }

  const already = await existing(file.snapshot_id, digest);
  if (already) return already;

  const id = uuid();
  const generatedAt = new Date(file.generated_at);
  const summary = file.runs.map((r) =>
    r.status === 'ok'
      ? { program: r.program, programYear: r.program_year, status: r.status, assessments: r.assessments.length }
      : { program: r.program, programYear: r.program_year, status: r.status, error: r.error.code },
  );

  try {
    await db.transaction(async (tx) => {
      await tx.insert(schema.chaSnapshots).values({
        id,
        snapshotId: file.snapshot_id,
        formatVersion: file.format_version,
        generatedAt,
        generatorName: file.generator.name,
        generatorVersion: file.generator.version,
        sha256: digest,
        byteSize: body.length,
        receivedAt: now,
      });
      await tx.insert(schema.chaSnapshotRuns).values(
        file.runs.map((r) => ({
          id: uuid(),
          chaSnapshotId: id,
          program: r.program,
          programYear: r.program_year,
          status: r.status,
          generatedAt,
          ...(r.status === 'ok'
            ? {
                methodologyVersion: r.methodology_version,
                recordsRead: r.source.records_read,
                redcapProject: r.source.redcap_project,
                assessments: r.assessments,
                warnings: r.warnings,
              }
            : { errorCode: r.error.code, errorMessage: r.error.message }),
        })),
      );
      await tx.insert(schema.auditLog).values({
        id: uuid(),
        actorUserId: null,
        actorRole: 'cha_integration',
        action: 'cha.snapshot_received',
        entityType: 'cha_snapshot',
        entityId: file.snapshot_id,
        diff: { generatedAt: file.generated_at, generator: file.generator, runs: summary },
        note: `Received CHA assessment file ${file.snapshot_id}, generated ${file.generated_at} (${file.runs.length} run${file.runs.length === 1 ? '' : 's'}).`,
      });
    });
  } catch (e) {
    // Two deliveries of one snapshot racing: the loser finds the winner's row.
    if (isUniqueViolation(e)) {
      const raced = await existing(file.snapshot_id, digest);
      if (raced) return raced;
    }
    throw e;
  }

  const pruned = await db
    .delete(schema.chaSnapshots)
    .where(lt(schema.chaSnapshots.receivedAt, new Date(now.getTime() - RETENTION_DAYS * 86_400_000)))
    .returning({ id: schema.chaSnapshots.id });

  logger.info(
    { snapshotId: file.snapshot_id, generatedAt: file.generated_at, runs: summary, pruned: pruned.length },
    'CHA assessment file stored',
  );
  return { status: 'stored', snapshotId: file.snapshot_id };
}

async function existing(snapshotId: string, digest: string): Promise<StoreResult | null> {
  const row = await db.query.chaSnapshots.findFirst({
    where: eq(schema.chaSnapshots.snapshotId, snapshotId),
  });
  if (!row) return null;
  if (row.sha256 === digest) return { status: 'already_stored', snapshotId };
  // A snapshot id names one file. Different bytes under the same id is a
  // defect in the sender, and storing either silently would hide it.
  throw new HttpError(409, `Snapshot ${snapshotId} was already received with different content.`);
}

export interface StoredRun {
  snapshotId: string;
  generatedAt: string;
  receivedAt: string;
  generatorVersion: string;
  program: ChaProgram;
  programYear: number;
  status: 'ok' | 'error';
  methodologyVersion: string | null;
  recordsRead: number | null;
  redcapProject: string | null;
  assessments: ChaAssessment[];
  warnings: string[];
  errorCode: string | null;
  errorMessage: string | null;
}

const runColumns = {
  snapshotId: schema.chaSnapshots.snapshotId,
  receivedAt: schema.chaSnapshots.receivedAt,
  generatorVersion: schema.chaSnapshots.generatorVersion,
  run: schema.chaSnapshotRuns,
};

function toStoredRun(row: {
  snapshotId: string;
  receivedAt: Date;
  generatorVersion: string;
  run: typeof schema.chaSnapshotRuns.$inferSelect;
}): StoredRun {
  return {
    snapshotId: row.snapshotId,
    generatedAt: row.run.generatedAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    generatorVersion: row.generatorVersion,
    program: row.run.program as ChaProgram,
    programYear: row.run.programYear,
    status: row.run.status as 'ok' | 'error',
    methodologyVersion: row.run.methodologyVersion,
    recordsRead: row.run.recordsRead,
    redcapProject: row.run.redcapProject,
    // Validated against the contract on arrival.
    assessments: (row.run.assessments as ChaAssessment[] | null) ?? [],
    warnings: (row.run.warnings as string[] | null) ?? [],
    errorCode: row.run.errorCode,
    errorMessage: row.run.errorMessage,
  };
}

/**
 * The newest successful run for a program year, and the newest run of any
 * outcome. When the latter is an error newer than the former, the sync uses
 * the good data and says the most recent attempt failed.
 */
export async function latestRuns(
  program: ChaProgram,
  programYear: number,
): Promise<{ ok: StoredRun | null; latest: StoredRun | null }> {
  const base = () =>
    db
      .select(runColumns)
      .from(schema.chaSnapshotRuns)
      .innerJoin(schema.chaSnapshots, eq(schema.chaSnapshots.id, schema.chaSnapshotRuns.chaSnapshotId));
  const order = [desc(schema.chaSnapshotRuns.generatedAt), desc(schema.chaSnapshots.receivedAt)] as const;
  const scope = and(eq(schema.chaSnapshotRuns.program, program), eq(schema.chaSnapshotRuns.programYear, programYear));

  const [ok] = await base()
    .where(and(scope, eq(schema.chaSnapshotRuns.status, 'ok')))
    .orderBy(...order)
    .limit(1);
  const [latest] = await base().where(scope).orderBy(...order).limit(1);
  return { ok: ok ? toStoredRun(ok) : null, latest: latest ? toStoredRun(latest) : null };
}

/** One program year's run from a particular file — to apply exactly what was previewed. */
export async function runFromSnapshot(
  snapshotId: string,
  program: ChaProgram,
  programYear: number,
): Promise<StoredRun | null> {
  const [row] = await db
    .select(runColumns)
    .from(schema.chaSnapshotRuns)
    .innerJoin(schema.chaSnapshots, eq(schema.chaSnapshots.id, schema.chaSnapshotRuns.chaSnapshotId))
    .where(
      and(
        eq(schema.chaSnapshots.snapshotId, snapshotId),
        eq(schema.chaSnapshotRuns.program, program),
        eq(schema.chaSnapshotRuns.programYear, programYear),
      ),
    )
    .limit(1);
  return row ? toStoredRun(row) : null;
}

/**
 * The run a sync should build from, plus anything a PM should know about it.
 *
 * With `snapshotId` — an apply following a preview — exactly that file's run,
 * so what is applied is what was previewed even if a newer file has arrived
 * in between. Without it, the newest successful run.
 */
export async function chaRunForSync(
  program: ChaProgram,
  programYear: number,
  snapshotId?: string,
): Promise<{ run: StoredRun; warnings: string[] }> {
  if (snapshotId) {
    const run = await runFromSnapshot(snapshotId, program, programYear);
    if (!run || run.status !== 'ok') {
      throw new HttpError(
        409,
        `The CHA file this preview was built from is no longer available for ${program} ${programYear}. Run the preview again.`,
      );
    }
    return { run, warnings: [] };
  }

  const { ok, latest } = await latestRuns(program, programYear);
  if (!ok) {
    const lastAttempt =
      latest?.status === 'error'
        ? ` CHA's most recent run, at ${latest.generatedAt}, failed: ${latest.errorMessage}`
        : '';
    throw new HttpError(409, `No ${program} ${programYear} assessment has been received from CHA yet.${lastAttempt}`);
  }
  const warnings: string[] = [];
  if (latest && latest.status === 'error' && latest.snapshotId !== ok.snapshotId) {
    warnings.push(
      `CHA's most recent ${program} ${programYear} run, at ${latest.generatedAt}, failed (${latest.errorCode}: ` +
        `${latest.errorMessage}). This preview uses the last successful file, from ${ok.generatedAt}.`,
    );
  }
  return { run: ok, warnings };
}

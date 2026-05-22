/**
 * Tasks service.
 *
 * Backs the hospital portal's "Manage Task" UX and the staff dashboard's task
 * management actions. Handles authorization, payload validation per task type,
 * status transitions, and side effects:
 *
 *   - For `enrollment_form` completion: transitions the enrollment from
 *     `eligible_to_enroll` to `enrolled` and inserts hospital_staff_members
 *     rows from the team roster payload.
 *
 *   - For any completion: checks whether all TaskInstances at the enrollment's
 *     current stage (for the current program year) are now complete, and if so
 *     advances the enrollment to the next stage by sequence number.
 *
 *   - Every state change writes an `audit_log` row.
 */
import { v4 as uuid } from 'uuid';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '@/db/index.js';
import { HttpError } from '@/middleware/errors.js';
import type { AuthContext } from '@/middleware/auth.js';
import { computeCurrentStageForEnrollment } from '@/modules/stages/stage-resolver.js';
import {
  manageTaskBody,
  payloadSchemaForType,
  type ManageTaskBody,
} from './tasks.schemas.js';

// -------- Reads --------

export interface ListTasksForEnrollmentParams {
  enrollmentId: string;
  programYear?: number;
  status?: 'not_started' | 'current_activities' | 'complete' | 'needs_revision';
}

export async function listTasksForEnrollment(
  params: ListTasksForEnrollmentParams,
  ctx: AuthContext,
) {
  const enrollment = await db.query.enrollments.findFirst({
    where: eq(schema.enrollments.id, params.enrollmentId),
  });
  if (!enrollment) throw new HttpError(404, 'Enrollment not found');
  assertCanReadEnrollment(enrollment.hospitalId, ctx);

  // Build query
  const conds = [eq(schema.taskInstances.enrollmentId, params.enrollmentId)];
  if (params.status) conds.push(eq(schema.taskInstances.status, params.status));

  const rows = await db
    .select({
      task: schema.taskInstances,
      template: schema.taskTemplates,
      stage: schema.stages,
      programYear: schema.programYears,
    })
    .from(schema.taskInstances)
    .innerJoin(
      schema.taskTemplates,
      eq(schema.taskTemplates.id, schema.taskInstances.taskTemplateId),
    )
    .innerJoin(schema.stages, eq(schema.stages.id, schema.taskTemplates.stageId))
    .innerJoin(
      schema.programYears,
      eq(schema.programYears.id, schema.taskInstances.programYearId),
    )
    .where(and(...conds))
    .orderBy(schema.stages.sequence, schema.taskInstances.dueOn);

  const filtered = params.programYear
    ? rows.filter((r) => r.programYear.year === params.programYear)
    : rows;

  return filtered.map((r) => ({
    id: r.task.id,
    enrollmentId: r.task.enrollmentId,
    programYear: r.programYear.year,
    stage: { id: r.stage.id, code: r.stage.code, name: r.stage.name, sequence: r.stage.sequence },
    template: {
      id: r.template.id,
      name: r.template.name,
      taskType: r.template.taskType,
      period: r.template.period,
      periodLabel: r.template.periodLabel,
      knowledgeCenterUrl: r.template.knowledgeCenterUrl,
      countsTowardRequirement: r.template.countsTowardRequirement,
    },
    period: r.task.period,
    dueOn: r.task.dueOn,
    status: r.task.status,
    outcome: r.task.outcome,
    completedOn: r.task.completedOn,
    staffNote: r.task.staffNote,
    attachmentUrl: r.task.attachmentUrl,
    payload: r.task.payload,
    updatedAt: r.task.updatedAt,
  }));
}

export async function getTaskInstance(id: string, ctx: AuthContext) {
  const task = await db.query.taskInstances.findFirst({
    where: eq(schema.taskInstances.id, id),
  });
  if (!task) throw new HttpError(404, 'Task not found');
  const enrollment = await db.query.enrollments.findFirst({
    where: eq(schema.enrollments.id, task.enrollmentId),
  });
  if (!enrollment) throw new HttpError(500, 'Task references missing enrollment');
  assertCanReadEnrollment(enrollment.hospitalId, ctx);
  return task;
}

// -------- Manage --------

export async function manageTask(taskId: string, body: unknown, ctx: AuthContext) {
  const parsed: ManageTaskBody = manageTaskBody.parse(body);

  const task = await db.query.taskInstances.findFirst({
    where: eq(schema.taskInstances.id, taskId),
  });
  if (!task) throw new HttpError(404, 'Task not found');

  const enrollment = await db.query.enrollments.findFirst({
    where: eq(schema.enrollments.id, task.enrollmentId),
  });
  if (!enrollment) throw new HttpError(500, 'Task references missing enrollment');

  const template = await db.query.taskTemplates.findFirst({
    where: eq(schema.taskTemplates.id, task.taskTemplateId),
  });
  if (!template) throw new HttpError(500, 'Task references missing template');

  // Authorization
  assertCanWriteEnrollment(enrollment.hospitalId, ctx);

  // Validate the type-specific payload (re-parse against the narrower schema).
  let validatedPayload: Record<string, unknown> | null = null;
  if (parsed.payload !== undefined) {
    const specificSchema = payloadSchemaForType(template.taskType);
    validatedPayload = specificSchema.parse(parsed.payload) as Record<string, unknown>;
  }

  const now = new Date();
  const previousStatus = task.status;
  const completedOn =
    parsed.status === 'complete' ? now.toISOString().slice(0, 10) : task.completedOn;

  await db.transaction(async (tx) => {
    // Update the task instance
    // Clear outcome when status is no longer 'complete' (e.g. resetting to
    // current_activities or needs_revision shouldn't carry the old outcome).
    const nextOutcome =
      parsed.status === 'complete'
        ? parsed.outcome === undefined
          ? task.outcome
          : parsed.outcome
        : null;

    await tx
      .update(schema.taskInstances)
      .set({
        status: parsed.status,
        outcome: nextOutcome,
        completedOn,
        payload: validatedPayload ?? task.payload,
        staffNote: parsed.staffNote ?? task.staffNote,
        attachmentUrl: (validatedPayload?.['attachmentUrl'] as string | undefined) ?? task.attachmentUrl,
        updatedBy: ctx.userId,
        updatedAt: now,
      })
      .where(eq(schema.taskInstances.id, taskId));

    // Audit
    await tx.insert(schema.auditLog).values({
      id: uuid(),
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action: 'task.manage',
      entityType: 'task_instance',
      entityId: taskId,
      diff: { from: { status: previousStatus }, to: { status: parsed.status } },
      note: parsed.staffNote ?? null,
    });

    // Enrollment Form completion side effects
    if (
      parsed.status === 'complete' &&
      template.taskType === 'enrollment_form' &&
      enrollment.status === 'eligible_to_enroll'
    ) {
      await tx
        .update(schema.enrollments)
        .set({ status: 'enrolled', updatedAt: now })
        .where(eq(schema.enrollments.id, enrollment.id));

      await tx.insert(schema.auditLog).values({
        id: uuid(),
        actorUserId: ctx.userId,
        actorRole: ctx.role,
        action: 'enrollment.activated',
        entityType: 'enrollment',
        entityId: enrollment.id,
        diff: { from: { status: 'eligible_to_enroll' }, to: { status: 'enrolled' } },
      });

      // Upsert hospital staff roster from the five champion slots.
      type ChampionRec = { name?: string; email?: string; role?: string } | undefined;
      const championSlots: Array<[ChampionRec, string]> = [
        [validatedPayload?.['ldChampion'] as ChampionRec, 'L&D Champion'],
        [validatedPayload?.['dataChampion'] as ChampionRec, 'Data Champion'],
        [validatedPayload?.['providerChampion'] as ChampionRec, 'Provider Champion'],
        [
          validatedPayload?.['otherChampion1'] as ChampionRec,
          (validatedPayload?.['otherChampion1'] as ChampionRec)?.role || 'Other Champion #1',
        ],
        [
          validatedPayload?.['otherChampion2'] as ChampionRec,
          (validatedPayload?.['otherChampion2'] as ChampionRec)?.role || 'Other Champion #2',
        ],
      ];
      for (const [rec, role] of championSlots) {
        if (!rec?.name) continue;
        await upsertHospitalStaffMember(tx, enrollment.hospitalId, template.initiativeId, {
          name: rec.name,
          role,
          email: rec.email,
        });
      }
    }

    // Sync the enrollment's current stage to whatever the calendar says it
    // should be now (gated by enrollment-form completion). This only changes
    // when the enrollment form is the task just completed — otherwise stage
    // is purely date-driven and doesn't shift on task updates. We re-resolve
    // anyway because it's cheap and ensures consistency.
    const resolved = await computeCurrentStageForEnrollment(enrollment.id, now);
    if (resolved && resolved.stageId !== enrollment.currentStageId) {
      await tx
        .update(schema.enrollments)
        .set({ currentStageId: resolved.stageId, updatedAt: now })
        .where(eq(schema.enrollments.id, enrollment.id));
      await tx.insert(schema.auditLog).values({
        id: uuid(),
        actorUserId: ctx.userId,
        actorRole: ctx.role,
        action: 'enrollment.stage_changed',
        entityType: 'enrollment',
        entityId: enrollment.id,
        diff: { to: { currentStageId: resolved.stageId } },
        note: `Stage synced to "${resolved.stageName}" (date-driven, EF complete: ${resolved.enrollmentFormComplete}).`,
      });
    }
  });

  return await db.query.taskInstances.findFirst({
    where: eq(schema.taskInstances.id, taskId),
  });
}

// -------- Helpers --------

function assertCanReadEnrollment(hospitalId: string, ctx: AuthContext) {
  if (ctx.role === 'cpcqc_staff' || ctx.role === 'cpcqc_admin') return;
  if (ctx.hospitalId === hospitalId) return;
  throw new HttpError(403, 'Forbidden: not your hospital');
}

function assertCanWriteEnrollment(hospitalId: string, ctx: AuthContext) {
  if (ctx.role === 'cpcqc_staff' || ctx.role === 'cpcqc_admin') return;
  if (
    (ctx.role === 'hospital_user' || ctx.role === 'hospital_admin') &&
    ctx.hospitalId === hospitalId
  ) {
    return;
  }
  throw new HttpError(403, 'Forbidden');
}

async function upsertHospitalStaffMember(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  hospitalId: string,
  initiativeId: string,
  member: { name: string; role?: string; email?: string; phone?: string },
) {
  const existing = await tx
    .select()
    .from(schema.hospitalStaffMembers)
    .where(
      and(
        eq(schema.hospitalStaffMembers.hospitalId, hospitalId),
        eq(schema.hospitalStaffMembers.initiativeId, initiativeId),
        sql`lower(${schema.hospitalStaffMembers.name}) = lower(${member.name})`,
      ),
    );
  if (existing.length > 0) {
    await tx
      .update(schema.hospitalStaffMembers)
      .set({
        role: member.role ?? existing[0]!.role,
        email: member.email ?? existing[0]!.email,
        phone: member.phone ?? existing[0]!.phone,
        updatedAt: new Date(),
      })
      .where(eq(schema.hospitalStaffMembers.id, existing[0]!.id));
    return existing[0]!.id;
  }
  const id = uuid();
  await tx.insert(schema.hospitalStaffMembers).values({
    id,
    hospitalId,
    initiativeId,
    name: member.name,
    role: member.role ?? null,
    email: member.email ?? null,
    phone: member.phone ?? null,
  });
  return id;
}

// Stage progression is now date-driven via stage-resolver.ts — no need for
// per-task auto-advance logic here. Kept this file purely focused on tasks.

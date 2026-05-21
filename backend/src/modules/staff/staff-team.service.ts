/**
 * CPCQC staff team lookups.
 *
 * Returns the named PM(s) and QI Advisor(s) for an initiative — used by the
 * hospital portal to show "Your CPCQC contacts" and by the staff portal for
 * its team-roster views.
 *
 * All cpcqc_staff users have cross-initiative permissions; this is purely
 * about identifying point people.
 */
import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '@/db/index.js';

export interface InitiativeTeamMember {
  userId: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string;
  email: string;
  staffRole: 'program_manager' | 'qi_advisor';
}

export interface InitiativeTeam {
  initiativeId: string;
  initiativeCode: string;
  programManagers: InitiativeTeamMember[];
  qiAdvisors: InitiativeTeamMember[];
}

function fullName(first: string | null, last: string | null, fallback: string): string {
  const parts = [first, last].filter(Boolean).join(' ').trim();
  return parts || fallback;
}

export async function getTeamForInitiativeId(initiativeId: string): Promise<InitiativeTeam | null> {
  const initiative = await db.query.initiatives.findFirst({
    where: eq(schema.initiatives.id, initiativeId),
  });
  if (!initiative) return null;

  const rows = await db
    .select({
      userId: schema.staffInitiativeAssignments.userId,
      staffRole: schema.staffInitiativeAssignments.staffRole,
      firstName: schema.users.firstName,
      lastName: schema.users.lastName,
      email: schema.users.email,
    })
    .from(schema.staffInitiativeAssignments)
    .innerJoin(schema.users, eq(schema.users.id, schema.staffInitiativeAssignments.userId))
    .where(eq(schema.staffInitiativeAssignments.initiativeId, initiativeId));

  const programManagers: InitiativeTeamMember[] = [];
  const qiAdvisors: InitiativeTeamMember[] = [];
  for (const r of rows) {
    const member: InitiativeTeamMember = {
      userId: r.userId,
      firstName: r.firstName,
      lastName: r.lastName,
      fullName: fullName(r.firstName, r.lastName, r.email),
      email: r.email,
      staffRole: r.staffRole,
    };
    if (r.staffRole === 'program_manager') programManagers.push(member);
    else qiAdvisors.push(member);
  }
  return {
    initiativeId,
    initiativeCode: initiative.code,
    programManagers: programManagers.sort((a, b) => a.fullName.localeCompare(b.fullName)),
    qiAdvisors: qiAdvisors.sort((a, b) => a.fullName.localeCompare(b.fullName)),
  };
}

export async function getTeamsForInitiativeIds(
  initiativeIds: string[],
): Promise<Map<string, InitiativeTeam>> {
  if (initiativeIds.length === 0) return new Map();
  const initiatives = await db
    .select()
    .from(schema.initiatives)
    .where(inArray(schema.initiatives.id, initiativeIds));
  const initiativeById = new Map(initiatives.map((i) => [i.id, i]));

  const rows = await db
    .select({
      initiativeId: schema.staffInitiativeAssignments.initiativeId,
      userId: schema.staffInitiativeAssignments.userId,
      staffRole: schema.staffInitiativeAssignments.staffRole,
      firstName: schema.users.firstName,
      lastName: schema.users.lastName,
      email: schema.users.email,
    })
    .from(schema.staffInitiativeAssignments)
    .innerJoin(schema.users, eq(schema.users.id, schema.staffInitiativeAssignments.userId))
    .where(inArray(schema.staffInitiativeAssignments.initiativeId, initiativeIds));

  const byInit = new Map<string, InitiativeTeam>();
  for (const id of initiativeIds) {
    const ini = initiativeById.get(id);
    if (!ini) continue;
    byInit.set(id, { initiativeId: id, initiativeCode: ini.code, programManagers: [], qiAdvisors: [] });
  }
  for (const r of rows) {
    const team = byInit.get(r.initiativeId);
    if (!team) continue;
    const member: InitiativeTeamMember = {
      userId: r.userId,
      firstName: r.firstName,
      lastName: r.lastName,
      fullName: fullName(r.firstName, r.lastName, r.email),
      email: r.email,
      staffRole: r.staffRole,
    };
    if (r.staffRole === 'program_manager') team.programManagers.push(member);
    else team.qiAdvisors.push(member);
  }
  for (const team of byInit.values()) {
    team.programManagers.sort((a, b) => a.fullName.localeCompare(b.fullName));
    team.qiAdvisors.sort((a, b) => a.fullName.localeCompare(b.fullName));
  }
  return byInit;
}

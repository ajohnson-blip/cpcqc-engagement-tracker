/**
 * CE reporting — what CPCQC owes its accreditor.
 *
 * The number that matters to ANCC/Colorado Nurses Association is contact hours
 * *awarded*, and a certificate is only awarded once it has actually been sent.
 * Someone sitting on a roster who never received one has earned nothing, so
 * every total here counts sent certificates; roster size is reported alongside
 * it as context, never as the headline.
 *
 * "Certificates issued" and "unique participants" are both reported because
 * they answer different questions: a nurse who attends three trainings is one
 * participant and three certificates, and accreditors ask for both.
 */
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { db, schema } from '@/db/index.js';
import { ceProgramLabel } from './ce-programs.js';
import { formatTrainingDate, formatContactHours } from './ce-certificate-pdf.js';

export interface CeReportFilters {
  /** ISO dates, inclusive. Default is the current calendar year. */
  from?: string;
  to?: string;
  programCode?: string;
}

export interface CeActivityRow {
  trainingId: string;
  programCode: string;
  programLabel: string;
  title: string;
  trainingDate: string;
  trainingDateDisplay: string;
  activityId: string;
  contactHours: number;
  rosterCount: number;
  certificatesIssued: number;
  /** contactHours × certificatesIssued — the awarded total for this activity. */
  contactHoursAwarded: number;
}

export interface CeReport {
  from: string;
  to: string;
  totals: {
    activities: number;
    /** Activities where at least one certificate has gone out. */
    activitiesWithIssuance: number;
    rosterTotal: number;
    certificatesIssued: number;
    contactHoursAwarded: number;
    uniqueParticipants: number;
  };
  byProgram: Array<{
    programCode: string;
    programLabel: string;
    activities: number;
    certificatesIssued: number;
    contactHoursAwarded: number;
  }>;
  activities: CeActivityRow[];
}

function defaultRange(f: CeReportFilters): { from: string; to: string } {
  const year = new Date().getUTCFullYear();
  return { from: f.from || `${year}-01-01`, to: f.to || `${year}-12-31` };
}

export async function buildCeReport(filters: CeReportFilters): Promise<CeReport> {
  const { from, to } = defaultRange(filters);

  const where = [
    gte(schema.ceTrainings.trainingDate, from),
    lte(schema.ceTrainings.trainingDate, to),
    ...(filters.programCode ? [eq(schema.ceTrainings.programCode, filters.programCode)] : []),
  ];

  const trainings = await db
    .select()
    .from(schema.ceTrainings)
    .where(and(...where))
    .orderBy(asc(schema.ceTrainings.trainingDate));

  const counts = await db
    .select({
      trainingId: schema.ceCertificates.trainingId,
      roster: sql<number>`count(*)::int`,
      issued: sql<number>`count(${schema.ceCertificates.sentAt})::int`,
    })
    .from(schema.ceCertificates)
    .groupBy(schema.ceCertificates.trainingId);
  const byTraining = new Map(counts.map((c) => [c.trainingId, c]));

  const activities: CeActivityRow[] = trainings.map((t) => {
    const c = byTraining.get(t.id);
    const hours = Number(t.contactHours) || 0;
    const issued = c?.issued ?? 0;
    return {
      trainingId: t.id,
      programCode: t.programCode,
      programLabel: ceProgramLabel(t.programCode),
      title: t.title,
      trainingDate: t.trainingDate,
      trainingDateDisplay: formatTrainingDate(t.trainingDate),
      activityId: t.activityId,
      contactHours: hours,
      rosterCount: c?.roster ?? 0,
      certificatesIssued: issued,
      // Rounded to 2dp: 1.5 × 37 is exact in decimal but not in binary floats.
      contactHoursAwarded: Math.round(hours * issued * 100) / 100,
    };
  });

  // Unique people across the whole filtered range, case-insensitively — the same
  // nurse may appear under different capitalisation in different rosters.
  const uniqueRows = await db
    .select({ n: sql<number>`count(distinct lower(${schema.ceCertificates.recipientEmail}))::int` })
    .from(schema.ceCertificates)
    .innerJoin(schema.ceTrainings, eq(schema.ceTrainings.id, schema.ceCertificates.trainingId))
    .where(and(...where, sql`${schema.ceCertificates.sentAt} is not null`));

  const byProgramMap = new Map<string, CeReport['byProgram'][number]>();
  for (const a of activities) {
    const cur =
      byProgramMap.get(a.programCode) ??
      {
        programCode: a.programCode,
        programLabel: a.programLabel,
        activities: 0,
        certificatesIssued: 0,
        contactHoursAwarded: 0,
      };
    cur.activities += 1;
    cur.certificatesIssued += a.certificatesIssued;
    cur.contactHoursAwarded = Math.round((cur.contactHoursAwarded + a.contactHoursAwarded) * 100) / 100;
    byProgramMap.set(a.programCode, cur);
  }

  return {
    from,
    to,
    totals: {
      activities: activities.length,
      activitiesWithIssuance: activities.filter((a) => a.certificatesIssued > 0).length,
      rosterTotal: activities.reduce((s, a) => s + a.rosterCount, 0),
      certificatesIssued: activities.reduce((s, a) => s + a.certificatesIssued, 0),
      contactHoursAwarded:
        Math.round(activities.reduce((s, a) => s + a.contactHoursAwarded, 0) * 100) / 100,
      uniqueParticipants: uniqueRows[0]?.n ?? 0,
    },
    byProgram: [...byProgramMap.values()].sort((a, b) => a.programLabel.localeCompare(b.programLabel)),
    activities,
  };
}

/** One row per issued certificate — the participant-level record an accreditor
 *  asks for during an audit. */
export interface CeParticipantRow {
  recipientName: string;
  recipientEmail: string;
  programLabel: string;
  title: string;
  trainingDate: string;
  activityId: string;
  contactHours: number;
  certificateCode: string;
  sentAt: string | null;
}

export async function listReportParticipants(
  filters: CeReportFilters,
  opts: { issuedOnly: boolean } = { issuedOnly: true },
): Promise<CeParticipantRow[]> {
  const { from, to } = defaultRange(filters);
  const where = [
    gte(schema.ceTrainings.trainingDate, from),
    lte(schema.ceTrainings.trainingDate, to),
    ...(filters.programCode ? [eq(schema.ceTrainings.programCode, filters.programCode)] : []),
    ...(opts.issuedOnly ? [sql`${schema.ceCertificates.sentAt} is not null`] : []),
  ];

  const rows = await db
    .select({
      recipientName: schema.ceCertificates.recipientName,
      recipientEmail: schema.ceCertificates.recipientEmail,
      certificateCode: schema.ceCertificates.certificateCode,
      completionDate: schema.ceCertificates.completionDate,
      sentAt: schema.ceCertificates.sentAt,
      programCode: schema.ceTrainings.programCode,
      title: schema.ceTrainings.title,
      trainingDate: schema.ceTrainings.trainingDate,
      activityId: schema.ceTrainings.activityId,
      contactHours: schema.ceTrainings.contactHours,
    })
    .from(schema.ceCertificates)
    .innerJoin(schema.ceTrainings, eq(schema.ceTrainings.id, schema.ceCertificates.trainingId))
    .where(and(...where))
    .orderBy(asc(schema.ceTrainings.trainingDate), asc(schema.ceCertificates.recipientName));

  return rows.map((r) => ({
    recipientName: r.recipientName,
    recipientEmail: r.recipientEmail,
    programLabel: ceProgramLabel(r.programCode),
    title: r.title,
    // Report the date the certificate actually carries.
    trainingDate: r.completionDate ?? r.trainingDate,
    activityId: r.activityId,
    contactHours: Number(r.contactHours) || 0,
    certificateCode: r.certificateCode,
    sentAt: r.sentAt ? r.sentAt.toISOString().slice(0, 10) : null,
  }));
}

/**
 * Workbook with three sheets: Summary, Activities, Participants. Three rather
 * than one because they answer different questions — the summary goes in an
 * annual report, the participant sheet is what gets pulled during an audit.
 */
export async function buildCeReportWorkbook(filters: CeReportFilters): Promise<Buffer> {
  const report = await buildCeReport(filters);
  const participants = await listReportParticipants(filters, { issuedOnly: true });

  const wb = new ExcelJS.Workbook();
  wb.creator = 'CPCQC Engagement Tracker';
  wb.created = new Date();

  const bold = { bold: true } as const;

  // ---- Summary ----
  const s = wb.addWorksheet('Summary');
  s.columns = [{ width: 34 }, { width: 22 }];
  s.addRow(['CPCQC continuing education report']).font = { bold: true, size: 14 };
  s.addRow(['Period', `${report.from} to ${report.to}`]);
  s.addRow([]);
  s.addRow(['Activities held', report.totals.activities]).getCell(1).font = bold;
  s.addRow(['Activities with certificates issued', report.totals.activitiesWithIssuance]);
  s.addRow(['Certificates issued', report.totals.certificatesIssued]).getCell(1).font = bold;
  s.addRow(['Contact hours awarded', report.totals.contactHoursAwarded]).getCell(1).font = bold;
  s.addRow(['Unique participants', report.totals.uniqueParticipants]);
  s.addRow(['Roster entries (incl. not yet sent)', report.totals.rosterTotal]);
  s.addRow([]);
  s.addRow(['Contact hours awarded counts certificates that were actually sent.']).font = {
    italic: true,
    size: 9,
  };
  s.addRow([]);
  s.addRow(['By program']).font = bold;
  s.addRow(['Program', 'Activities', 'Certificates', 'Contact hours']).font = bold;
  for (const p of report.byProgram) {
    s.addRow([p.programLabel, p.activities, p.certificatesIssued, p.contactHoursAwarded]);
  }

  // ---- Activities ----
  const a = wb.addWorksheet('Activities');
  a.columns = [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Program', key: 'program', width: 22 },
    { header: 'Training', key: 'title', width: 52 },
    { header: 'Activity ID', key: 'activityId', width: 16 },
    { header: 'Contact hours', key: 'hours', width: 14 },
    { header: 'Roster', key: 'roster', width: 10 },
    { header: 'Certificates issued', key: 'issued', width: 18 },
    { header: 'Contact hours awarded', key: 'awarded', width: 21 },
  ];
  a.getRow(1).font = bold;
  for (const r of report.activities) {
    a.addRow({
      date: r.trainingDate,
      program: r.programLabel,
      title: r.title,
      activityId: r.activityId,
      hours: r.contactHours,
      roster: r.rosterCount,
      issued: r.certificatesIssued,
      awarded: r.contactHoursAwarded,
    });
  }

  // ---- Participants ----
  const p = wb.addWorksheet('Participants');
  p.columns = [
    { header: 'Name', key: 'name', width: 26 },
    { header: 'Email', key: 'email', width: 32 },
    { header: 'Training', key: 'title', width: 52 },
    { header: 'Program', key: 'program', width: 22 },
    { header: 'Training date', key: 'date', width: 13 },
    { header: 'Activity ID', key: 'activityId', width: 16 },
    { header: 'Contact hours', key: 'hours', width: 14 },
    { header: 'Certificate ID', key: 'code', width: 20 },
    { header: 'Certificate sent', key: 'sent', width: 15 },
  ];
  p.getRow(1).font = bold;
  for (const r of participants) {
    p.addRow({
      name: r.recipientName,
      email: r.recipientEmail,
      title: r.title,
      program: r.programLabel,
      date: r.trainingDate,
      activityId: r.activityId,
      hours: r.contactHours,
      code: r.certificateCode,
      sent: r.sentAt,
    });
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Same participant record as CSV, for anyone who'd rather not open Excel. */
export async function buildCeParticipantsCsv(filters: CeReportFilters): Promise<string> {
  const rows = await listReportParticipants(filters, { issuedOnly: true });
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [
    'Name', 'Email', 'Training', 'Program', 'Training date',
    'Activity ID', 'Contact hours', 'Certificate ID', 'Certificate sent',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.recipientName, r.recipientEmail, r.title, r.programLabel, r.trainingDate,
        r.activityId, formatContactHours(r.contactHours), r.certificateCode, r.sentAt ?? '',
      ].map(esc).join(','),
    );
  }
  return lines.join('\n');
}

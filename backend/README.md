# CPCQC Engagement Tracker — Backend

Backend service for the Colorado Perinatal Care Quality Collaborative (CPCQC) hospital engagement tracker. Powers qi.cpcqc.org's hospital and staff dashboards.

## Tech

- Node.js 20+ with TypeScript
- Express for HTTP
- PostgreSQL 16 via Drizzle ORM
- JWT auth (access + refresh)
- Vitest for unit tests
- Hosted on Google Cloud Run + Cloud SQL

## Quick start

```bash
# 1. Install
npm install

# 2. Start Postgres locally
docker compose up -d

# 3. Configure env
cp .env.example .env
# edit .env — at minimum set JWT_*_SECRET to long random strings

# 4. Generate and run database migrations
npm run db:generate
npm run db:migrate

# 5. Seed initiatives, cohorts, stages, configs, and the 49 active birthing
#    hospitals (from data/hospitals_master_2026.json — the CHA master list)
npm run db:seed

# 6. Import the full task template set from task_templates_starter.xlsx
npm run db:import-templates              # commits; use -- --dry-run to preview

# 7. Auto-create enrollments from the CHA participation columns
npm run db:enroll                        # commits; use -- --dry-run to preview

# 8. Create yourself a staff user so you can sign in
npm run create-user -- --email=you@cpcqc.org --password=changeme1234 --role=cpcqc_admin --first-name=Amber --last-name=Johnson

# 9. Run the dev server
npm run dev
```

Order matters: `db:enroll` reads task templates to generate task instances per enrollment, so it has to run after `db:import-templates`.

The API runs on http://localhost:3001 by default.

## Trying the Interest Form flow

```bash
# 1. Submit an Interest Form (public — no auth)
curl -X POST http://localhost:3001/interest-forms \
  -H 'Content-Type: application/json' \
  -d '{
    "initiativeCode": "SOAR",
    "firstName": "Kelsey",
    "lastName": "West",
    "email": "kelsey.west@bannerhealth.com",
    "role": "OB Director",
    "facilityName": "Banner North Colorado Medical Center"
  }'

# 2. Sign in as your staff user
ACCESS_TOKEN=$(curl -sX POST http://localhost:3001/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@cpcqc.org","password":"changeme1234"}' \
  -c /tmp/cookies.txt | jq -r .accessToken)

# 3. List submitted interest forms
curl -sH "Authorization: Bearer $ACCESS_TOKEN" \
  'http://localhost:3001/interest-forms?status=submitted'

# 4. Approve one (use the id from step 3)
curl -sX POST -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"programYear": 2026}' \
  http://localhost:3001/interest-forms/<id>/approve
# In dev, the response includes devPasswordSetupToken — the hospital would
# normally receive this in an email.
```

The approval creates the Hospital (or reuses existing by name), an Enrollment in
`eligible_to_enroll` status, the relevant ProgramYear rows (one for 1-year
cohorts; two for TTT), one TaskInstance per seeded TaskTemplate, and a
hospital_admin user with a password-setup token. The token is emailed in
production; in development it's returned in the response for testing.

## Manage Task endpoint

Once an enrollment exists with task instances, the hospital (or staff) completes them via:

```
GET    /tasks/enrollment/:enrollmentId          # list all tasks for an enrollment
GET    /tasks/:id                                # one task
POST   /tasks/:id/manage                         # complete (or update) a task
```

The `/manage` body is type-aware:

```jsonc
{
  "status": "complete",                   // or "current_activities" | "needs_revision"
  "staffNote": "Optional staff comment",
  "payload": {                            // shape depends on the task's task_type
    // enrollment_form:
    "implementationSite": "Mother–Baby Unit, 4 South",
    "clinicalLeadName": "Dr. Kelsey West",
    "qiChampionName": "Jessica James",
    "teamMembers": [
      { "name": "Mary Fisher-Searcy", "role": "Nurse Manager", "email": "mary@..." }
    ]
    // meeting_attendance:
    // "meetingDate": "2026-03-12", "attendees": ["Kelsey West"], "notes": "..."
    // qi_advising:
    // "sessionDate": "2026-03-30", "advisorName": "...", "notes": "..."
    // data_submission:
    // "attachmentUrl": "https://.../jan.pdf", "periodCovered": "2026-01"
    // readiness_assessment:
    // "responses": { "q1": "yes", ... }
    // other:
    // "notes": "..."
  }
}
```

Side effects when a task is completed:

- **Enrollment Form**: enrollment flips from `eligible_to_enroll` to `enrolled`, and any `teamMembers` / `clinicalLeadName` / `qiChampionName` in the payload are upserted into `hospital_staff_members`.
- **Any task**: if every TaskInstance at the enrollment's current stage (for the current program year) is now `complete`, the enrollment auto-advances to the next stage by sequence number. Staff can manually advance/revert later when that endpoint is added.
- **Every change** writes an `audit_log` row.

Authorization: hospital users (and admins) can only manage tasks for their own hospital; CPCQC staff and admins can manage any.

## Dashboard endpoints

**Hospital portal** (any authenticated user):

```
GET /me                          # current user + their hospital
GET /me/enrollments              # each enrollment with current program year + compliance summary
GET /me/tasks?status=...&programYear=...   # aggregated task list across enrollments, sorted by due date
```

**Staff** (cpcqc_staff / cpcqc_admin):

```
GET /staff/overview
GET /staff/initiatives/:code/hospitals?track=active&sort=compliance&search=...
GET /staff/hospitals/:id
GET /staff/program-years/:id/compliance
```

The overview endpoint returns:

- `initiatives[]` — per-initiative counts of enrollments by status (met / onTrack / atRisk / notMet)
- `needsAttention[]` — top 30 (hospital × initiative × program year) entries with status at_risk or not_met, sorted worst-first — this is the staff member's daily action list
- `pendingInterestForms[]` — interest forms awaiting review
- `totals` — high-level counters

The per-initiative hospital list defaults to `sort=compliance` (worst first). Pass `sort=name` for alphabetical. Use `?track=sustainability` to filter to just the sustainability cohort.

The hospital detail endpoint returns every enrollment across years and initiatives, with full compliance results per program year, the hospital's staff roster (clinical lead, QI champion, team members), and the 30 most recent audit log entries.

## PM data backfill

Program managers fill out the `pm_engagement_data_jan_apr_2026.xlsx` workbook at the project root with what hospitals did in Jan–April. To ingest it:

```bash
npm run db:import-pm-data -- --dry-run          # validate without writing
npm run db:import-pm-data                       # commit
npm run db:import-pm-data -- --file=/abs/path   # custom workbook location
```

The importer matches each row against an existing `TaskInstance` by `(enrollment, period, task_type)` and updates its status, completion date, payload, and attachment URL. It also writes an `audit_log` entry per change. Annual forum attendance is automatically credited across every active enrollment the hospital holds. The script is idempotent — re-running with the same workbook produces no new changes; errors (missing enrollments, malformed periods, unknown hospital names) are collected and reported with row numbers, and nothing destructive happens until validation passes.

## Layout

```
backend/
├── src/
│   ├── server.ts             # entrypoint
│   ├── app.ts                # Express setup
│   ├── config/               # env, logger
│   ├── db/                   # schema, client
│   ├── middleware/           # auth, error handling, rate limit
│   └── modules/
│       ├── auth/             # login, logout, password reset
│       ├── compliance/       # the engagement-requirement evaluator
│       ├── hospitals/        # CRUD for hospitals
│       ├── enrollments/      # CRUD for enrollments and program years
│       ├── tasks/            # task instance management ("Manage Task")
│       ├── meetings/         # meetings and attendance
│       ├── interest-forms/   # public intake
│       ├── reports/          # CDPHE annual + per-hospital + per-initiative
│       └── notifications/    # email reminders
├── scripts/
│   ├── migrate.ts                     # run Drizzle migrations
│   ├── seed.ts                        # populate initiatives, cohorts, stages, configs, and the 49 hospitals
│   ├── import-task-templates.ts       # import the full task-template set from XLSX
│   ├── auto-enroll.ts                 # create enrollments from CHA participation columns
│   ├── import-pm-engagement-data.ts   # backfill engagement data from the PM workbook
│   └── create-user.ts                 # CLI to create staff or hospital users
└── drizzle/migrations/       # generated SQL
```

## Compliance engine

The heart of the system lives in `src/modules/compliance`. It evaluates a
`ProgramYear` against its required thresholds (which were snapshotted from the
Initiative × Track config when the program year was created) and returns a
status per requirement: `on_track`, `at_risk`, `met`, or `not_met`.

Key rules it implements:

- Active track defaults: ≥9 meetings, 4 QI advising, monthly or quarterly data.
- Sustainability track: ≥4 meetings (1 per quarter), 2 advising, 1 quarter of data, 2 HRAs.
- SPARK data submission: ≥3 of 4 quarters required (configurable via `data_submissions_min`).
- Annual forum: a `cross_initiative` meeting credits every active enrollment a hospital holds.
- TTT 2-year cohort: each program year is evaluated independently.

See `src/modules/compliance/compliance.service.test.ts` for the test cases.

## Deployment

GCP Cloud Run for the API, Cloud SQL for Postgres, Cloud Storage for data-submission uploads, SendGrid for email. CI via GitHub Actions builds the container, pushes to Artifact Registry, deploys to Cloud Run.

See `../IMPLEMENTATION_PLAN.md` for the full architecture and roll-out plan.

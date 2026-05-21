# Hospital Engagement Tracker — Implementation Plan

**Owner:** CPCQC (Colorado Perinatal Care Quality Collaborative)
**Scope:** Replace the current monday.com + knack.com tracking stack with a custom Node.js + PostgreSQL backend and a new dashboard UI, hosted on Google Cloud Platform, deployed at qi.cpcqc.org.
**Compliance posture:** Hospital-level engagement data only — no PHI. Standard web app security; no HIPAA BAA required.
**Current state:** 49 eligible hospitals; current enrollments observed in screenshots: 32 TTT, 14 SPARK, 28 SOAR (including a sustainability cohort), 11 NEST — many hospitals multi-enrolled.

---

## 1. Goals and success criteria

The platform must let CPCQC and 49 Colorado hospitals track engagement against the state's perinatal QI mandate across four initiatives (Turning the Tide, SOAR, SPARK, NEST). Success means:

- A hospital can sign in, see exactly which initiatives they are enrolled in, and tell at a glance whether they are on track for each engagement requirement, using a "Manage Task" workflow familiar from the existing site.
- CPCQC staff can see a real-time roll-up across all 49 hospitals and all four initiatives, drill into any hospital, manage interest forms and enrollments, and export an annual report for the Colorado Department of Public Health (CDPHE) with one click.
- The system distinguishes the **active cohort** track from the **sustainability cohort** track and applies the correct, lower bar to sustainability hospitals.
- The system correctly handles **multi-year cohorts** (TTT is a 2-year cohort, Jan 2026 – Dec 2027, but engagement is evaluated annually).
- Manual backfill of historical 2025/2026 data is straightforward (CSV import + admin UI).
- One source of truth replaces the spread across monday.com and knack.com.
- Email reminders nudge hospitals before deadlines and when they fall behind.

---

## 2. Domain model

The existing system in the screenshots is fundamentally **task-driven**: enrollments progress through **stages** (Pre-Enrollment → Onboarding → Enrollment → Implementation → Sustainability), each stage has **tasks** with weights, due dates, statuses (Not Started / Current Activities / Complete), staff notes, and a "Manage Task" action. The new schema reflects that model — and the four legal engagement requirements are evaluated as queries over completed tasks of specific types, not as separate entity types.

### Core entities

**Hospital** — the 49 eligible Colorado hospitals. Fields: name, NPI/CMS ID, address, region, default contact, primary user.

**Initiative** — TTT, SPARK, SOAR, NEST. Configurable, not hardcoded. Fields: name, short code, default data-submission cadence (`monthly` or `quarterly`), cohort length in years (1 for SPARK/SOAR/NEST; 2 for TTT), notes, branding color/emoji.

**Cohort** — a time-bounded class within an initiative. Fields: initiative, start date, end date, label (e.g., "2026 SPARK Cohort", "2026–2027 TTT Cohort"). Distinguishes a 1-year SPARK 2026 cohort from a 2-year TTT 2026–2027 cohort, and a *sustainability* cohort from an *active* cohort within the same initiative.

**Track** — enum on Cohort: `active` or `sustainability`. The set of requirement task templates a hospital gets is keyed by (initiative, track). SOAR is the only initiative with a `sustainability` cohort in 2026, but the model supports any initiative having one later.

**Stage** — ordered step within a track for an initiative. All four initiatives share the same active-track progression: **Enrollment → Implementation Q1 → Implementation Q2 → Implementation Q3 → Implementation Q4**. The sustainability track has the parallel **Enrollment → Sustainability Q1 → Q2 → Q3 → Q4** progression. "Pre-Enrollment" / "Eligible to Enroll" is a pre-state (no enrollment row yet), not a tracked stage. Onboarding is not a separate stage — what would have been "onboarding" tasks (the January monthly meeting, baseline data submission) are simply the January / Q1 instances of the recurring Implementation Q1 tasks; the one-time "identify clinical lead and QI champion" task lives in Enrollment alongside paperwork. Stage codes: `1.` Enrollment, `2.1`–`2.4` Implementation Q1–Q4 (active), `3.1`–`3.4` Sustainability Q1–Q4. Each stage has a stage code and a sequence number. Defined as configuration so a future initiative can deviate.

**Enrollment** — the central unit. Links Hospital × Cohort. A quadruple-enrolled hospital is four enrollment rows. Fields: hospital, cohort, current_stage, enrollment_date, withdrawal_date (nullable), status (Eligible to Enroll / Enrolled / Withdrawn / Completed). For TTT, one enrollment covers the 2-year span but is evaluated per program year. **Stage transitions** are automatic when all required tasks in the current stage reach `complete`, but staff can also advance or revert a stage manually with a note logged in the audit log — the screenshots confirmed both paths are needed.

**ProgramYear** — a year-scoped sub-bucket of an enrollment used for evaluating annual engagement requirements. For TTT enrollments, two ProgramYear rows exist (2026 and 2027). For 1-year cohorts, one ProgramYear row. Fields: enrollment, year (e.g., 2026), required_meetings, required_advising, required_data_periods, required_assessments. These required-count fields are populated from the Track + Initiative config at the time the program year is created so changes to defaults don't retroactively alter prior years.

**TaskTemplate** — the "recipe" for a task. Fields: initiative, track, stage, name, task_type (`meeting_attendance`, `qi_advising`, `data_submission`, `readiness_assessment`, `interest_form`, `other`), default_due_date_rule (e.g., "end of Q1 of program year"), period_label (e.g., "Q1 monthly initiative meeting"), knowledge_center_url. From the screenshots, the same template generates multiple TaskInstances when it recurs across quarters. (Task weights are dropped — confirmed unnecessary.)

**TaskInstance** — concrete task assigned to an enrollment for a particular period. Fields: enrollment, task_template, program_year, period (e.g., "2026-Q1"), due_date, status (`not_started` / `current_activities` / `complete` / `needs_revision`), completion_date, staff_note, attachment_url (for data submissions), assigned_attendees (for meeting attendance), updated_by, updated_at. This is what gets clicked through from "Manage Task" in the UI.

**Meeting** — a specific event tracked for attendance. Fields: title, type (`monthly_cohort` / `annual_forum`), date, location/zoom link, **cohort** (nullable; null for the annual forum since it's a single event covering all four initiatives), **cross_initiative** (true for the annual forum, false otherwise), counts_as_meetings (default 1). Monthly cohort meetings are scheduled and hosted in Zoom; the new tracker is *not* the calendaring system. Program managers (or hospitals) record attendance in the tracker after the fact. The annual forum is in person.

**MeetingAttendance** — (meeting, hospital, attended, attendees, marked_by, marked_at, notes). A single MeetingAttendance row at the annual forum is automatically credited to every active enrollment that hospital holds, because the compliance evaluator counts any in-period MeetingAttendance where `meeting.cohort = this enrollment's cohort OR meeting.cross_initiative = true`. So one staff attending the 2026 annual forum satisfies the "Q-period meeting" task for SOAR, SPARK, and any other initiative the hospital is enrolled in — exactly the behavior you described.

**InterestForm** — pre-enrollment intake. Fields: hospital (nullable, may be a new prospect), initiative, first name, last name, email, role, facility name, submission date, status (Submitted / Reviewed / Approved / Declined), staff_notes, reviewed_by, reviewed_at. Maps to the "Interest Forms" tab visible in the screenshots. Submitted from a public page (no login). Program managers review for eligibility (Colorado hospitals only) and recommend approval based on prior-year performance. Approval triggers an email notification and unlocks the Enrollment Form for the hospital.

**Enrollment Form workflow** — the Enrollment Form is the *single* task that fulfills the **Annual Enrollment** legal requirement. It is an **annual** task generated per ProgramYear, not a one-time-per-enrollment task. Consequences:
- 1-year cohorts (SPARK, SOAR active, NEST, SOAR sustainability) generate one Enrollment Form task instance per enrollment.
- TTT's 2-year cohort generates **two** Enrollment Form task instances per enrollment (one for 2026, one for an updated 2027 form).
- Sustainability hospitals also submit an annual Enrollment Form — eligibility is assessed during fall open enrollment.
- The form itself captures implementation-site details, clinical lead, QI champion, and team roster. On submit, the system creates / refreshes `hospital_staff_members` rows for the named team, flips the ProgramYear's enrollment requirement to met, and (for first-year enrollments) advances the enrollment from `eligible_to_enroll` to `enrolled`.
- Submission is the only step required for enrollment — no separate paperwork or engagement letter.

**User** — sign-in identity. Belongs to either a Hospital (role: `hospital_user` or `hospital_admin`) or CPCQC (role: `cpcqc_staff` or `cpcqc_admin`). One user can belong to one hospital; staff users have no hospital binding.

**HospitalStaffMember** — non-user roster of clinical leads, QI champions, etc., per hospital per initiative (the "SOAR – Hospital Staff" button in the screenshots). Not necessarily login users.

**KnowledgeCenterArticle** — referenced from TaskTemplate.knowledge_center_url; can be external links or hosted markdown. Optional first-pass: just use URLs.

**Notification** and **AuditLog** — outbound email log and immutable audit trail of state changes.

### How the four legal requirements map onto this model

Compliance for a ProgramYear is computed by counting completed TaskInstances of the right types:

- **Annual enrollment**: enrollment row exists for that program year, status is `Enrolled`, and `Pre-Enrollment` stage is complete.
- **Meeting attendance**: count of `meeting_attendance` TaskInstances with status `complete` in the program year, including any annual forum attendance (each counted as 1).
- **QI advising**: count of `qi_advising` TaskInstances with status `complete` in the program year.
- **Data submission**: count of `data_submission` TaskInstances with status `complete` (or `accepted`) in the program year, evaluated against the cadence rule for that initiative.

The thresholds are read from the ProgramYear row (snapshotted at creation), which itself comes from Track + Initiative configuration. This means the *exact same code path* evaluates both an active TTT hospital (≥9 meetings, 4 advising, monthly data) and a SOAR sustainability hospital (≥4 meetings, 2 advising, 1 data period, 2 HRAs).

### Track-specific defaults

| Initiative | Track | Meetings/yr | QI advising/yr | Data submission | HRA/yr |
|---|---|---|---|---|---|
| TTT (all years of 2-yr cohort) | active | ≥9 | 4 (quarterly) | monthly | n/a |
| SPARK | active | ≥9 | 4 (quarterly) | quarterly; ≥3 of 4 quarters | n/a |
| SOAR | active | ≥9 | 4 (quarterly) | monthly | n/a |
| SOAR | sustainability | ≥4 (1/quarter, monthly meeting or annual forum) | 2 (bi-annual) | 1 quarter | 2 (bi-annual) |
| NEST | active | ≥9 | 4 (quarterly) | monthly | n/a |
| any | sustainability (future) | ≥4 (1/quarter) | 2 | 1 quarter | 2 |

These defaults live in config rows on (Initiative, Track), are copied onto each new ProgramYear, and can be amended per program year if the state mandate changes.

### SPARK's "3 of 4 quarters" rule

`data_submission` TaskInstances for SPARK are generated quarterly. The compliance evaluator for `data_submission` in SPARK uses a "≥3 of 4 complete" rule rather than "all 4 complete". This is configured on the (initiative, track) row as `data_submission_min` (default = required) so other initiatives can express similar partial-credit rules later if needed.

### TTT 2-year cohort handling

A TTT Enrollment spans Jan 2026 – Dec 2027. Two ProgramYear rows are created at enrollment (2026 and 2027). Each is evaluated independently against the annual requirements. The hospital does not re-enroll for year 2; the system simply moves them to the 2027 ProgramYear when the calendar rolls over. Stages continue across both years (no reset).

### Sustainability transition

In the fall before a new program year, staff assess each `active` enrollment for sustainability eligibility. If eligible, the staff creates a new Enrollment for the hospital in a `sustainability`-track Cohort starting Jan of the next year. The hospital's active-track Enrollment is marked `Completed`. The new sustainability enrollment uses the lower task template set automatically.

---

## 3. API surface

A single REST/JSON API serves both portals. Endpoints are role-scoped.

### Auth

- `POST /auth/login`, `POST /auth/logout`, `POST /auth/password-reset/{request,confirm}`
- `POST /auth/invite` (staff) — emails an invite to a hospital user
- Optional TOTP 2FA endpoints for staff

### Hospital-facing

- `GET /me` — current user, hospital, active enrollments
- `GET /hospitals/:id/enrollments` — list with computed compliance per program year
- `GET /enrollments/:id` — full detail: current stage, all task instances, progress %, due dates
- `GET /enrollments/:id/tasks?period=2026-Q1&status=current_activities` — filtered task list
- `POST /tasks/:id/manage` — the "Manage Task" action. Body varies by task_type: attendance update, file upload for data submission, advising session log, HRA survey responses.
- `GET /tasks/:id/knowledge` — knowledge-center article or external link redirect

### Staff-facing

- `GET /staff/overview` — across-initiative roll-up, hospitals needing attention
- `GET /staff/initiatives/:code/hospitals` — the "Manage Hospitals" tabbed views from the screenshots (per-initiative hospital list with status, stage, cohort, contact)
- `GET /hospitals`, `GET /hospitals/:id`, `POST /hospitals`, `PATCH /hospitals/:id`
- `POST /enrollments`, `PATCH /enrollments/:id` (incl. stage transitions and sustainability moves)
- `POST /cohorts`, `PATCH /cohorts/:id` — create the 2026 SPARK cohort, the 2026–2027 TTT cohort, etc.
- `POST /meetings`, `PATCH /meetings/:id` — schedule a meeting; bulk-mark attendance creates the matching TaskInstance updates
- `POST /task-templates`, `PATCH /task-templates/:id` — admin-only configuration
- `POST /interest-forms`, `PATCH /interest-forms/:id` — manage the intake pipeline
- `GET /reports/annual?program_year=2026&format=pdf|xlsx|csv`
- `GET /reports/hospital/:id?program_year=...&initiative=...`
- `GET /reports/initiative/:code?program_year=...`
- `POST /admin/import` — CSV upload for backfill, with dry-run preview

### Real-time updates

Polling every 30–60 seconds when a dashboard is open is sufficient. WebSockets are not worth the complexity at 49 × 4 scale. Compliance is recomputed on every read and cached for ~30 seconds.

---

## 4. Authentication, authorization, and account model

- **Identity**: email + password, strong password rules, rate-limited login.
- **Sessions**: short-lived JWT access token (15 min) + refresh token in HttpOnly secure cookie scoped to qi.cpcqc.org.
- **Roles**:
  - `hospital_user` — read their hospital's enrollments, run "Manage Task" actions
  - `hospital_admin` — same plus manage users for their hospital and update hospital contact info
  - `cpcqc_staff` — full read across hospitals, write to enrollments and tasks, run reports
  - `cpcqc_admin` — staff plus user management, task template configuration, audit log access
- **Provisioning**: staff create the hospital; staff send an invite email to the hospital_admin; that admin invites coworkers.
- **2FA**: recommended for all staff; optional for hospital users.
- **SSO**: defer to a v2; launch with email/password.

---

## 5. Front-end (new dashboard UI)

A new app built alongside the backend. Recommendation: **Next.js + React + Tailwind + a headless component library (Radix / shadcn-ui)**. Recharts or Chart.js for the progress visualizations. Same language ecosystem as the backend, server rendering for fast initial loads. Deployed to GCP Cloud Run alongside the API, or to Vercel for development velocity (low monthly cost either way).

### Information architecture

The existing site uses a mental model that should be preserved (your team is already trained on it) even if visual design differs:

**Top navigation**: Overview, Engagement Tracker, Enter QI Data, Interest Forms, Help. Account / logout at top right.

**Staff dashboard**: a tabbed view of initiatives — Manage Hospitals (per initiative), Interest Forms, CPCQC Staff, plus tabs for each of the other initiatives so a staff member can move between TTT, SPARK, SOAR, NEST contexts quickly. Within each initiative's "Manage Hospitals" tab, a searchable, filterable, paginated table of hospitals with columns: name, contact, enrollment status (color-coded), stage, cohort (active vs. sustainability), Details, Edit.

**Hospital detail (staff view)**: contact info, current facility status, stage, buttons for Progress Reports and Hospital Staff, and a Progress table — same pattern as the SOAR sustainability screenshot — listing tasks grouped by stage with stage code, status, due date, staff note, and the Manage Task / Knowledge Center actions per row. (No weight column.) Both program managers and hospital users can click Manage Task to record attendance, upload data, or log an advising session; the audit log captures who did what.

**Hospital portal (hospital user view)**:
- Home: one card per active enrollment, showing the four engagement requirement tiles (enrollment, meetings X of N, advising X of N, submissions X of N), color-coded on-track / at-risk / not-met
- Initiative page: full Sustainability-Progress-style task table for that initiative's current program year, with Manage Task buttons inline
- "Manage Task" modal: opens contextual UI for the task type — upload a file, log attendance, submit HRA responses, log a QI advising session
- Account settings: users, password, hospital contact info

### Visual / UX latitude

You confirmed the UI design doesn't have to follow the existing site exactly. The plan keeps the same mental model and information density but I'll modernize the look (better empty states, clearer status indicators, mobile-friendly table behavior). I'd suggest a small design review pass after the schema is built and before page implementation, with mockups for the 4–5 highest-traffic screens.

---

## 6. Reporting

- **Annual CDPHE report**: PDF via Puppeteer rendering an HTML template, with companion XLSX. Per-hospital compliance per initiative per program year, summary statistics, prior-year comparison. No specific format required per your clarification, so I'll design something clean and CDPHE-friendly that you can iterate on.
- **Per-hospital report**: scoped to one hospital across enrollments and years.
- **Per-initiative report**: cross-hospital cohort view.
- **Ad-hoc CSV export**: every staff list view.
- **Scheduled snapshots**: nightly job snapshots ProgramYear compliance so historical "where did we stand on March 1?" queries are answerable.

---

## 7. Notifications and email reminders

- **Transactional**: invites, password resets, report-ready emails.
- **Reminders**:
  - 7 days before a task due date
  - 1 day before a task due date
  - When a hospital's pace falls behind (computed nightly): "you have completed X of Y required meetings; at current pace you will miss the annual requirement"
  - End of each quarter, summarizing what's done and what's outstanding for the quarter
  - Optional weekly digest to hospital_admins
- **Staff notifications**: when a hospital is at-risk or has fallen below threshold; when a new Interest Form is submitted.
- **Delivery**: SendGrid (recommended) or Mailgun. Both have free tiers sufficient for this volume. From-address `engagement@qi.cpcqc.org` once DNS records are set up.
- **Preferences**: per-user opt-out for reminders (not for transactional).
- **Audit**: every email logged in the `Notification` table.

---

## 8. Infrastructure and deployment (Google Cloud Platform)

GCP, per your choice. The architecture maps cleanly off the AWS equivalents I'd otherwise suggest.

### Components

- **App runtime (API)**: **Cloud Run**, containerized Node.js. Auto-scales to zero when idle, scales out on traffic. ~$10–30/month at this volume.
- **App runtime (Next.js front-end)**: also **Cloud Run** (server-rendered Next.js fits Cloud Run well) — or Vercel for development velocity. Recommend Cloud Run to keep everything in one cloud and one billing line.
- **Database**: **Cloud SQL for PostgreSQL**, `db-g1-small` to start (~$25/month) with automated backups and point-in-time recovery. Move to a regional/HA tier before launch to all 49 hospitals.
- **File storage**: **Cloud Storage** bucket for data-submission uploads, accessed via signed URLs.
- **Email**: **SendGrid** (third-party, has a clean GCP integration) for transactional and reminder email.
- **Background jobs**: **Cloud Run Jobs** (one-shot containers triggered by Cloud Scheduler) for the nightly compliance snapshot, due-date reminders, and report generation.
- **Secrets**: **Secret Manager**.
- **Monitoring/logging**: **Cloud Logging** + **Cloud Monitoring**, plus **Sentry** (free tier) for error tracking.
- **CI/CD**: **GitHub Actions** building containers, pushing to **Artifact Registry**, deploying to Cloud Run on `main` (with a `staging` branch and a separate Cloud Run service for staging).

### Domain (qi.cpcqc.org) — currently WordPress

qi.cpcqc.org is currently a WordPress site (you'll get admin access). Two practical paths:

1. **Subdomain split (recommended for launch)**: keep the existing WordPress site at `qi.cpcqc.org` for marketing / public pages / interest forms, and deploy the new app at `app.qi.cpcqc.org` or `tracker.qi.cpcqc.org`. The WP site adds a link/button to launch the tracker. This is the lowest-risk cutover because the marketing site keeps working untouched, and you can defer any WP-to-React migration of public content. Requires a new DNS A/CNAME record pointing the subdomain at GCP, plus a managed TLS cert.

2. **Full replacement at qi.cpcqc.org**: audit the WP site, port any pages worth keeping into the new Next.js app as static or CMS-backed routes, then point qi.cpcqc.org DNS at the new app and decommission WordPress. Cleaner long-term, more upfront work, slight risk of losing SEO or breaking inbound links if any redirect is missed.

I'd recommend launching with option 1 and migrating to option 2 once the tracker is stable and we've inventoried the WP content. Phase 0 includes a one-day WP content audit to decide whether anything on the marketing site is worth keeping; if it's just a landing page and links, full replacement becomes easy.

GCP HTTPS Load Balancer or Cloudflare in front for TLS, caching, and the managed cert.

GCP load balancer or Cloudflare in front for TLS, caching, and a managed cert for qi.cpcqc.org.

### Estimated monthly cost (steady state)

- Cloud Run (API + front-end): ~$20
- Cloud SQL Postgres db-g1-small: ~$25–35
- Cloud Storage + Cloud Logging + Secret Manager: <$5
- SendGrid: free at this volume (under 100/day) or $20/month for the Essentials tier
- Domain / Cloudflare: existing
- **Total: ~$50–80/month**

---

## 9. Migration from monday.com and knack.com

A clean cutover with a one-month parallel period.

1. **Inventory**: full export of every relevant monday.com board and knack.com object to CSV.
2. **Schema map**: spreadsheet mapping current columns → new schema. Particular attention to:
   - Task names, stage codes, and weights (these should largely transplant 1:1 from the existing knack tables, given the screenshots)
   - Cohort year and TTT 2-year span
   - Sustainability vs active flags on SOAR enrollments
3. **Backfill UI**: admin-only `/admin/import` page; each entity type (hospitals, users, cohorts, enrollments, task templates, task instances, meetings, interest forms) imports from CSV with dry-run + diff preview before commit.
4. **Validate**: reconcile 5 hospitals across all four initiatives — one quadruple-enrolled, one SOAR-sustainability, one TTT-only — against the source systems manually.
5. **Cutover**: freeze monday.com / knack.com to read-only, announce launch, decommission after 30 days of parallel.

---

## 10. Phased delivery plan

For one focused full-stack developer working ~full time. Faster with two.

**Phase 0 — Discovery and design (1 week)**
Finalize schema with a CPCQC QI lead (especially task template lists per initiative/track/stage), capture screenshots and key flows of the existing site, produce wireframes for the 5 most important pages.

**Phase 1 — Foundations (2 weeks)**
GCP project + Terraform, Cloud Run + Cloud SQL + Artifact Registry + Secret Manager, repo + CI/CD, Postgres schema migrations, auth, user management, hospital + initiative + cohort + enrollment CRUD.

**Phase 2 — Task model and engagement tracking (3 weeks)**
TaskTemplate seed data for all four initiatives × both tracks × every stage, TaskInstance generation on enrollment/program-year creation, "Manage Task" endpoint with type-specific handlers (attendance, data upload, advising log, HRA), Meeting scheduling, compliance computation engine with SPARK 3-of-4 rule and sustainability thresholds, audit log.

**Phase 3 — Dashboards (3 weeks)**
Hospital portal (home + initiative pages + task management modal), staff dashboards (per-initiative Manage Hospitals tables, hospital detail with progress table, stage management), Interest Forms intake.

**Phase 4 — Reporting, email, exports (2 weeks)**
Annual CDPHE report (PDF + XLSX), per-hospital and per-initiative reports, CSV export everywhere, nightly snapshot job, SendGrid integration with all reminder rules.

**Phase 5 — Migration, UAT, training (1–2 weeks)**
Backfill from monday.com/knack, parallel run for one month with 3–5 pilot hospitals, staff training, hospital onboarding materials.

**Phase 6 — Launch and stabilize (ongoing)**
Cut over qi.cpcqc.org, roll out invites to all 49 hospitals, monitor, iterate.

**Total**: ~12–14 weeks to launch with a single focused developer; ~8–10 weeks with two.

---

## 11. Resolved questions and remaining gaps

### Resolved

- **Hosting**: qi.cpcqc.org is WordPress. Cutover plan in §8 — launch the tracker on a subdomain first, optionally fold WordPress in later.
- **Stages**: all four initiatives share Enrollment → Implementation Q1–Q4 for the active track, with a parallel Enrollment → Sustainability Q1–Q4 progression for sustainability hospitals. No separate Onboarding stage — orientation and baseline data simply *are* the January / Q1 instances of the recurring Implementation Q1 tasks.
- **Stage transitions**: automatic when all stage tasks complete, with manual override available to staff.
- **Task weights**: removed.
- **Knowledge Center**: existing URLs reused; stored as a `knowledge_center_url` on each TaskTemplate.
- **Meeting scheduling**: monthly meetings are scheduled and hosted in Zoom outside the tracker. The tracker records attendance only, marked by program managers or hospital users.
- **Annual forum**: one annual in-person forum across all initiatives. Modeled as a single Meeting with `cross_initiative = true` so one MeetingAttendance row credits every enrollment the hospital holds.
- **Interest Form fields** (per-initiative variant of the form): First Name, Last Name, Email, Role, Name of Facility — all required. Intro text per initiative ("Thank you for your interest in the CPCQC – 'Turning the Tide' Program…"). Submitted from a public page on qi.cpcqc.org (no login required); on submit, a record is created in `interest_forms` and an email notification fires to CPCQC staff.
- **Enrollment workflow**: Interest Form (public) → program manager review (eligibility check + prior-year performance) → approval/decline → notification email → Enrollment Form available to hospital. The Enrollment Form is the single task that fulfills the legal Annual Enrollment requirement. It is *annual* — submitted every program year, including Year 2 of TTT's 2-year cohort (with an updated form), and every year for sustainability hospitals. Submission is the only step required for enrollment.

### To be delivered by you (inputs to Phase 0)

- **Task template spreadsheet**: canonical task list for each (initiative × track × stage) combination. SOAR sustainability is partially visible from the screenshots; the other 7 combinations (4 initiatives × active track × 6 stages, plus SOAR sustainability) need to be filled in. I can draft a starter template — see §13.
- **Enrollment Form fields**: the Enrollment Form schema (what implementation-site / clinical-lead / team fields are captured, what conditional logic, what attachments). Once shared, the public Enrollment Form UI and validation are straightforward to build.
- **Knowledge Center URLs**: a list mapping each task template to its existing URL.

### Still open (smaller, decideable later)

- **WordPress content audit**: a quick inventory of what lives on the current qi.cpcqc.org so we know whether to leave WP running indefinitely or migrate to option 2.
- **Annual forum date and naming convention**: needed only when we seed the 2026 forum record.
- **Reminder cadence preferences**: the §7 default (7 days, 1 day, end-of-quarter, behind-pace) is a starting proposal — you can tune it after seeing it in action.

---

## 12. What I'd build first

If I were starting tomorrow with all of the above answered:

1. Schema migrations for every entity in §2, with TaskTemplate seed data for at least SOAR active and SOAR sustainability (the most clearly specified from the screenshots).
2. Seed: 4 initiatives, 49 hospitals (names only), 2026 cohort rows for each initiative, plus the SOAR 2026 sustainability cohort.
3. Compliance computation function with unit tests covering: active hospital with full attendance, active hospital missing 2 meetings, sustainability hospital with 4 meetings + 2 advising + 1 quarter data + 2 HRA, SPARK hospital with 3-of-4 quarters submitted, TTT hospital evaluated in year 1 of 2.
4. Login flow, `/me`, and the hospital portal home page reading from `/me` and rendering enrollment cards with the four-tile compliance view.
5. The "Manage Task" modal for the two most common task types (meeting attendance and data submission).

That gives a tangible end-to-end vertical slice in two to three weeks, against which we can demo and pressure-test the model before building the rest.

---

## 13. Immediate next step: task template spreadsheet

The single longest-pole input is the canonical task list. I can produce a starter XLSX with one sheet per (initiative × track) and columns for: stage, task name, task_type, period (Q1/Q2/Q3/Q4/once), default_due_date_rule, knowledge_center_url, notes. You and a QI lead fill in the rows. I'd pre-populate it with:

- SOAR sustainability tasks (already visible in your screenshots)
- A skeleton of "Attend at least one Q-monthly meeting", "Submit Q-data", "Complete Q-advising session" for each quarter for active-track initiatives
- The annual forum task (one row, cross-initiative)
- The HRA tasks for sustainability tracks

This single document drives Phase 1 seeds, Phase 2 task generation logic, and the backfill mapping in Phase 5. Say the word and I'll generate it as the next deliverable.

---

## 14. Future enhancements (post-launch)

### REDCap integration — auto-complete data submission and HRA tasks

Data submissions and Hospital Readiness Assessments are filled in REDCap, not the tracker. Today, program managers transcribe completion into the tracker manually (via the PM workbook backfill, the Manage Task UI, or the hospital portal). The tracker is the system of record for *engagement*, REDCap is the system of record for *responses*.

A near-term improvement is to remove the manual transcription. REDCap exposes two integration points that map cleanly onto our needs:

1. **Data Entry Trigger (DET) webhook** — REDCap can POST to a configured URL each time a survey is submitted. We add a `POST /webhooks/redcap` endpoint that accepts the trigger, looks up the matching TaskInstance (hospital × initiative × period), and marks it complete. Real-time and event-driven.

2. **REDCap API polling** — As a backstop for missed webhooks (network blips, REDCap project misconfigurations), a nightly Cloud Run Job pulls all completions from each REDCap project since the last successful sync and reconciles them against the tracker. Idempotent — re-pulling a completion already recorded is a no-op.

The hardest part is **identity mapping**: REDCap projects identify hospitals by `record_id` (typically a numeric ID), and our tracker uses our own UUIDs. We'd add a `redcap_record_id` column on `hospitals` and one `redcap_project_id` per (initiative × purpose) combo (e.g., one REDCap project per initiative for data, one for HRAs). A short onboarding step seeds these mappings.

**Period derivation** is the other concern: a REDCap survey submitted on March 25 needs to be credited to either January monthly data, February, or March (probably whichever month/quarter the response is *about*, not when it was submitted). REDCap forms typically have a "data period" or "month" field we can read from the submission to pick the right TaskInstance.

This drops the PM workbook from being a recurring data-entry tool to being a one-time historical backfill — which is the right end state.

### Other ideas worth keeping on the list

- **Zoom calendar sync** for meeting scheduling, so PMs don't have to manually create Meeting records.
- **Attendance from Zoom** — pull post-meeting reports and pre-populate MeetingAttendance rows. Hospitals confirm rather than enter.
- **Cross-initiative annual forum smart-credit** in the Manage Task UI — marking annual forum attendance for one initiative prompts the user to also credit other enrollments the hospital holds (today the importer does this for backfill, but the live UI requires per-enrollment clicks).
- **Mobile-friendly Manage Task view** — many hospital QI champions are clinicians who'd benefit from a phone-sized "mark Q1 meeting attended" flow.
- **Public-facing initiative pages** — short marketing pages per initiative on qi.cpcqc.org embedding live "X of 49 hospitals enrolled" stats.
- **CDPHE report templates as code** — once we know what CDPHE expects, ship a few additional report templates (statewide cesarean rate, sustainability cohort outcomes).

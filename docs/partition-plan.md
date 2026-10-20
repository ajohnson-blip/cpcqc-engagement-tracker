# REDCap partition — plan

**Status:** phases 1 and 2 are built for SOAR and await their checkpoints —
see "Build phases" 
**Date:** 20 October 2026
**Supersedes:** the on-demand assessment service described in contract v1

---

## Summary

A single Python script at CHA runs nightly, reads REDCap for all four programs,
and produces one assessment file. CHA decides where that file is written and
whether it is delivered onward. The tracker's Engagement Tracker Workspace
receives the file and builds its sync previews from it. That workspace holds no
REDCap credentials and never contacts REDCap.

Program managers keep the workflow they have today — preview, override, apply,
finalize. What changes is where the preview's data comes from: last night's
file rather than a live REDCap query.

---

## What changed from v1, and why

| | v1: on-demand service | v2: nightly file |
|---|---|---|
| Trigger | PM presses sync | Scheduled, once a night |
| At CHA | An internet-reachable service, always running | A script that runs and exits; no listening port |
| Freshness | Live | Up to ~24 hours old — **accepted** |
| If CHA is unavailable | Nobody can sync | PMs sync from the most recent file |
| What leaves CHA | Transient responses | One inspectable file per night |
| Validation by CHA IT | A network service holding REDCap tokens | A batch job with outbound-only traffic |

The change was proposed because a batch job is considerably easier for CHA IT
to validate. The rules, the output shape, and the division of responsibility
between CHA and the tracker are unchanged from v1.

---

## Where each part runs

| Component | Runs on | Holds REDCap credentials | Contacts REDCap |
|---|---|---|---|
| Assessment script | CHA | yes | yes, nightly |
| Output file | CHA-chosen location | — | — |
| Tracker — My Workspace | Render (current production) | yes, until cutover | yes, until cutover |
| Tracker — Engagement Tracker Workspace | Render | **no** | **never** |

My Workspace keeps querying REDCap directly (`SYNC_SOURCE=redcap`) until the
new path has been shown to agree with it. The Engagement Tracker Workspace runs
`SYNC_SOURCE=cha` from the start.

---

## Decisions taken

1. **The output location is set by CHA**, through a variable in the script's
   configuration, so it is fully in CHA's control.
2. **Next-morning visibility is acceptable.** A PM will not see a submission
   until after the following night's run.
3. **Approved packages only:** Python 3.13.5, pandas 2.2.3, requests 2.32.3,
   python-dotenv 1.1.0. Tests use the standard library's `unittest` so that
   running them needs nothing further.
4. **TtT spans three REDCap projects** — hospital, patient, and CHoSEN Dyadic.

---

## The output location — needs a decision

The script writes its file to a location CHA sets. Two kinds of location are
possible using only the approved packages:

| Location | How | Library |
|---|---|---|
| A filesystem path — local disk or a mounted network share | write the file | standard library |
| An HTTPS endpoint | POST the file | `requests` |

Locations reached through a vendor SDK — S3, Azure Blob, SharePoint or OneDrive
through Microsoft Graph — would need a library outside the approved list, which
would itself need CHA IT approval.

**The tracker runs on Render and cannot read a path on CHA's network.** So
whatever CHA chooses for its own copy, the tracker only receives the file if it
is delivered to somewhere the tracker can reach.

**Proposed:** two independent settings, both CHA's.

- `OUTPUT_DIR` — where the script writes each night's file. CHA's retained,
  inspectable copy. Required.
- `DELIVERY_URL` — if set, the script also POSTs the same file to the tracker.
  If unset, nothing leaves CHA and delivery is CHA's to arrange by other means.

This keeps CHA in full control of both where the file lives and whether it is
sent, and it needs nothing beyond `requests`.

**Built as proposed.** The tracker receives the file at
`/integrations/cha/assessment-files`, authenticated with a token shared with
CHA.

**For review:** whether CHA IT is content with an outbound HTTPS POST to the
tracker, or has a different shared location in mind. A different location is
possible but changes both sides — another library at CHA, and a matching reader
in the tracker.

---

## Per-program sources

| Program | REDCap project(s) | Token(s) | Read | Notes |
|---|---|---|---|---|
| **SPARK** | SPARK | `REDCAP_SPARK_TOKEN` | `quarterly_measures`: submission date, IPV gate, events | Aggregate counts, not patient-level. Longitudinal — only `*_data*` events are quarterly submissions. Currently exported as a whole form; the script will request named fields. |
| **NEST** | NEST | `REDCAP_NEST_TOKEN` | `safe_sleep_audit`, `chart_reviews` | Repeating instruments. Race, ethnicity, language and payor are required fields, so they are retrieved to test for presence; their values are never used or sent. |
| **SOAR** | SOAR | `REDCAP_SOAR_TOKEN` | `ntsv_cesarean_section`, `no_ntsv_csections` | Age, delivery date and gestational age are required fields, retrieved for presence only. Reference implementation already written. |
| **TtT** | Hospital, Patient, CHoSEN Dyadic | three tokens — see below | monthly hospital form, its data dictionary and its log; patient form; Dyadic maternal form | The most involved program. Ported last. |

---

## TtT in detail

| | Hospital project | Patient project | CHoSEN Dyadic project |
|---|---|---|---|
| Token | `REDCAP_TTT_HOSPITAL_TOKEN` | `REDCAP_TTT_PATIENT_TOKEN` | `REDCAP_TTT_DYADIC_TOKEN` |
| Form | `co_aim_sud_learning_collaborative_monthly_hospital` | `co_aim_sud_quantitative_patientlevel_data` | `chosen_sud_maternal` |
| Hospitals | all TtT | all except Denver Health | **Denver Health only** |
| Used for | submission, completeness, positive screens | eligible patient forms | Denver Health's eligible patient forms |
| Eligibility field | — | `sample_check_patient` | `sample_check_mat` |
| Qualifying substance codes | — | 1, 2, 4, 5, 6, 8, 9 | 1–6 |
| REDCap instance | shared CPCQC instance | shared CPCQC instance | **may differ** — `REDCAP_TTT_DYADIC_API_URL` |

Points that are easy to get wrong:

- **The two substance-code lists must not be unified.** The checkbox field has
  the same name in both projects, `substances_used_2___N`, but the codes mean
  different things. In Dyadic, 7 is alcohol, 8 nicotine and 9 cannabis, all
  excluded; in the patient project 8 and 9 qualify.
- **The Dyadic project is shared with other collaboratives.** Only rows in
  Denver Health's data access group are used — `denver_health` by default,
  configurable as `REDCAP_TTT_DYADIC_DH_DAG` because the spelling may differ.
- **Dyadic's record-ID field may not be called `record_id`**, so it is not
  requested by name.
- **Submission dates come from REDCap's logging API**, as the earliest
  "Create Record" entry per record — not from a field. The hospital-project
  token therefore needs the *Logging* user right as well as export. If the log
  is unavailable, timeliness for that run is reported as unknown rather than
  failing the program.
- **Required fields come from the live data dictionary**: fields marked
  required on the monthly hospital form, excluding `@HIDDEN` fields and
  `tot_anx_scrnd`.
- **The linkage check** compares positive SUD screens on the hospital report
  against eligible patient forms. Falling below the floor makes the month
  incomplete; falling below the one-form-per-positive ideal is reported but
  does not block. The counts come from patient-level records, which is why the
  calculation has to happen at CHA.

---

## Failure handling and alerting

**One program failing does not block the others.** Each program's result in
the file carries its own status. If the TtT pull fails, SOAR, SPARK and NEST
still land, and the tracker shows the TtT failure on TtT's sync page only.

**A schema violation rejects the whole file.** That is a different kind of
failure: it means the script produced something the contract does not allow,
which is a defect rather than a REDCap outage, and output from a script in that
state should not be accepted at all.

**A script cannot report that it did not run.** It can report its own errors,
but if the machine was off or the schedule was deleted, nothing is produced and
nothing is sent. Absence can only be noticed by whoever expects the file. So
detection has to happen on the receiving side as well as at CHA.

Three layers, not mutually exclusive:

| | What catches it | Covers | Needs |
|---|---|---|---|
| **A** | The script exits non-zero; CHA's scheduler is configured to email on failure | REDCap errors, failed delivery, bad configuration | CHA's scheduler, nothing new in the script |
| **B** | Every tracker preview shows the file's age, and warns when it is older than a threshold | Everything, but only when a PM looks | Tracker change only |
| **C** | A small daily job on the tracker side checks the newest file's age and emails a configured address when it is stale | Everything, including the script never running, without anyone having to look | A Render cron job; uses the tracker's existing email |

**Proposed:** B always; C as the proactive alert, because it catches the case
A cannot; A at CHA's discretion. **B is built:** every SOAR preview shows when
CHA's file was produced and how old it is, warns when it is more than 30 hours
old, and warns when a newer run for that program failed. The recipient for C could be Luis, a CPCQC
address, or both.

**For review:** who receives the alert, and whether C is worth a Render cron
job's cost.

---

## Safeguards

Carried over from v1:

- **Minimum necessary.** Each program requests exactly the fields its rules
  read, by name, with no form parameter — REDCap returns the union of named
  fields and every field on a named form, so sending both restricts nothing.
- **No record identifiers in the output**, and no dates of birth or delivery,
  ages, race, ethnicity, language, payor, or free text from any record.
- **Error messages describe a response, never quote it.**

New with a batch design:

- **No intermediate files containing record-level data.** REDCap exports stay
  in memory. The only file the script writes is the assessment output. A batch
  script's natural shape is export-to-CSV-then-process, so this is stated
  explicitly.
- **The tracker validates strictly.** Any field the contract does not define
  causes the file to be refused rather than stored. This is a second line of
  defence: a stray field — `delivery_date` copied into an assessment by
  mistake, say — cannot reach the tracker's database.
- **Every preview shows when its data was produced**, so nobody mistakes last
  night's file for live data.
- **Finalization checks the file's age.** See below.

---

## Timing

**Run after midnight Mountain time.** This matters because of finalization.

Finalizing a month locks its tasks against future syncs. Suppose the script
ran at 11pm, and a hospital submitted on time at 11:30pm on deadline day. The
next morning a PM applies and finalizes from that file: the hospital shows as
not submitted, and the lock stops the following night's file from correcting
it. Running after midnight means a file produced the day after a deadline
includes everything submitted on the deadline day.

As a backstop, the tracker **asks for confirmation before finalizing a month
whose tasks were last synced from data produced before the end of that
month's deadline day**, Mountain time — the same confirm-to-lock step it
already uses for a month with unresolved tasks. Every Apply records, for each
month it covered, when its data was produced and the deadline it was judged
against; finalizing checks the most recent. Per month rather than per task,
because an Apply leaves unchanged tasks untouched although the newer data
confirmed them.

**Year rollover.** December's data arrives in January, and submissions can be
late. The script should compute the previous program year as well as the
current one for part of the new year. *For review: how long.* January through
February is proposed, overridable with `PROGRAM_YEARS`.

---

## What carries over from work already done

| | Carries over | Replaced |
|---|---|---|
| **CHA script** | SOAR rules (`soar.py`), the REDCap client's logic, the crosswalk, the output shape, the test cases | The web service (`main.py`, `auth.py`). FastAPI, pydantic and httpx, none of which is on the approved list — replaced with `requests`, standard-library dataclasses and `python-dotenv`. pytest replaced with `unittest`. |
| **Tracker** | The adapter that turns assessments into the grid, `SYNC_SOURCE`, the per-environment design | The HTTP client that called CHA. Replaced by an endpoint that receives the file and a table that stores it. |

Tracker settings: `CHA_ASSESSMENT_URL` and `CHA_ASSESSMENT_TIMEOUT_MS` retire,
since the tracker no longer calls out. `CHA_ASSESSMENT_TOKEN` stays, but changes
role: it becomes the token the tracker checks when CHA delivers a file, rather
than one it presents when calling CHA.

---

## Build phases

Each phase ends at a checkpoint before the next starts.

1. **CHA script, SOAR only.** Rework the existing SOAR code into a command-line
   script using only the approved packages. Writes the file to `OUTPUT_DIR`;
   POSTs to `DELIVERY_URL` when set.
   *Built.* *Checkpoint:* runs at CHA against live REDCap; the file is
   reviewed by CHA.

2. **Tracker receives and uses the file.** Ingest endpoint, storage table,
   strict validation, the SOAR sync reading the newest file on the Engagement
   Tracker Workspace, file age on every preview, the finalization warning.
   *Built.* *Checkpoint:* a SOAR preview renders on the Engagement Tracker
   Workspace from a delivered file.

3. **SOAR parity.** Compare SOAR previews from My Workspace (direct REDCap)
   and the Engagement Tracker Workspace (CHA file) for the same program year,
   hospital by hospital and month by month. Resolve every disagreement.
   *Checkpoint:* they agree.

4. **NEST, then SPARK**, each through the same parity check.

5. **TtT**, last — three projects, the logging API, the Dyadic differences.

6. **Alerting** — the staleness job and its recipient, once decided.

7. **Cutover.** The Engagement Tracker Workspace becomes production; My
   Workspace's REDCap tokens are removed.

---

## Open questions

1. **Delivery** — outbound POST to the tracker, or a different shared location?
2. **Alerts** — recipient, and whether to run the proactive check.
3. **TtT logging right** — can CHA grant the *Logging* user right on the TtT
   hospital-project token?
4. **CHoSEN Dyadic instance** — the same REDCap instance as CPCQC's projects,
   or a different one? And Denver Health's data access group name there.
5. **Retention** — how long CHA keeps nightly files, and how long the tracker
   keeps received ones.
6. **Rollover window** — how long the previous program year is computed.
7. **Run time** — a specific time after midnight Mountain that suits CHA's
   systems.
8. **Hospital identifiers** — the UCHealth Memorial campus split needs
   identifiers CHA's master list does not currently contain.
9. **Readiness assessment** — annual rather than monthly; whether it moves too.
10. **Crosswalks** — the SOAR crosswalk covers 16 data access groups; CHA's
    methodology describes 37 hospitals in that project. Each program needs a
    complete crosswalk.
11. **The year of a SOAR zero-case attestation** — needs an answer before
    January. The No-NTSV form records a month but no year, so the year is
    taken from the program year being assessed; the tracker does the same
    today. In January and February the script assesses two program years,
    so each attestation is counted in both: one entered in August 2026 for
    July appears as a July 2026 submission and as a July 2027 one, and 2027
    months would show as submitted before they have begun. How does CHA's own
    pipeline assign the year? A proposed rule: an attestation belongs to the
    most recent occurrence of its month on or before the date it was entered.
    Whatever is chosen, the script and the tracker change together, so parity
    holds.

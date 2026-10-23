# CPCQC Engagement Assessment

A nightly script that reads REDCap and produces one file containing, for every
program, hospital and period: whether data was submitted, whether it was
complete, and when it arrived. The CPCQC Engagement Tracker builds its sync
previews from that file.

- **Plan, decisions and open questions:** `docs/partition-plan.md`
- **File format:** `docs/cha-sync-contract.md` — this script implements **v2**

**Status:** all four programs — SOAR, NEST, SPARK and TtT — are implemented.
Each program moves over once it has been shown to agree with the tracker's
current results.

---

## Requirements

Only packages already approved on CHA systems:

| Package | Version |
|---|---|
| Python | 3.13.5 |
| requests | 2.32.3 |
| python-dotenv | 1.1.0 |

`requests` brings its usual dependencies (`certifi`, `charset-normalizer`,
`idna`, `urllib3`). Nothing else is installed. pandas 2.2.3 is also approved
but is not used: the rules are kept in plain Python so they read one-for-one
against the tracker's own implementation, which keeps the parity comparison
easy to reason about.

Tests use the standard library's `unittest`, so running them needs nothing
further.

---

## What it does and does not do

**Does:** read REDCap for each configured program, apply that program's
required-field rules, aggregate per hospital per period, and write a file of
counts, completeness verdicts and the fields left blank. Optionally deliver the
file to the tracker.

**Does not:** decide whether a submission was on time. Deadlines are CPCQC
policy and stay in the tracker. The script reports **when** data arrived and
never judges it, so it needs no knowledge of CPCQC's deadline calendar.

**Never writes:** record identifiers, dates of birth or delivery, ages, race,
ethnicity, language, payor, or free text from any record. Records read from
REDCap stay in memory; the output file is the only file the script writes.

---

## Running it

```bash
python3.13 -m venv .venv
./.venv/bin/pip install -r requirements.txt
cp .env.example .env        # then fill in OUTPUT_DIR and the tokens
./.venv/bin/python run_assessment.py
```

Tests:

```bash
./.venv/bin/python -m unittest discover tests
```

### Scheduling

Run once a night **after midnight Mountain time**. The tracker relies on a file
produced the day after a deadline including everything submitted on the
deadline day — it matters because finalizing a month in the tracker locks it.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Every program succeeded, and delivery succeeded if configured |
| `1` | At least one program failed, or delivery failed — the file was still written. Or the file could not be written, in which case nothing was delivered. |
| `2` | Configuration error — nothing was run |

A scheduler configured to alert on a non-zero exit will catch REDCap failures,
delivery failures and configuration mistakes. It cannot catch the script not
running at all; the tracker shows every file's age for that reason.

### What it logs

To standard error: the programs and years in scope, each program's outcome
with counts, its warnings, where the file was written, and the delivery
outcome. Never a token, never record content. Unexpected errors are logged by
type and code location only, because a Python error message can quote the
value that caused it.

---

## Configuration

All settings come from the environment, or from a `.env` file beside
`run_assessment.py`. A value already set in the environment takes precedence
over the file. REDCap tokens are secrets and must never be committed.

Every problem is reported at once, and the script exits with code `2` without
contacting REDCap.

### Output and delivery — CHA's choice

| Variable | Required | Meaning |
|---|---|---|
| `OUTPUT_DIR` | **yes** | Where each night's file is written. Local disk or a mounted network share. CHA's retained copy. **Must already exist** — the script does not create it, so an unmounted share is an error rather than an empty local folder. |
| `DELIVERY_URL` | no | If set, the file is also POSTed here. If unset, nothing leaves CHA. Must be `https://` (`http://localhost` is accepted, for testing). |
| `DELIVERY_TOKEN` | if `DELIVERY_URL` is set | Shared secret presented as `Authorization: Bearer <token>`. Agreed with CPCQC. |

Both delivery values are supplied by CPCQC.

### REDCap

| Variable | Program | Notes |
|---|---|---|
| `REDCAP_API_URL` | all | Defaults to `https://redcap.vumc.org/api/`. Must be `https://`. |
| `REDCAP_SOAR_TOKEN` | SOAR | Needs the Export right — the script reads records and the data dictionary |
| `REDCAP_NEST_TOKEN` | NEST | Needs the Export right |
| `REDCAP_SPARK_TOKEN` | SPARK | Needs the Export right |
| `REDCAP_TTT_HOSPITAL_TOKEN` | TtT | Needs the **Logging** user right as well as Export — see below |
| `REDCAP_TTT_PATIENT_TOKEN` | TtT | Needs the Export right |
| `REDCAP_TTT_DYADIC_TOKEN` | TtT | CHoSEN Dyadic project, for Denver Health's patient forms. Needs the Export right |
| `REDCAP_TTT_DYADIC_API_URL` | TtT | Only if the Dyadic project is on a different REDCap instance. Must be `https://` |
| `REDCAP_TIMEOUT` | all | Seconds per REDCap call, 1–3600. Defaults to 90 |

A token is checked for shape — 32 hexadecimal characters — but never echoed,
not even in an error message. TtT runs only when all three of its tokens are
set; until then none of them is held.

Denver Health's data access group in the Dyadic project, `denver_health_medi`,
is in `crosswalk.ttt.json` (`dyadic_dag`) with every other group mapping.

### Scope

| Variable | Default | Meaning |
|---|---|---|
| `PROGRAMS` | every implemented program whose token is set | Comma-separated, e.g. `SOAR`. Naming a program that is not implemented yet, or whose token is not set, is a configuration error. |
| `PROGRAM_YEARS` | the current year, plus the previous one in January and February | Comma-separated, e.g. `2025,2026`. A year that has not started is refused. |

With `PROGRAMS` unset, a program whose token is missing is skipped with a
warning in the log rather than failing the run.

---

## Output

One file per run in `OUTPUT_DIR`:

```
engagement-assessment-20261020T070512Z.json
```

The timestamp is the file's `generated_at`: the moment **before** the script's
first REDCap read, so everything submitted before it is in the file.

The file is written as `.engagement-assessment-….json.partial` and renamed
once complete, so anything watching the directory never sees a half-written
file. An existing file is never overwritten.

Each program and program year is a separate entry with its own status, so one
program failing does not withhold the others. Format: `docs/cha-sync-contract.md`.

Retention of these files is CHA's decision.

### Delivery

When `DELIVERY_URL` is set, the file's exact bytes are POSTed there. A server
error or no response is retried twice, after 30 seconds and then 2 minutes. A
refusal (`400`), a rejected token (`401`/`403`) or a redirect is not retried —
the log says why. Redirects are never followed. The tracker stores a file once
however many times it arrives, so a retry or a hand-started run is always safe.

---

## Crosswalks

Each program has an `app/crosswalk.<program>.json` mapping REDCap data access
group to CHA ID:

```json
{
  "some_dag":  { "cha_id": "EX-001", "hospital": "Some Hospital" },
  "other_dag": { "cha_id": "EX-002", "hospital": "Other Hospital", "tracked": false }
}
```

`hospital` is for human readability only; `cha_id` is the join key. Two data
access groups mapping to one CHA ID is refused, since it would merge their
data.

`"tracked": false` marks a hospital that is known but not tracked for that
program. Its rows are skipped without a warning. When a hospital joins the
active cohort, remove `"tracked": false`.

A data access group with data but **no** crosswalk entry is reported in that
run's `warnings` and its rows are skipped — deliberately loud, because
silently dropping a hospital would read as that hospital not submitting.

`crosswalk.soar.json` is complete: the 16 hospitals in SOAR's active cohort are
tracked, and the other 21 in the project — sustainability-track and not
enrolled, per CHA's master hospital list — are known but not tracked.

`crosswalk.spark.json` lists SPARK's 11 active hospitals, and the 3 in the
project that are not enrolled — Longmont United, St. Elizabeth and Parkview —
as known but not tracked.

`crosswalk.nest.json` lists the 9 hospitals in NEST's active cohort, with CHA
IDs from the tracker's hospital records. The first live NEST run will list any
other data access group in the project in its warnings; add those as
`"tracked": false`.

### TtT's crosswalk

TtT's projects spell some hospitals' groups differently — Littleton is
`advent_health_litt` in the hospital project and `littleton_adventis` in the
patient project — so `crosswalk.ttt.json` is keyed by hospital, with each
project's groups:

```json
{
  "hospitals": [
    { "cha_id": "EX-001", "hospital": "Some Hospital",
      "hospital_dag": "some_hosp", "patient_dags": ["some_hospital_pt"] },
    { "cha_id": "EX-002", "hospital": "Other Hospital",
      "hospital_dag": "other", "patient_dags": ["other"], "dyadic_dag": "other_dyad" }
  ],
  "not_hospitals": ["another_collaborative", "test"]
}
```

- `hospital_dag` is the group in the hospital project, or `null` if there is
  none. `patient_dags` lists the groups in the patient project — two for CHA ID
  632, which covers UCHealth Memorial Central and North through 2026.
- `dyadic_dag` names the group in the CHoSEN Dyadic project, for a hospital
  that enters its patient forms there: Denver Health.
- `not_hospitals` lists groups in the shared projects that are not TtT
  hospitals — other collaboratives, REDCap's test group — so they are skipped
  without a warning.
- Every listed hospital is assessed; which are in this year's cohort is the
  tracker's decision. A group listed for two hospitals, a CHA ID listed twice,
  or a key the file does not define is refused.

The file lists the 30 hospitals with a CHA ID that appear in either project,
from CPCQC's TtT crosswalk.

---

## Programs

| Program | Status | Projects |
|---|---|---|
| SOAR | implemented | SOAR |
| NEST | implemented | NEST |
| SPARK | implemented | SPARK |
| TtT | implemented | Hospital, Patient, CHoSEN Dyadic |

### SOAR

- **Submitted:** at least one NTSV case in the month, or a zero-case
  attestation. A case's month comes from its delivery date. An attestation's
  month **and year** come from its `month_year_nontsv` code — see below.
- **Complete:** every NTSV case passes the required-field rules, including the
  branching on admission reason and primary indication. An attestation decides
  only a month with no cases.
- **Earliest submission date:** the earliest `date` (REDCap `@TODAY`) across
  the month's records. A value that is not a real calendar date is ignored.
- **Notes**, as counts, never values: NTSV cases whose delivery date is after
  the run date, and records whose submission date is not a valid date.

**Attestation codes carry the year.** In the SOAR data dictionary,
`month_year_nontsv` codes 1–12 are January–December 2026, and 2027 continues at
13. The script reads each code's month and year from the dictionary's labels,
so codes added later need no change here. Three safeguards:

- Every label must follow that pattern — code 13 must say January 2027. A
  dictionary that breaks it, such as 1–12 relabelled as 2027, fails SOAR as a
  `configuration` error rather than move a year's attestations into the wrong
  year.
- An attestation whose code the dictionary does not define is not counted, and
  the run's warnings say how many, per data access group.
- The data dictionary is required. If it cannot be read, SOAR fails as
  `redcap_unavailable`.

### NEST

- **Two forms per hospital-month**, one row per infant or chart: the Safe
  Sleep Practices audit (`safe_sleep_audit`) and the chart review
  (`chart_reviews`). Each assessment reports both forms' row counts in
  `forms`.
- **Submitted:** at least one row on either form. **Complete:** both forms
  submitted and every row of both passes the required-field rules — a
  non-compliant audit needs its reasons and whether it was addressed; a chart
  needs race, ethnicity, language, payor and the three safe-sleep
  documentation fields, plus home needs when screening was documented and a
  referral when home needs were.
- **The month comes from the REDCap event** (`march_2026_arm_1` is
  `2026-03`). The 2026 events are listed in `app/programs/nest.py`. An event
  carrying data on either form that is not listed is reported in the run's
  warnings and its rows are skipped — never guessed. **When the 2027 monthly
  events are created, their names are added here and in the tracker
  together.**
- **Earliest submission date:** the earliest data-entry date across both
  forms (`data_entry_date_ssp`, `data_entry_date`). An unusable value is
  ignored and counted in `notes`.
- Race, ethnicity, language and payor are retrieved only to test that they
  are filled in; their free-text companions are never requested.

### SPARK

- **Quarterly, aggregate counts** on the `quarterly_measures` form — not
  patient-level data. Only the 74 data fields and the submission date are
  requested.
- **The quarter comes from the REDCap event**: confirmed event names, then the
  month-range pattern for future quarters (`janmar_27_data_arm_1` is
  `2027-Q1`; Q2 is accepted spelled `aprjune` or `aprjun`). A `*_data*` event
  that carries data but cannot be read as a quarter is reported in the run's
  warnings and skipped.
- **One record per hospital-quarter is the submission**: the latest with a
  date entered; with none dated, the most complete, then the highest
  denominator total. `records.total` says how many records competed; which one
  was used stays in REDCap.
- **Complete:** all 56 always-required fields filled, plus the 18 IPV fields
  when IPV screening is implemented (`ipv_screen_implemented` = 1).
  `fields_required` (56 or 74) lets the tracker show percent-complete.
- **Submission date:** the `date` field of the record used. A value that is not
  a real calendar date is ignored and noted.

### TtT spans three REDCap projects

| | Hospital project | Patient project | CHoSEN Dyadic |
|---|---|---|---|
| Form | `co_aim_sud_learning_collaborative_monthly_hospital` | `co_aim_sud_quantitative_patientlevel_data` | `chosen_sud_maternal` |
| Hospitals | all TtT | all except Denver Health | Denver Health only |
| Eligibility field | — | `sample_check_patient` | `sample_check_mat` |
| Qualifying substance codes | — | 1, 2, 4, 5, 6, 8, 9 | 1–6 |

- **Do not unify the substance-code lists.** The checkbox is named
  `substances_used_2___N` in both projects but the codes mean different things;
  in Dyadic, 7 is alcohol, 8 nicotine and 9 cannabis, all excluded.
- **Dyadic is shared with other collaboratives** — only Denver Health's data
  access group is used; other groups' rows are dropped as they are read.
- **Dyadic's record-ID field may not be named `record_id`**, so it is not
  requested by name.
- **Submission dates come from REDCap's logging API** — the earliest
  "Create Record" entry per record on the hospital project, read from January 1
  of the earliest year assessed. The hospital-project token needs the
  *Logging* user right as well as Export, granted by the REDCap project
  administrator. If the log is unavailable, the run's warnings say so and
  every submission date is unknown, rather than TtT failing.
- **Required fields come from the live data dictionary** — fields marked
  required on the monthly hospital form, excluding `@HIDDEN` fields and
  `tot_anx_scrnd`. Only those, the reporting month and the positive-screen
  count are requested. A dictionary with no required field fails TtT as a
  `configuration` error.

How a TtT month is assessed:

- **The month comes from `month_reporting`**, a code counted from January 2025
  = 1, so January 2026 is 13.
- **Complete:** any of the month's reports passes the required-field check —
  CHA's rule. `records` counts the month's reports; more than one is noted,
  since their positive screens are added together.
- **Patient forms are only counted.** Each patient-level row is reduced to its
  group, the month of its delivery date and whether it is eligible as soon as
  it is read; nothing else is kept. Eligible means a qualifying substance is
  checked and the form is not marked ineligible (`2`) — CPCQC's "derived"
  rule, which counts real forms whose eligibility field was left blank.
- **Linkage**, in `linkage`: positive screens against eligible patient forms.
  The floor — at least one form when there are positives — is pass/fail at the
  tracker; the ideal, one form per positive, is reported and never blocks.
- **A month with patient forms but no report** is still listed, as not
  submitted, so the tracker sees every month with data.
- **Warnings**, as counts per hospital: reports with data but no reporting
  month, and eligible patient forms with no valid delivery date, since neither
  can be placed in a month. **Notes** per month: several reports entered, a
  positive-screen count that is not a whole number, a report with no creation
  entry in the log.
- **If any of the three projects cannot be read, TtT fails** as
  `redcap_unavailable`, naming the project. Linkage without the Dyadic forms
  would read as Denver Health missing its patient forms. The log is the one
  exception, above.

---

## How the rules are implemented

Each program's rules are ported from the tracker's implementation, which in
turn follows CHA's methodology documents. Where a port disagrees with CHA's
own pipeline, **CHA's pipeline is the reference for the rules** and the tracker
is the reference for the output shape. Disagreements are resolved explicitly
rather than worked around.

One known difference, by design: a submission date with an impossible day
(`2026-02-30`) is ignored here, where the tracker's date parser rolls it over
into March. `@TODAY` cannot produce such a value.

### Minimum necessary

Each program lists exactly the fields its rules read (`MINIMUM_FIELDS`).
REDCap exports name those fields and send **no `forms` parameter** — REDCap
returns the union of named fields and every field on a named form, so sending
both restricts nothing. If a required field is added to a program's rules, add
it to that program's field list too, or it will read as permanently blank; a
test checks the two agree.

### Layout

| | |
|---|---|
| `run_assessment.py` | Entry point |
| `app/config.py` | Settings, validated together |
| `app/redcap.py` | REDCap API client |
| `app/programs/` | One module per program; `__init__.py` describes the interface |
| `app/runner.py` | Runs each program and year; one failing does not stop the others |
| `app/models.py` | The file's shapes, serialised key by key |
| `app/output.py` | Writes the file |
| `app/delivery.py` | Delivers it |
| `tests/` | Synthetic records only |

---

## Before a program moves over: parity

For each program, the tracker compares previews built from this script's file
with previews from its own direct-REDCap implementation, for the same program
year, hospital by hospital and period by period. A program moves over only
once they agree.

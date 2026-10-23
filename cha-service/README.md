# CPCQC Engagement Assessment

A nightly script that reads REDCap and produces one file containing, for every
program, hospital and period: whether data was submitted, whether it was
complete, and when it arrived. The CPCQC Engagement Tracker builds its sync
previews from that file.

- **Plan, decisions and open questions:** `docs/partition-plan.md`
- **File format:** `docs/cha-sync-contract.md` — this script implements **v2**

**Status:** SOAR and NEST are implemented. SPARK and TtT follow. Each program
moves over once it has been shown to agree with the tracker's current results.

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
| `REDCAP_SPARK_TOKEN` | SPARK | Not yet used |
| `REDCAP_TTT_HOSPITAL_TOKEN` | TtT | Not yet used. Will need the **Logging** user right as well as Export — see below |
| `REDCAP_TTT_PATIENT_TOKEN` | TtT | Not yet used |
| `REDCAP_TTT_DYADIC_TOKEN` | TtT | Not yet used. CHoSEN Dyadic project, Denver Health only |
| `REDCAP_TTT_DYADIC_API_URL` | TtT | Only if the Dyadic project is on a different REDCap instance |
| `REDCAP_TTT_DYADIC_DH_DAG` | TtT | Denver Health's data access group in the Dyadic project. Defaults to `denver_health_medi` |
| `REDCAP_TIMEOUT` | all | Seconds per REDCap call, 1–3600. Defaults to 90 |

A token is checked for shape — 32 hexadecimal characters — but never echoed,
not even in an error message.

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

`crosswalk.nest.json` lists the 9 hospitals in NEST's active cohort, with CHA
IDs from the tracker's hospital records. The first live NEST run will list any
other data access group in the project in its warnings; add those as
`"tracked": false`.

---

## Programs

| Program | Status | Projects |
|---|---|---|
| SOAR | implemented | SOAR |
| NEST | implemented | NEST |
| SPARK | to port | SPARK |
| TtT | to port, last | Hospital, Patient, CHoSEN Dyadic |

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
  access group is used.
- **Dyadic's record-ID field may not be named `record_id`**, so it is not
  requested by name.
- **Submission dates come from REDCap's logging API** — the earliest
  "Create Record" entry per record on the hospital project. The hospital-project
  token needs the *Logging* user right as well as Export, granted by the REDCap
  project administrator. If the log is unavailable, timeliness for that run is
  reported as unknown rather than failing TtT.
- **Required fields come from the live data dictionary** — fields marked
  required on the monthly hospital form, excluding `@HIDDEN` fields and
  `tot_anx_scrnd`.

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

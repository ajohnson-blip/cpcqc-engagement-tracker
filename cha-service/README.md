# CPCQC Engagement Assessment

A nightly script that reads REDCap and produces one file containing, for every
program, hospital and period: whether data was submitted, whether it was
complete, and when it arrived. The CPCQC Engagement Tracker builds its sync
previews from that file.

- **Plan, decisions and open questions:** `docs/partition-plan.md`
- **File format:** `docs/cha-sync-contract.md` — this script implements **v2**

> **Status: planned.** This directory currently holds an earlier prototype
> written as a web service. It is being reworked into the nightly script
> described here. The SOAR rules (`app/programs/soar.py`), the REDCap client's
> logic, the crosswalk and the test cases carry over; the web service itself
> (`app/main.py`, `app/auth.py`) does not. `.env.example` also still reflects
> the prototype and will be replaced. Sections below describe the script as it
> will be once reworked.

---

## Requirements

Only packages already approved on CHA systems:

| Package | Version |
|---|---|
| Python | 3.13.5 |
| pandas | 2.2.3 |
| requests | 2.32.3 |
| python-dotenv | 1.1.0 |

Nothing else. Tests use the standard library's `unittest`, so running them
needs no further installation.

pandas is available but not required by the rules. The reference
implementation keeps the rules in plain Python so they read one-for-one against
the tracker's own implementation, which makes the parity comparison easier to
reason about.

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

## Configuration

All settings come from the environment, or from a `.env` file beside the
script. REDCap tokens are secrets and must never be committed.

### Output and delivery — CHA's choice

| Variable | Required | Meaning |
|---|---|---|
| `OUTPUT_DIR` | **yes** | Where each night's file is written. Local disk or a mounted network share. CHA's retained copy. |
| `DELIVERY_URL` | no | If set, the file is also POSTed here. If unset, nothing leaves CHA. |
| `DELIVERY_TOKEN` | if `DELIVERY_URL` is set | Shared secret presented as `Authorization: Bearer <token>`. Agreed with CPCQC. |

### REDCap

| Variable | Program | Notes |
|---|---|---|
| `REDCAP_API_URL` | all | Defaults to `https://redcap.vumc.org/api/` |
| `REDCAP_SPARK_TOKEN` | SPARK | |
| `REDCAP_NEST_TOKEN` | NEST | |
| `REDCAP_SOAR_TOKEN` | SOAR | |
| `REDCAP_TTT_HOSPITAL_TOKEN` | TtT | Needs the **Logging** user right as well as export — see below |
| `REDCAP_TTT_PATIENT_TOKEN` | TtT | |
| `REDCAP_TTT_DYADIC_TOKEN` | TtT | CHoSEN Dyadic project, Denver Health only |
| `REDCAP_TTT_DYADIC_API_URL` | TtT | Only if the Dyadic project is on a different REDCap instance |
| `REDCAP_TTT_DYADIC_DH_DAG` | TtT | Denver Health's data access group in the Dyadic project. Defaults to `denver_health` |
| `REDCAP_TIMEOUT` | all | Seconds per REDCap call. Defaults to 90 |

### Scope

| Variable | Default | Meaning |
|---|---|---|
| `PROGRAMS` | all implemented | Comma-separated subset, e.g. `SOAR,NEST` |
| `PROGRAM_YEARS` | current, plus previous in Jan–Feb | Comma-separated override, e.g. `2026,2027` |

A program whose token is not configured is skipped with a warning rather than
failing the run.

---

## Running it

```bash
python3.13 -m venv .venv
./.venv/bin/pip install pandas==2.2.3 requests==2.32.3 python-dotenv==1.1.0
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
| `1` | At least one program failed, or delivery failed. The file was still written. |
| `2` | Configuration error — nothing was run |

A scheduler configured to alert on a non-zero exit will catch REDCap failures,
delivery failures and configuration mistakes. It cannot catch the script not
running at all; the tracker checks for that separately.

---

## Output

One file per run in `OUTPUT_DIR`:

```
engagement-assessment-20261020T080512Z.json
```

Each program and program year is a separate entry with its own status, so one
program failing does not withhold the others. Format: `docs/cha-sync-contract.md`.

Retention of these files is CHA's decision.

---

## Crosswalks

Each program has a `crosswalk.<program>.json` mapping REDCap data access group
to CHA ID:

```json
{
  "some_dag": { "cha_id": "428", "hospital": "Some Hospital" }
}
```

`hospital` is for human readability only; `cha_id` is the join key.

A data access group with data but no crosswalk entry is reported in that run's
`warnings` and its rows are skipped — deliberately loud, because silently
dropping a hospital would read as that hospital not submitting.

`crosswalk.soar.json` was generated from the tracker's hospital records and all
16 entries resolved to a CHA ID. **It needs extending:** CHA's SOAR methodology
describes 37 hospitals in that project, while the tracker's map covers the 2026
active cohort. The first run against live REDCap will list every missing data
access group in its warnings.

---

## Programs

| Program | Status | Projects |
|---|---|---|
| SOAR | rules written; rework to script pending | SOAR |
| NEST | to port | NEST |
| SPARK | to port | SPARK |
| TtT | to port, last | Hospital, Patient, CHoSEN Dyadic |

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
  token needs the *Logging* user right. If the log is unavailable, timeliness
  for that run is reported as unknown rather than failing TtT.
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

### Minimum necessary

Each program lists exactly the fields its rules read. REDCap exports name those
fields and send **no `forms` parameter** — REDCap returns the union of named
fields and every field on a named form, so sending both restricts nothing. If a
required field is added to a program's rules, add it to that program's field
list too, or it will read as permanently blank.

---

## Before a program moves over: parity

For each program, the tracker compares previews built from this script's file
with previews from its own direct-REDCap implementation, for the same program
year, hospital by hospital and period by period. A program moves over only
once they agree.

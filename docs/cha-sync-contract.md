# Engagement assessment — file contract

**Status:** for review by Luis Montes (CHA) and CPCQC. All four programs —
SOAR, NEST, SPARK and TtT — are implemented on both sides.
**Version:** `v2`
**Date:** 22 October 2026

See `docs/partition-plan.md` for the overall plan, decisions and open questions.

## Changes from v1

v1 described an on-demand service the tracker called when a program manager
ran a sync. v2 replaces it with a script CHA runs nightly, which writes one
file containing assessments for every program.

- **Transport:** a file, written to a location CHA chooses, optionally POSTed
  to the tracker — no longer a request and response.
- **Scope per run:** every program and every program year in scope, in one
  file — no longer one program per request.
- **Failure:** each program carries its own status, so one program failing
  does not withhold the others.
- **Unchanged:** the division of responsibility, the assessment fields, the
  grouping of missing fields, and every constraint on what the output may
  contain.

## Purpose

This contract partitions REDCap queries onto a script operated by CHA. The
tracker receives only an assessment per hospital per period.

## Where the boundary sits

A sync row in the tracker has three layers. Only the first moves.

| Layer | Example | Lives where |
|---|---|---|
| **Facts from REDCap** | did they submit, are required fields filled, how many rows, earliest submission date | **CHA's script** |
| **CPCQC policy** | the deadline for this period, on-time vs late, which disposition that implies | **Tracker** |
| **Task state** | the task being updated, prior overrides, finalization, what will change | **Tracker** |

### Why deadlines stay in the tracker

Deadlines are CPCQC policy, not REDCap facts. They live on the tracker's task
records, they vary by program, and they have been changed by CPCQC decision
during a program year. The script therefore reports **when** data was
submitted and never judges whether that was on time. CHA does not need to
track CPCQC's deadline calendar.

## Schedule

- **Nightly, after midnight Mountain time.** A file produced the day after a
  deadline must include everything submitted on the deadline day; the tracker
  relies on this when a month is finalized.
- **Program years in scope:** the current program year, plus the previous one
  for part of the new year, since December's data arrives in January. The
  window is configurable.
- A run may also be started by hand. A hand-started run produces the same file
  as a scheduled one.

## The file

One JSON file per run, UTF-8. The example below is illustrative; every
identifier and figure in it is fictional.

```json
{
  "format_version": "v2",
  "snapshot_id": "8f2c1e4a-6b3d-4c9e-a1f7-2d5b8e0c9a31",
  "generated_at": "2026-10-20T08:05:12Z",
  "generator": { "name": "cpcqc-engagement-assessment", "version": "0.2.0" },
  "runs": [
    {
      "program": "SOAR",
      "program_year": 2026,
      "status": "ok",
      "methodology_version": "soar-2026.10",
      "source": { "records_read": 5028, "redcap_project": "CPCQC SOAR NTSV" },
      "assessments": [
        {
          "cha_id": "EX-001",
          "period": "2026-07",
          "submitted": true,
          "complete": false,
          "earliest_submission_date": "2026-08-14",
          "records": { "total": 12, "complete": 1, "attestation": 0 },
          "attestation_only": false,
          "missing_field_groups": [
            {
              "form": "ntsv_cesarean_section",
              "records": 11,
              "fields": [
                { "field": "checklist_comms_tool", "label": "Checklist/communication tool used" }
              ]
            }
          ],
          "notes": []
        }
      ],
      "warnings": [
        "REDCap DAG \"new_hospital_x\" has SOAR data but is not in the crosswalk; its rows were skipped."
      ]
    },
    {
      "program": "TTT",
      "program_year": 2026,
      "status": "error",
      "error": { "code": "redcap_unavailable", "message": "REDCap timed out after 90s" }
    }
  ]
}
```

### Envelope

| Field | Type | Meaning |
|---|---|---|
| `format_version` | string | `"v2"`. The tracker refuses a version it does not implement. |
| `snapshot_id` | string | A UUID the script generates per run. Makes delivery idempotent — the same snapshot delivered twice is stored once. |
| `generated_at` | string | UTC, ISO 8601, to the second — `2026-10-20T07:05:12Z`. Taken **before** the script's first REDCap read, so everything submitted before this moment is in the file. Shown on every tracker preview built from this file. |
| `generator` | object | Script name and version, so a file can be traced to the code that produced it. |
| `runs` | array | One entry per program per program year. |

### Runs

| Field | Type | Present when | Meaning |
|---|---|---|---|
| `program` | string | always | `SPARK` \| `NEST` \| `SOAR` \| `TTT` |
| `program_year` | integer | always | e.g. `2026` |
| `status` | string | always | `ok` or `error` |
| `methodology_version` | string | `ok` | Identifies the ruleset. Changes whenever required fields, eligibility criteria or thresholds change. |
| `source` | object | `ok` | `records_read` and `redcap_project`, so a figure can be reconciled with REDCap. |
| `assessments` | array | `ok` | One per hospital per period. |
| `warnings` | string[] | `ok` | Problems that did not stop the run, such as an unrecognised data access group. |
| `error` | object | `error` | `code` and `message`. No partial assessments accompany an error. |

**A run either succeeds completely or reports an error.** Partial assessments
are never sent: a program that silently omitted hospitals would read as those
hospitals not having submitted.

Error codes:

- `redcap_unavailable` — REDCap could not be reached or refused a request.
- `configuration` — the script's settings or crosswalk, or a REDCap project
  set up in a way the rules cannot rely on, such as a data dictionary label
  that breaks a code pattern.
- `internal` — a defect in the script.

### Assessment fields

| Field | Type | Meaning |
|---|---|---|
| `cha_id` | string | Hospital identifier. A string, not an integer — see the plan's open questions. |
| `period` | string | `YYYY-MM` or `YYYY-Qn`, matching the program's cadence. |
| `submitted` | bool | Any qualifying submission exists for this hospital-period. |
| `complete` | bool | Every submitted record passes the program's required-field rules. |
| `earliest_submission_date` | string \| null | The data-entry date timeliness is judged by, `YYYY-MM-DD`: for SOAR and NEST the earliest across the period's records; for SPARK that of the record taken as the submission (see "SPARK additions"). Null when REDCap captured none; the tracker then reports timeliness as unknown. **Never a clinical date.** |
| `records.total` | int | Records in scope for this hospital-period. |
| `records.complete` | int | Records passing row-level completeness. |
| `records.attestation` | int | Zero-case attestations (SOAR). |
| `attestation_only` | bool | The only submission is a valid zero-case attestation. |
| `missing_field_groups` | array | Distinct patterns of missing required fields — see below. Field **names and labels only**, never values. |
| `forms` | array | NEST only — see below. |
| `fields_required` | int | SPARK only — see below. |
| `linkage` | object | TtT only — see below. |
| `notes` | string[] | Per-hospital diagnostics, as counts. For SOAR: NTSV cases whose delivery date is after the run date, and records whose submission date is not a valid date. For NEST: records whose data-entry date is not a valid date. For TtT: see "TtT additions". Never the values themselves. |

Every field above is present in every assessment, except `forms`, which
appears on NEST assessments only, `fields_required`, on SPARK assessments
only, and `linkage`, on TtT assessments only — each required on its own
program's assessments.
`earliest_submission_date` may be `null`; nothing else may.

### Why `missing_field_groups` is grouped, not a flat list

Group by instrument plus the exact set of fields missing, and report how many
records share each pattern. Do not return one entry per field, and do not
return one entry per record.

The reason is a distinction program managers rely on. One record missing eight
fields is an abandoned entry — somebody started a form and walked away. Eight
records each missing the same one field is a systematic gap — the hospital
does not know that field is required, or their workflow never captures it.
Those are different conversations, and a flat per-field tally cannot tell them
apart, because both produce the same totals.

Grouping preserves it without identifying any record:

```
1 group · 1 record  · 8 fields   → an abandoned entry
1 group · 8 records · 1 field    → a systematic gap
```

Order groups by field count descending, then by record count descending.

**Labels come from REDCap's own data dictionary** (`field_label`, with any HTML
stripped). If the dictionary cannot be read, use the variable name as the label
rather than failing the run.

### NEST additions

A NEST month is complete only when both of its forms were submitted and every
row of both passes, and the tracker reports which form is missing when only
one arrived. Each NEST assessment therefore lists both forms, by REDCap
instrument name, with each one's rows:

```json
"forms": [
  { "form": "safe_sleep_audit", "total": 4, "complete": 4 },
  { "form": "chart_reviews", "total": 0, "complete": 0 }
]
```

`records.total` and `records.complete` are the sums across the two forms;
`records.attestation` is `0`. A NEST month's reporting period comes from its
REDCap event (`march_2026_arm_1` is `2026-03`).

### SPARK additions

SPARK records are a hospital's aggregate counts for a quarter, not
patient-level rows, and a hospital may enter more than one record for the same
quarter. One is taken as the submission: the latest with a date entered, or,
when none has a date, the most complete (then the highest denominator total) —
CHA's row-selection rule. So for SPARK:

- `period` is a quarter, `YYYY-Qn`, from the REDCap event
  (`janmar_26_data_arm_1` is `2026-Q1`).
- `submitted`, `complete`, `earliest_submission_date` and
  `missing_field_groups` describe the record taken as the submission.
- `records.total` is how many distinct records were entered for the quarter —
  more than one means competing records, which the tracker flags for a PM to
  resolve in REDCap — and `records.complete` how many of them pass.
  `records.attestation` is `0`.
- `fields_required` is how many fields the submission had to complete: 56, or
  74 when IPV screening is implemented. The tracker shows percent-complete
  from it.

```json
"records": { "total": 2, "complete": 1, "attestation": 0 },
"fields_required": 56
```

### TtT additions

TtT spans **three** REDCap projects: the hospital-level project, the
patient-level project, and the CHoSEN Dyadic project, which holds Denver
Health's patient-level forms. The linkage check compares positive SUD screens
reported on the hospital form against eligible patient forms from the patient
project — or, for Denver Health, from the Dyadic project.

```json
"linkage": {
  "positive_screens": 14,
  "patient_forms": 11,
  "shortfall": 3,
  "floor_met": false,
  "ideal_met": false
}
```

- `positive_screens` is the month's positive SUD screens from the hospital
  report, summed if more than one report was entered.
- `patient_forms` is the month's eligible patient forms — from the patient
  project, or for Denver Health from the Dyadic project — by delivery month.
  Eligible: a qualifying substance is checked and the form is not marked
  ineligible.
- `shortfall` is `positive_screens − patient_forms`, not below 0; 0 when there
  are no positives.
- `floor_met`: no positives, or at least one form. `ideal_met`: no positives,
  or at least one form per positive.

The tracker treats `floor_met: false` as making the month incomplete;
`ideal_met: false` is reported and never blocks. The counts are derived from
patient-level records, which is why they are computed by CHA. The plan sets
out how the three projects differ.

For TtT, too:

- `period` comes from the report's `month_reporting` code, counted from
  January 2025 = 1.
- `complete` describes the hospital report alone: a month is complete when
  **any** of its reports passes the required-field check (CHA's rule). The
  required fields come from the hospital project's data dictionary. The
  tracker combines `complete` with `floor_met`.
- `records.total` is the month's reports and `records.complete` how many of
  them pass; `records.attestation` is `0`.
- `earliest_submission_date` is the earliest REDCap log "create" entry among
  the month's reports, since the form has no date field. Null when the log
  could not be read — the run's `warnings` say so.
- A month with eligible patient forms but no report is listed with
  `submitted: false`, `complete: false`, zero records and its forms in
  `patient_forms`, so the tracker sees every month with data.
- `notes`: more than one report entered for the month, a positive-screen count
  that is not a whole number, a report with no creation entry in the log.
- The run's `warnings` also count, per hospital, reports with data but no
  reporting month and eligible patient forms with no valid delivery date —
  neither can be placed in a month.

## Hard constraints on the output

These are requirements, not preferences.

1. **No patient-level data.** No record identifiers, no dates of birth or
   delivery, no ages, no race, ethnicity, language or payor, no free text
   entered into any record, no identifiers of any kind from the patient or
   chart instruments.
2. **`missing_field_groups` carries field names and labels, never values.**
3. **`earliest_submission_date` is a data-entry date**, not a date of service.
   Delivery dates must not appear anywhere in the file, including in `notes`
   and `warnings`.
4. **Counts are aggregates per hospital-period.** Do not add granularity beyond
   what is specified here.
5. **Warnings and error messages must not quote record content.** Describe the
   shape of a problem, not the data that caused it.
6. **No intermediate files.** Records read from REDCap stay in memory. The only
   file the script writes is this output.

## Delivery

Delivery to the tracker is optional and entirely under CHA's control: the
script delivers only when CHA has configured a destination.

```
POST <DELIVERY_URL>
Content-Type: application/json
Authorization: Bearer <token>
```

The body is the file, unchanged. On the tracker, `DELIVERY_URL` is the
backend's `/integrations/cha/assessment-files`; CPCQC supplies the full URL and
the token.

| Response | Meaning |
|---|---|
| `200` | `{"status": "stored", "snapshot_id": …}`, or `"already_stored"` when this `snapshot_id` arrived before with the same content. Safe to retry. |
| `400` | Refused. `error.message` lists what is wrong and where — usually a field the contract does not define. Nothing from the file was stored. |
| `401` | Missing or wrong token. |
| `409` | This `snapshot_id` was already received with different content. A defect in the sender; not retried. |
| `413` | The file is larger than the tracker accepts (10 MB). |
| `503` | The tracker is not configured to receive files. |
| other `5xx` | Try again later. The script retries twice. |

A failed delivery does not affect the file already written at CHA.

## How the tracker validates

- **Strictly.** A field the contract does not define, anywhere in the file,
  causes the whole file to be refused. This is a deliberate second line of
  defence against something being included by mistake. The tracker's
  messages name where a problem is and what was expected — never the value it
  found there.
- **Consistently.** Also refused: a period that is not in the program's
  cadence or not in the run's program year; two runs for one program year, or
  two assessments for one hospital and period; more complete records than
  records; `linkage` outside TtT; `forms` outside NEST, a NEST assessment
  without an entry for each of its forms, a form NEST does not have, or more
  complete rows than rows in a form; `fields_required` outside SPARK, missing
  from a SPARK assessment, or fewer than the fields reported missing; `linkage`
  missing from a TtT assessment, or a `shortfall`, `floor_met` or `ideal_met`
  that does not follow from `positive_screens` and `patient_forms`; a
  `generated_at` later than the file's arrival.
- **Per-run status is respected.** A run with `status: "error"` is recorded and
  shown on that program's sync page; the other runs in the file are used.
- **The newest successful run wins** for each program and program year.
- **Age is always visible.** Every preview shows `generated_at`, and warns when
  the file is older than expected.

The distinction between the two kinds of failure matters. A REDCap outage is
expected and is reported as `status: "error"` for the affected program. A
schema violation means the script produced something it should not have; the
whole file is refused, because output from a script in that state should not
be trusted for any program.

## Versioning and auditability

These figures are reported to funders and to the state, so a number must be
traceable to the rules that produced it. The tracker stores `snapshot_id`,
`generated_at`, `generator.version` and each run's `methodology_version` with
every file it receives, and records which file each sync preview was built
from. Breaking changes to the file require a new `format_version`.

## Testing and parity

1. **The script carries its own tests** for every rule it implements, runnable
   with the standard library alone.
2. **Fixtures contain no patient-level data.** Test records are synthetic.
3. **Parity before cutover.** For each program, previews built from CHA's file
   are compared with previews from the tracker's current direct-REDCap
   implementation, for the same program year, hospital by hospital and period
   by period. Where they disagree, one is wrong, and that is resolved before
   the program moves over.

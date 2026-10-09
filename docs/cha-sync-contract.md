# Engagement assessment service — interface contract

**Status:** draft for review by Luis Montes (CHA) and CPCQC
**Version:** `v1` (draft)
**Date:** 9 October 2026

## Why this exists

This contract partitions REDCap queries onto a service operated by CHA. The
tracker receives only an assessment per hospital per period.

The service is referred to below as **the assessment service**. It is expected
to be implemented in Python, reusing the logic already written for
`soar_engagement_logic.py` and the SOAR/SPARK/NEST pipelines.

## Where the boundary sits

A sync row in the tracker has three layers. Only the first moves.

| Layer | Example | Lives where |
|---|---|---|
| **Facts from REDCap** | did they submit, are required fields filled, how many rows, earliest submission date | **Assessment service** |
| **CPCQC policy** | the deadline for this period, on-time vs late, which disposition that implies | **Tracker** |
| **Task state** | the task being updated, prior overrides, finalization, what will change | **Tracker** |

### Why deadlines stay in the tracker

Deadlines are CPCQC policy, not REDCap facts. They live on `task_instances.due_on`,
they vary by program and have been changed by CPCQC decision (the HRA time-2
deadline moved from 31 December to 1 December in 2026), and the comparison is
covered by the tracker's automated test suite.

The assessment service therefore returns **when** data was submitted and never
judges whether that was on time. The tracker owns that comparison. This keeps
the timeliness rules in one place, under test, and means CHA does not have to
track CPCQC's deadline calendar.

## Transport

```
POST https://<cha-host>/v1/engagement/assess
Content-Type: application/json
Authorization: Bearer <token>
```

- **HTTPS only.** The token is a shared secret held in the tracker's
  environment, rotatable without a deploy on either side.
- **Idempotent.** The call computes and returns; it writes nothing. Safe to
  retry, and the tracker will, with backoff.
- **Synchronous**, with a generous timeout. A full-year TtT assessment reads
  two REDCap projects; 120 seconds is a reasonable ceiling. If a program grows
  past that, we move to a job-and-poll pattern rather than raising the timeout.
- The tracker calls this only when a program manager runs a sync. There is no
  schedule.

## Request

```json
{
  "contract_version": "v1",
  "program": "SOAR",
  "program_year": 2026,
  "periods": ["2026-07", "2026-08"],
  "options": { "eligibility_mode": "derived" }
}
```

| Field | Required | Notes |
|---|---|---|
| `contract_version` | yes | `"v1"`. The service rejects versions it does not implement. |
| `program` | yes | `SPARK` \| `NEST` \| `SOAR` \| `TTT` |
| `program_year` | yes | e.g. `2026` |
| `periods` | no | `YYYY-MM` or `YYYY-Qn`. Omit for every period in the program year. |
| `options.eligibility_mode` | TtT only | `derived` (CPCQC's default) \| `explicit` \| `either` |

## Response

```json
{
  "contract_version": "v1",
  "program": "SOAR",
  "program_year": 2026,
  "methodology_version": "soar-2026.07",
  "computed_at": "2026-10-09T16:40:12Z",
  "source": { "records_read": 5028, "redcap_project": "CPCQC SOAR NTSV" },
  "assessments": [
    {
      "cha_id": "428",
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
    "REDCap DAG \"new_hospital_x\" has data but is not in the crosswalk; its rows were skipped."
  ]
}
```

### Assessment fields

| Field | Type | Meaning |
|---|---|---|
| `cha_id` | string | Hospital identifier. **String, not integer** — see "Open questions". |
| `period` | string | `YYYY-MM` or `YYYY-Qn`, matching the program's cadence. |
| `submitted` | bool | Any qualifying submission exists for this hospital-period. |
| `complete` | bool | Every submitted record passes that program's required-field rules. |
| `earliest_submission_date` | date \| null | Earliest entry timestamp across the period's records. `null` when no timestamp was captured — the tracker reports timeliness as N/A. **Never a clinical date.** |
| `records.total` | int | Records in scope for this hospital-period. |
| `records.complete` | int | How many passed row-level completeness. |
| `records.attestation` | int | Zero-case attestations (SOAR No-NTSV). |
| `attestation_only` | bool | The only submission is a valid zero-case attestation. |
| `missing_field_groups` | array | Distinct patterns of missing required fields — see below. Field **names and labels only**, never values. |
| `notes` | string[] | Per-hospital diagnostics, e.g. a future-dated record count. |

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

Order groups by field count descending, then by record count descending, so
the most incomplete pattern reads first.

**Labels come from REDCap's own data dictionary** (`field_label`, with any HTML
stripped), not from anything generated. If the dictionary cannot be read, send
the variable name as the label rather than failing the call.

### TtT additions

TtT spans a hospital-level project and a patient-level one, joined on CHA ID.
The linkage check compares positive SUD screens against eligible patient forms.
Those counts are derived from patient-level records and must be computed at CHA.

```json
"linkage": {
  "positive_screens": 14,
  "patient_forms": 11,
  "shortfall": 3,
  "floor_met": false,
  "ideal_met": false
}
```

The tracker treats `floor_met: false` as a hard failure, exactly as it does
today. The rule itself stays at CHA because it needs the patient-form count.

## Hard constraints on the response

These are requirements, not preferences.

1. **No patient-level data.** No record identifiers, no dates of birth or
   delivery, no ages, no race, ethnicity, language or payor, no free text
   entered into any record, no identifiers of any kind from the patient or
   chart instruments.
2. **`missing_fields` carries field names and labels, never values.** Knowing
   that `age` was blank is a completeness fact; the age itself is not ours to
   receive.
3. **`earliest_submission_date` is a data-entry timestamp**, not a date of
   service. Delivery dates must not appear anywhere in the response, including
   in `notes`.
4. **Counts are aggregates per hospital-period.** Where a count is small enough
   to be revealing on its own, it is still a count of records and not an
   attribute of a person — but the service should not add granularity beyond
   what is specified here.
5. **Warnings must not quote record content.** Describe the shape of a problem,
   not the data that caused it.

If the tracker receives a field it does not expect, it logs and ignores it. It
will never persist an unrecognised field.

## Versioning and auditability

These figures are reported to funders and to the state under SB24-175, so a
number must be traceable to the rules that produced it.

- `methodology_version` identifies the ruleset — required-field lists,
  eligibility criteria, linkage thresholds. It changes whenever those change.
- `computed_at` and `source.records_read` let a figure be reconciled against
  REDCap at a point in time.
- The tracker stores all three alongside the sync it produced.
- Breaking changes to the response shape require a new `contract_version`. The
  service supports the previous version for at least one program year.

## Errors

```json
{ "error": { "code": "redcap_unavailable", "message": "REDCap API timed out after 60s" } }
```

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `bad_request` | Unknown program, malformed period, unsupported `contract_version` |
| 401 | `unauthorized` | Missing or invalid token |
| 502 | `redcap_unavailable` | REDCap unreachable or returned an error |
| 500 | `internal` | Anything else |

**Partial results are never returned.** A sync that silently omitted hospitals
would read as non-participation. If any part of the assessment cannot be
computed, the call fails and the tracker shows the error rather than a preview.

## Testing and parity

The tracker's test suite cannot call this service, so:

1. **The service provides recorded fixtures** — real response shapes with
   synthetic content — which the tracker tests against. No PHI in fixtures.
2. **The service carries its own tests** for the rules that move to it. The
   tracker currently has automated coverage of completeness, eligibility and
   linkage; that coverage must not be lost in the move.
3. **Parity before cutover.** The tracker's existing implementation is the
   reference. For at least one full program year of historical data, both
   implementations run and their assessments are compared hospital by
   hospital, period by period. Cutover happens when they agree, and any
   disagreement is resolved explicitly — one of them is wrong, and we need to
   know which before these numbers go anywhere.

## Open questions

- **Hospital identifier.** `cha_id` is typed as a string here deliberately. The
  UCHealth Memorial campus split needs identifiers that CHA's master list does
  not currently contain, and the chosen scheme may not be numeric. The tracker's
  TtT crosswalk currently types it as an integer and will be changed.
- ~~**Per-record detail.**~~ **Settled.** Per-record detail stays in REDCap.
  The tracker no longer stores or displays record identifiers for any program,
  and the previously stored ones have been removed from both databases. The
  program-manager workflow is served by `missing_field_groups` plus a pointer
  to REDCap, where the correction is made anyway.
- **Authentication.** Bearer token is proposed for simplicity. If CHA can
  support mutual TLS or IP allowlisting, either would be stronger.
- **HRA / readiness assessment.** Not covered here. It is annual rather than
  monthly and is currently handled separately; confirm whether it moves too.

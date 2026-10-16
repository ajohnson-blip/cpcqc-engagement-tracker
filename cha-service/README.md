# CPCQC Engagement Assessment Service

A small service that reads REDCap and returns, per hospital per period, whether
data was submitted, whether it was complete, and when it arrived. The CPCQC
Engagement Tracker calls it instead of querying REDCap itself.

Interface: `docs/cha-sync-contract.md` in the tracker repository. This service
implements **contract v1**.

**Status: SOAR only.** SPARK, NEST and TtT return a 400 saying so, rather than
an empty result — an empty list would render in the tracker as every hospital
having submitted nothing.

---

## What it does and does not do

**Does:** read REDCap, apply the program's required-field rules, aggregate per
hospital-month, return counts and which fields were left blank.

**Does not:** decide whether a submission was on time. Deadlines are CPCQC
policy, they live on the tracker's task records, and they have changed by CPCQC
decision mid-year. This service returns **when** data arrived and never judges
it. You do not need to track CPCQC's deadline calendar.

**Never returns:** record identifiers, dates of birth or delivery, ages, race,
ethnicity, language, payor, or free text from any record. The response carries
counts, field names and field labels. A test asserts this
(`test_response_never_carries_a_record_identifier`); please keep it passing.

---

## Running it

Requires Python 3.10+.

```bash
python3 -m venv .venv
./.venv/bin/pip install -e ".[dev]"
cp .env.example .env     # then fill in AUTH_TOKEN and REDCAP_SOAR_TOKEN
./.venv/bin/uvicorn app.main:app --reload --port 8000
```

Check it:

```bash
curl localhost:8000/health
```

Ask it for an assessment:

```bash
curl -X POST localhost:8000/v1/engagement/assess \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"contract_version":"v1","program":"SOAR","program_year":2026}'
```

Tests:

```bash
./.venv/bin/python -m pytest tests/ -q
```

---

## Configuration

| Variable | Needed | Notes |
|---|---|---|
| `AUTH_TOKEN` | yes | Shared secret. The service refuses to start serving without it rather than running open. Give the same value to CPCQC for the tracker's environment. |
| `REDCAP_SOAR_TOKEN` | yes | The SOAR project's API token. |
| `REDCAP_API_URL` | no | Defaults to `https://redcap.vumc.org/api/`. |

Rotating `AUTH_TOKEN` needs no deploy on either side — set the new value here
and tell CPCQC to set it there.

---

## The crosswalk — please check this first

`app/crosswalk.soar.json` maps REDCap DAG → CHA ID. It was generated from the
tracker's hospital records and **all 16 entries resolved to a CHA ID**.

**It almost certainly needs extending.** Your methodology document describes 37
hospitals in the SOAR REDCap project; the tracker's map covers the 16 in the
2026 active cohort. Any DAG with data but no crosswalk entry is reported in
`warnings` and its rows are skipped — deliberately loud, because silently
dropping a hospital would read as that hospital not submitting.

Run an assessment against the live project and check `warnings`. Each one is a
DAG that needs adding:

```json
{
  "some_dag": { "cha_id": "428", "hospital": "Some Hospital" }
}
```

`hospital` is for human readability only; `cha_id` is the join key.

---

## How the rules are implemented

`app/programs/soar.py` is a port of the tracker's `soar-engagement.ts`, which in
turn follows your SOAR methodology document. It implements:

- required fields per the methodology, `@HIDDEN` already excluded
- `admit_reason` including option 4 ("For induction") requiring the induction
  detail checkboxes
- the `c_sect_indication_primary` branches 1/2/3 and their conditional fields
- the No-NTSV zero-case attestation counting as a complete submission
- reporting month from `delivery_date` for NTSV, `month_year_nontsv` for No-NTSV
- the attestation-first fallback for rows with no repeat instrument — your note
  about Prowers' February attestation being dropped

If any of that disagrees with your pipeline, **your pipeline is the reference**
for the rules and the tracker is the reference for the output shape. Tell us
which and we will fix whichever is wrong.

### Minimum necessary

`MINIMUM_FIELDS` in `app/programs/soar.py` lists exactly the fields the rules
read. `export_records` sends a field list and **no `forms` parameter** —
REDCap returns the union of named fields and every field on a named form, so
sending both restricts nothing. If you add a required field to the rules, add
it to `MINIMUM_FIELDS` too or it will read as permanently blank.

---

## Deployment

The tracker calls this over HTTPS, so it needs a reachable TLS endpoint. It
holds a REDCap token that reaches patient-level data, so:

- terminate TLS properly; no plain HTTP
- restrict inbound access if you can — an IP allowlist for the tracker's egress
  is stronger than the bearer token alone, and CPCQC can supply those addresses
- keep `AUTH_TOKEN` and the REDCap token in the environment, never in the repo
- the service writes nothing and stores nothing; there is no database

Any Python host works — a container, a VM, or a managed platform. It is a
single process with no background jobs, called only when a CPCQC program
manager runs a sync.

---

## Before cutover: parity

The tracker currently computes these assessments itself. Both implementations
should run against the same program year and be compared hospital by hospital,
period by period, until they agree. Where they disagree, one is wrong and we
need to know which before these numbers reach a funder or the state.

CPCQC will run that comparison; what we need from you is a reachable instance
and the `AUTH_TOKEN`.

---

## Open questions for you

1. **Hospital identifier.** `cha_id` is a string here, not an integer. The
   UCHealth Memorial campus split needs identifiers CHA's master list does not
   currently contain, and the chosen scheme may not be numeric.
2. **Authentication.** Bearer token is proposed. If you can support mutual TLS
   or an IP allowlist, either is stronger.
3. **HRA / readiness assessment.** Not covered. It is annual rather than
   monthly and is handled separately today; confirm whether it moves here too.
4. **The remaining programs.** SPARK, NEST and TtT still need porting. TtT is
   the awkward one: it spans two REDCap projects and its linkage rule needs
   patient-level counts, which is exactly why that calculation belongs here.

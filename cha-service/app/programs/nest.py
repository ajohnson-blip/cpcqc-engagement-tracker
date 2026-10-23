"""NEST: monthly infant safe sleep submissions.

Ported from the tracker's nest-engagement.ts so the two agree field for field.

Two repeating instruments per hospital-month, one row per infant or chart:
the Safe Sleep Practices audit and the chart review. A month is complete only
when BOTH forms were submitted and EVERY row of both passes its required-field
check. The reporting month comes from the REDCap event, not from a field.

As in the tracker, the required-field rules follow the methodology rather
than CHA's earlier logic module, whose active copy of the row checks dropped
the `race` and `notcompliant_reasons` checkbox requirements.

What the tracker keeps: deadlines, timeliness, dispositions, task state. This
module answers only "did they submit, is it complete, when did it arrive".
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date

from ..crosswalk import Crosswalk
from ..models import Assessment, FormCounts, RecordCounts
from ..redcap import RedcapClient
from .common import checkbox_filled, group_missing, is_filled, is_valid_date, plural

PROGRAM = "NEST"
TOKEN_SETTINGS = ("REDCAP_NEST_TOKEN",)
METHODOLOGY_VERSION = "nest-2026.10"
REDCAP_PROJECT = "CPCQC NEST"

SSP_FORM = "safe_sleep_audit"
CHART_FORM = "chart_reviews"

F_EVENT = "redcap_event_name"
F_DAG = "redcap_data_access_group"
F_REPEAT_INSTRUMENT = "redcap_repeat_instrument"
# Data-entry dates, one per form — when it was entered, not a clinical date.
F_SSP_DATE = "data_entry_date_ssp"
F_CHART_DATE = "data_entry_date"

# Groups with data that are not hospitals.
IGNORED_DAGS = {"", "test", "test_2"}

# --- Monthly events -> reporting month ---
# The project's 2026 event names, as the tracker lists them. Readiness and
# baseline events are not monthly data and map to nothing. An event on either
# data form that is not listed here is reported, never guessed: when 2027
# events are created, add them here and in the tracker together.
EVENT_TO_PERIOD = {
    "january_2026_arm_1": "2026-01",
    "february_2026_arm_1": "2026-02",
    "march_2026_arm_1": "2026-03",
    "april_2026_arm_1": "2026-04",
    "may_2026_arm_1": "2026-05",
    "june_2026_arm_1": "2026-06",
    "july_2026_arm_1": "2026-07",
    "aug_2026_arm_1": "2026-08",
    "sept_2026_arm_1": "2026-09",
    "oct_2026_arm_1": "2026-10",
    "nov_2026_arm_1": "2026-11",
    "dec_2026_arm_1": "2026-12",
}

# --- Required fields, per the methodology (@HIDDEN already excluded) ---
SSP_ALWAYS = ["compliant_ssp"]
SSP_NONCOMPLIANT_FIELDS = ["noncomp_addressed"]
SSP_NONCOMPLIANT_CHECKBOX = "notcompliant_reasons"

CHART_CHECKBOX = "race"
CHART_ALWAYS = [
    "ethnicity",
    "language",
    "payor",
    "ss_education_doc",
    "ss_screening_doc",
    "ss_resources_doc",
]
CHART_IF_SCREENING = ["homeneeds_doc"]  # required when ss_screening_doc = 1
CHART_IF_HOMENEEDS = ["referral_resource_doc"]  # required when homeneeds_doc = 1

# Minimum necessary: exactly what the rules above read. Race, ethnicity,
# language and payor are required fields, so they must be retrieved to test
# for presence; their values are never written. Their free-text companions
# (other_race_text, other_language2) are never read and are not requested.
MINIMUM_FIELDS = [
    F_SSP_DATE,
    F_CHART_DATE,
    *SSP_ALWAYS,
    *SSP_NONCOMPLIANT_FIELDS,
    SSP_NONCOMPLIANT_CHECKBOX,
    CHART_CHECKBOX,
    *CHART_ALWAYS,
    *CHART_IF_SCREENING,
    *CHART_IF_HOMENEEDS,
]


@dataclass(frozen=True)
class Fetched:
    records: list[dict]
    labels: dict[str, str]

    @property
    def records_read(self) -> int:
        return len(self.records)


def fetch(client: RedcapClient, tokens: dict[str, str]) -> Fetched:
    token = tokens["REDCAP_NEST_TOKEN"]
    records = client.export_records(token, MINIMUM_FIELDS)
    # Labels are a convenience: a variable name still identifies the field.
    labels = client.export_field_labels(token)
    return Fetched(records=records, labels=labels)


def assess_year(
    fetched: Fetched, program_year: int, crosswalk: Crosswalk, today: date
) -> tuple[list[Assessment], list[str]]:
    return assess(fetched.records, program_year, crosswalk.cha_ids, fetched.labels, crosswalk.untracked)


def event_period(event) -> str | None:
    """The reporting month for a monthly event; None for anything else."""
    return EVENT_TO_PERIOD.get(str(event if event is not None else "").strip().lower())


def missing_ssp_fields(row: dict) -> list[str]:
    missing = [f for f in SSP_ALWAYS if not is_filled(row.get(f))]
    # Not compliant: the reasons checkbox and "addressed" become required.
    if str(row.get("compliant_ssp", "")).strip() == "0":
        missing.extend(f for f in SSP_NONCOMPLIANT_FIELDS if not is_filled(row.get(f)))
        if not checkbox_filled(row, SSP_NONCOMPLIANT_CHECKBOX):
            missing.append(SSP_NONCOMPLIANT_CHECKBOX)
    return missing


def missing_chart_fields(row: dict) -> list[str]:
    missing = [] if checkbox_filled(row, CHART_CHECKBOX) else [CHART_CHECKBOX]
    missing.extend(f for f in CHART_ALWAYS if not is_filled(row.get(f)))
    if str(row.get("ss_screening_doc", "")).strip() == "1":
        missing.extend(f for f in CHART_IF_SCREENING if not is_filled(row.get(f)))
    if str(row.get("homeneeds_doc", "")).strip() == "1":
        missing.extend(f for f in CHART_IF_HOMENEEDS if not is_filled(row.get(f)))
    return missing


_FORMS = {
    SSP_FORM: (missing_ssp_fields, F_SSP_DATE),
    CHART_FORM: (missing_chart_fields, F_CHART_DATE),
}


def assess(
    records: list[dict],
    program_year: int,
    crosswalk: dict[str, str],
    labels: dict[str, str],
    untracked: frozenset[str] = frozenset(),
) -> tuple[list[Assessment], list[str]]:
    """Assessments per (hospital, month), plus warnings.

    `crosswalk` maps REDCap DAG -> CHA ID; DAGs in `untracked` are known and
    skipped without a warning. A DAG with data and no entry is reported, as is
    an event that is not a known month — silence would read as a hospital that
    did not submit.
    """
    warnings: list[str] = []
    seen_dags: set[str] = set()
    unknown_events: set[str] = set()

    # (cha_id, period) -> form -> accumulator
    cells: dict[tuple[str, str], dict[str, dict]] = defaultdict(
        lambda: {
            form: {"total": 0, "complete": 0, "dates": [], "invalid_dates": 0, "missing": []}
            for form in _FORMS
        }
    )

    for row in records:
        dag = str(row.get(F_DAG, "")).strip()
        if dag in IGNORED_DAGS or dag in untracked:
            continue
        # Any row counts as data here, as in the tracker, so a group with only
        # readiness data is still noticed if nobody has listed it.
        seen_dags.add(dag)
        instrument = str(row.get(F_REPEAT_INSTRUMENT, "")).strip()
        if instrument not in _FORMS:
            continue
        period = event_period(row.get(F_EVENT))
        if period is None:
            event = str(row.get(F_EVENT, "")).strip()
            if event:
                unknown_events.add(event)
            continue
        cha_id = crosswalk.get(dag)
        if cha_id is None or not period.startswith(f"{program_year}-"):
            continue

        check, date_field = _FORMS[instrument]
        acc = cells[(cha_id, period)][instrument]
        acc["total"] += 1
        missing = check(row)
        if missing:
            acc["missing"].append(missing)
        else:
            acc["complete"] += 1
        submitted_on = row.get(date_field)
        if is_valid_date(submitted_on):
            acc["dates"].append(str(submitted_on).strip()[:10])
        elif is_filled(submitted_on):
            acc["invalid_dates"] += 1

    # Event names are project configuration, not record content.
    for event in sorted(unknown_events):
        warnings.append(
            f'REDCap event "{event}" has NEST data but is not a known month; its rows were skipped. '
            "The event list needs updating."
        )
    for dag in sorted(seen_dags - crosswalk.keys()):
        warnings.append(
            f'REDCap DAG "{dag}" has NEST data but is not in the crosswalk; its rows were skipped.'
        )

    out: list[Assessment] = []
    for (cha_id, period), forms in sorted(cells.items()):
        ssp, chart = forms[SSP_FORM], forms[CHART_FORM]
        both_submitted = ssp["total"] > 0 and chart["total"] > 0
        complete = (
            both_submitted and ssp["complete"] == ssp["total"] and chart["complete"] == chart["total"]
        )
        dates = ssp["dates"] + chart["dates"]
        invalid = ssp["invalid_dates"] + chart["invalid_dates"]
        notes = []
        if invalid:
            notes.append(
                f"{plural(invalid, 'record has', 'records have')} a data-entry date that is not a "
                "valid date — timeliness may be affected."
            )
        out.append(
            Assessment(
                cha_id=cha_id,
                period=period,
                submitted=ssp["total"] > 0 or chart["total"] > 0,
                complete=complete,
                earliest_submission_date=min(dates) if dates else None,
                records=RecordCounts(
                    total=ssp["total"] + chart["total"],
                    complete=ssp["complete"] + chart["complete"],
                ),
                missing_field_groups=group_missing(
                    [(form, fields) for form, acc in forms.items() for fields in acc["missing"]],
                    labels,
                ),
                forms=tuple(
                    FormCounts(form=form, total=acc["total"], complete=acc["complete"])
                    for form, acc in forms.items()
                ),
                notes=tuple(notes),
            )
        )
    return out, warnings

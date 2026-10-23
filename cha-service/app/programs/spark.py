"""SPARK: quarterly aggregate measures.

Ported from the tracker's spark-engagement.ts, itself a port of CHA's
spark_engagement_logic.py, so the three agree field for field.

Not patient-level: each record is one hospital's counts for a quarter. The
project is longitudinal — each `*_data*` event is a quarter — and a hospital
may enter more than one record for the same quarter. One is taken as the
submission (see `pick_primary`, the row-selection rule CHA confirmed), the
rest are reported as a count of competing records.

What the tracker keeps: deadlines, timeliness, dispositions, task state. This
module answers only "did they submit, is it complete, when did it arrive".
"""
from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import date

from ..crosswalk import Crosswalk
from ..models import Assessment, MissingField, MissingFieldGroup, RecordCounts
from ..redcap import RedcapClient
from .common import is_filled, is_valid_date

PROGRAM = "SPARK"
TOKEN_SETTINGS = ("REDCAP_SPARK_TOKEN",)
METHODOLOGY_VERSION = "spark-2026.10"
REDCAP_PROJECT = "CPCQC SPARK"

FORM = "quarterly_measures"

F_RECORD_ID = "record_id"
F_EVENT = "redcap_event_name"
F_DAG = "redcap_data_access_group"
F_DATE = "date"  # REDCap @TODAY — when it was entered, not a clinical date
F_IPV_GATE = "ipv_screen_implemented"

# Groups with data that are not hospitals.
IGNORED_DAGS = {"", "test"}

# --- Required fields, verbatim from CHA's reference module ---
DENOM_FIELDS = [
    "denom_total",
    "denom_race_ai_an", "denom_race_asian", "denom_race_black",
    "denom_race_nh_pi", "denom_race_me_northaf", "denom_race_white",
    "denom_race_other", "denom_race_unknown", "denom_race_declined",
    "denom_eth_hisp", "denom_eth_nonhisp", "denom_eth_unknown",
    "denom_eth_declined",
    "denom_payor_medicaid", "denom_payor_private",
    "denom_payor_public", "denom_payor_unins",
]
SSDOH_FIELDS = [
    "ssdoh_total",
    "ssdoh_race_ai_an", "ssdoh_race_asian", "ssdoh_race_black",
    "ssdoh_me_northaf", "ssdoh_race_nh_pi", "ssdoh_race_white",
    "ssdoh_race_other", "ssdoh_race_unknown", "ssdoh_race_declined",
    "ssdoh_eth_hisp", "ssdoh_eth_nonhisp", "ssdoh_eth_unknown",
    "ssdoh_eth_declined",
    "ssdoh_payor_medicaid", "ssdoh_payor_private",
    "ssdoh_payor_public", "ssdoh_payor_unins",
]
PMHC_FIELDS = [
    "pmhc_total",
    "pmhc_race_ai_an", "pmhc_race_asian", "pmhc_race_black",
    "pmhc_me_northaf", "pmhc_race_nh_pi", "pmhc_race_white",
    "pmhc_race_other", "pmhc_race_unknown", "pmhc_race_declined",
    "pmhc_eth_hisp", "pmhc_eth_nonhisp", "pmhc_eth_unknown",
    "pmhc_eth_declined",
    "pmhc_payor_medicaid", "pmhc_payor_private",
    "pmhc_payor_public", "pmhc_payor_unins",
]
IPV_CONDITIONAL_FIELDS = [
    "ipv_total",
    "ipv_race_ai_an", "ipv_race_asian", "ipv_race_black",
    "ipv_me_northaf", "ipv_race_nh_pi", "ipv_race_white",
    "ipv_race_other", "ipv_race_unknown", "ipv_race_declined",
    "ipv_eth_hisp", "ipv_eth_nonhisp", "ipv_eth_unknown",
    "ipv_eth_declined",
    "ipv_payor_medicaid", "ipv_payor_private",
    "ipv_payor_public", "ipv_payor_unins",
]
WORKGROUP_FIELDS = ["multidisciplinary_meeting"]

# 56 fields required of every submission; the 18 IPV fields as well when IPV
# screening is implemented.
ALWAYS_REQUIRED = [*DENOM_FIELDS, *SSDOH_FIELDS, *PMHC_FIELDS, F_IPV_GATE, *WORKGROUP_FIELDS]
ALL_DATA_FIELDS = [*ALWAYS_REQUIRED, *IPV_CONDITIONAL_FIELDS]

# Minimum necessary: the 74 data fields and the submission date. Aggregate
# counts, not patient-level data. The tracker exports this form whole; naming
# the fields means nothing else on it is ever read.
MINIMUM_FIELDS = [F_DATE, *ALL_DATA_FIELDS]

# --- Event -> quarter ---
# Confirmed event names, then the month-range pattern for future quarters.
# REDCap's slugs are inconsistent: Q2 2026 spells out "june" (aprjune) where
# the other quarters abbreviate, so both forms are accepted.
EXPLICIT_EVENT_QUARTER = {
    "julysept_25_data_p_arm_1": "2025-Q3",
    "octdec_25_data_arm_1": "2025-Q4",
    "janmar_26_data_arm_1": "2026-Q1",
    "aprjune_26_data_arm_1": "2026-Q2",
}
_MONTHRANGE_TO_Q = {"janmar": 1, "aprjune": 2, "aprjun": 2, "julysept": 3, "octdec": 4}
# Longer alternatives first, so "aprjune" is not read as "aprjun".
_EVENT_PATTERN = re.compile(r"^(janmar|aprjune|aprjun|julysept|octdec)_(\d{2})")


@dataclass(frozen=True)
class Fetched:
    records: list[dict]
    labels: dict[str, str]

    @property
    def records_read(self) -> int:
        return len(self.records)


def fetch(client: RedcapClient, tokens: dict[str, str]) -> Fetched:
    token = tokens["REDCAP_SPARK_TOKEN"]
    records = client.export_records(token, MINIMUM_FIELDS)
    # Labels are a convenience: a variable name still identifies the field.
    labels = client.export_field_labels(token)
    return Fetched(records=records, labels=labels)


def assess_year(
    fetched: Fetched, program_year: int, crosswalk: Crosswalk, today: date
) -> tuple[list[Assessment], list[str]]:
    return assess(fetched.records, program_year, crosswalk.cha_ids, fetched.labels, crosswalk.untracked)


def event_quarter(event) -> str | None:
    """"janmar_26_data_arm_1" -> "2026-Q1"; None for anything but a quarterly data event."""
    ev = str(event if event is not None else "").strip()
    if not ev:
        return None
    if ev in EXPLICIT_EVENT_QUARTER:
        return EXPLICIT_EVENT_QUARTER[ev]
    if "_data" not in ev:
        return None
    m = _EVENT_PATTERN.match(ev)
    if not m:
        return None
    return f"{2000 + int(m.group(2))}-Q{_MONTHRANGE_TO_Q[m.group(1)]}"


def row_has_data(row: dict) -> bool:
    """A placeholder record with nothing entered is not a submission."""
    return any(is_filled(row.get(f)) for f in ALL_DATA_FIELDS)


def required_fields(row: dict) -> list[str]:
    required = list(ALWAYS_REQUIRED)
    if str(row.get(F_IPV_GATE, "")).strip() == "1":
        required.extend(IPV_CONDITIONAL_FIELDS)
    return required


def missing_fields(row: dict) -> list[str]:
    return [f for f in required_fields(row) if not is_filled(row.get(f))]


def _filled_required(row: dict) -> int:
    return sum(1 for f in required_fields(row) if is_filled(row.get(f)))


def _denom_total(row: dict) -> float:
    try:
        return float(str(row.get("denom_total", "")).strip() or 0)
    except ValueError:
        return 0.0


def pick_primary(rows: list[dict]) -> dict:
    """The record taken as the submission for a hospital-quarter.

    1. Among records with anything in the date field, the latest — compared as
       text, as the tracker does, so a corrupt value never beats a real date.
    2. With none dated (back-data entered before @TODAY existed), the most
       complete, then the highest denominator total.

    Ties keep the earlier row, as the tracker's reduce does.
    """
    dated = [r for r in rows if is_filled(r.get(F_DATE))]
    if dated:
        best = dated[0]
        for r in dated[1:]:
            if str(r.get(F_DATE)).strip() > str(best.get(F_DATE)).strip():
                best = r
        return best
    best = rows[0]
    for r in rows[1:]:
        rc, bc = _filled_required(r), _filled_required(best)
        if rc != bc:
            if rc > bc:
                best = r
        elif _denom_total(r) > _denom_total(best):
            best = r
    return best


def assess(
    records: list[dict],
    program_year: int,
    crosswalk: dict[str, str],
    labels: dict[str, str],
    untracked: frozenset[str] = frozenset(),
) -> tuple[list[Assessment], list[str]]:
    """Assessments per (hospital, quarter), plus warnings.

    `crosswalk` maps REDCap DAG -> CHA ID; DAGs in `untracked` are known and
    skipped without a warning. A DAG with data and no entry is reported, as is
    a quarterly data event this module cannot read — the class of mistake
    that once dropped a whole quarter.
    """
    warnings: list[str] = []
    seen_dags: set[str] = set()
    unknown_events: set[str] = set()
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)

    for row in records:
        dag = str(row.get(F_DAG, "")).strip()
        if dag in IGNORED_DAGS or dag in untracked:
            continue
        seen_dags.add(dag)
        if not row_has_data(row):
            continue
        quarter = event_quarter(row.get(F_EVENT))
        if quarter is None:
            event = str(row.get(F_EVENT, "")).strip()
            if "_data" in event:
                unknown_events.add(event)
            continue
        cha_id = crosswalk.get(dag)
        if cha_id is None or not quarter.startswith(f"{program_year}-"):
            continue
        groups[(cha_id, quarter)].append(row)

    # Event names are project configuration, not record content.
    for event in sorted(unknown_events):
        warnings.append(
            f'REDCap event "{event}" has SPARK data but is not a known quarter; its submissions were '
            "skipped. The event list needs updating."
        )
    for dag in sorted(seen_dags - crosswalk.keys()):
        warnings.append(
            f'REDCap DAG "{dag}" has SPARK data but is not in the crosswalk; its rows were skipped.'
        )

    out: list[Assessment] = []
    for (cha_id, quarter), rows in sorted(groups.items()):
        primary = pick_primary(rows)
        missing = missing_fields(primary)
        raw_date = str(primary.get(F_DATE, "")).strip() or None
        submission_date = raw_date[:10] if raw_date and is_valid_date(raw_date) else None

        # Competing records counted by distinct record ID, as the tracker does;
        # which one was used stays in REDCap.
        record_ids = {str(r.get(F_RECORD_ID, "")).strip() for r in rows} - {""}
        complete_ids = {str(r.get(F_RECORD_ID, "")).strip() for r in rows if not missing_fields(r)} - {""}

        notes = []
        if raw_date and submission_date is None:
            notes.append(
                "The submission used has a submission date that is not a valid date — timeliness "
                "can't be determined."
            )

        out.append(
            Assessment(
                cha_id=cha_id,
                period=quarter,
                submitted=True,
                complete=not missing,
                # For SPARK, the date of the record used as the submission.
                earliest_submission_date=submission_date,
                records=RecordCounts(total=len(record_ids), complete=len(complete_ids)),
                missing_field_groups=(
                    (
                        MissingFieldGroup(
                            form=FORM,
                            records=1,
                            fields=tuple(MissingField(field=f, label=labels.get(f, f)) for f in sorted(missing)),
                        ),
                    )
                    if missing
                    else ()
                ),
                fields_required=len(required_fields(primary)),
                notes=tuple(notes),
            )
        )
    return out, warnings

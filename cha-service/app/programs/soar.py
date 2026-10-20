"""SOAR: monthly NTSV cesarean submissions.

Ported from the tracker's soar-engagement.ts so the two agree field for field.
Until cutover both implementations run and their assessments are compared; a
divergence here is a defect in one of them, not a difference of opinion.

What the tracker keeps: deadlines, timeliness, dispositions, task state. This
module answers only "did they submit, is it complete, when did it arrive".
"""
from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from typing import Iterable

from ..models import Assessment, MissingField, MissingFieldGroup, RecordCounts
from ..redcap import RedcapClient

PROGRAM = "SOAR"
TOKEN_SETTINGS = ("REDCAP_SOAR_TOKEN",)
METHODOLOGY_VERSION = "soar-2026.10"
REDCAP_PROJECT = "CPCQC SOAR NTSV"

NTSV_FORM = "ntsv_cesarean_section"
NO_NTSV_FORM = "no_ntsv_csections"

F_DAG = "redcap_data_access_group"
F_REPEAT_INSTRUMENT = "redcap_repeat_instrument"
F_SUBMIT_DATE = "date"  # REDCap @TODAY — when it was entered, not a clinical date

# Groups with data that are not hospitals.
IGNORED_DAGS = {"", "test"}

# --- Required fields, per the methodology (@HIDDEN already excluded) ---
NTSV_ALWAYS = [
    "checklist_comms_tool",
    "who_managed_labor_2",
    "age",
    "delivery_date",
    "gest_age",
    "c_sect_indication_primary",
]
NTSV_ADMIT_CHECKBOX = "admit_reason"
NTSV_INDUCTION_REASON = "induction_reason"
NTSV_INDUCTION_METHOD = "induction_method"
NTSV_COND = {
    "1": ["failed_induct_rupt_mem_y_n", "failed_induction_y_n", "fail_induct_six_cm_dil"],
    "2": ["arrest_dil_six_cm_dil", "arrest_dil_rupt_mem", "adequate_contraction", "iupc_placed_y_n"],
    "3": ["push_3hours", "op_vag_delivery"],
}
NO_NTSV_MONTH_FIELD = "month_year_nontsv"
NO_NTSV_CHECKBOX = "self_report_nontsv"

# Minimum necessary: exactly what the rules above read, nothing more. Age and
# delivery date are required fields, so they must be retrieved to test for
# presence; their values are never written. Free-text fields like admit_other
# are never read and are not requested.
MINIMUM_FIELDS = [
    F_SUBMIT_DATE,
    *NTSV_ALWAYS,
    NTSV_ADMIT_CHECKBOX,
    NTSV_INDUCTION_REASON,
    NTSV_INDUCTION_METHOD,
    *NTSV_COND["1"],
    *NTSV_COND["2"],
    *NTSV_COND["3"],
    NO_NTSV_MONTH_FIELD,
    NO_NTSV_CHECKBOX,
]

_ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


@dataclass(frozen=True)
class Fetched:
    records: list[dict]
    labels: dict[str, str]

    @property
    def records_read(self) -> int:
        return len(self.records)


def fetch(client: RedcapClient, tokens: dict[str, str]) -> Fetched:
    token = tokens["REDCAP_SOAR_TOKEN"]
    records = client.export_records(token, MINIMUM_FIELDS)
    labels = client.export_field_labels(token)
    return Fetched(records=records, labels=labels)


def assess_year(
    fetched: Fetched, program_year: int, crosswalk: dict[str, str], today: date
) -> tuple[list[Assessment], list[str]]:
    return assess(fetched.records, program_year, crosswalk, fetched.labels, today)


def is_filled(value) -> bool:
    return value is not None and str(value).strip() != ""


def is_valid_date(value) -> bool:
    """A submission date is usable only when it is a real ISO calendar date.

    Junk typed into the field must not be treated as a submission date. One
    deliberate difference from the tracker: its JavaScript date parser rolls
    an impossible day like 2026-02-30 over into March and accepts it; this
    rejects it. @TODAY cannot produce such a value, so the two can only
    disagree on a corrupted entry.
    """
    if not is_filled(value):
        return False
    s = str(value).strip()[:10]
    if not _ISO_DATE.fullmatch(s):
        return False
    try:
        date.fromisoformat(s)
    except ValueError:
        return False
    return True


def checkbox_filled(row: dict, prefix: str) -> bool:
    """REDCap exports checkboxes as `field___1`, `field___2`… Filled = any checked."""
    return any(
        k.startswith(f"{prefix}___") and str(v).strip() == "1" for k, v in row.items()
    )


def checkbox_includes(row: dict, prefix: str, option: str) -> bool:
    return str(row.get(f"{prefix}___{option}", "")).strip() == "1"


def classify_row(row: dict) -> str:
    """'ntsv' | 'no_ntsv' | 'other'.

    The repeat instrument decides it. The fallback matters for rows where
    fields from more than one instrument bleed onto a base record: check the
    No-NTSV field FIRST, because a real NTSV case always carries the repeat
    instrument, so a row reaching the fallback with month_year_nontsv populated
    is an attestation even if a stray c_sect_indication_primary is also set.
    (Per CHA: Prowers' February attestation was being dropped otherwise.)
    """
    instrument = str(row.get(F_REPEAT_INSTRUMENT, "")).strip()
    if instrument == NTSV_FORM:
        return "ntsv"
    if instrument == NO_NTSV_FORM:
        return "no_ntsv"
    if is_filled(row.get(NO_NTSV_MONTH_FIELD)):
        return "no_ntsv"
    if is_filled(row.get("c_sect_indication_primary")):
        return "ntsv"
    return "other"


def ntsv_period(row: dict) -> str | None:
    """Reporting month comes from delivery_date, not the entry date."""
    raw = str(row.get("delivery_date", "")).strip()
    return raw[:7] if len(raw) >= 7 and raw[4] == "-" else None


def no_ntsv_period(row: dict, year: int) -> str | None:
    """The attestation's month dropdown, placed in the program year.

    The form records a month but no year, so the program year supplies it —
    as the tracker does. See the plan's open questions on year rollover.
    """
    raw = str(row.get(NO_NTSV_MONTH_FIELD, "")).strip()
    if not raw.isdigit():
        return None
    month = int(raw)
    return f"{year}-{month:02d}" if 1 <= month <= 12 else None


def missing_ntsv_fields(row: dict) -> list[str]:
    """Required fields left blank, with the methodology's branching logic."""
    missing = [f for f in NTSV_ALWAYS if not is_filled(row.get(f))]
    if not checkbox_filled(row, NTSV_ADMIT_CHECKBOX):
        missing.append(NTSV_ADMIT_CHECKBOX)
    # Admitted "For induction" (option 4) requires the induction detail.
    if checkbox_includes(row, NTSV_ADMIT_CHECKBOX, "4"):
        if not checkbox_filled(row, NTSV_INDUCTION_REASON):
            missing.append(NTSV_INDUCTION_REASON)
        if not checkbox_filled(row, NTSV_INDUCTION_METHOD):
            missing.append(NTSV_INDUCTION_METHOD)
    primary = str(row.get("c_sect_indication_primary", "")).strip()
    missing.extend(f for f in NTSV_COND.get(primary, []) if not is_filled(row.get(f)))
    return missing


def missing_no_ntsv_fields(row: dict) -> list[str]:
    missing = []
    if not is_filled(row.get(NO_NTSV_MONTH_FIELD)):
        missing.append(NO_NTSV_MONTH_FIELD)
    if not checkbox_filled(row, NO_NTSV_CHECKBOX):
        missing.append(NO_NTSV_CHECKBOX)
    return missing


def _group_missing(
    entries: Iterable[tuple[str, list[str]]], labels: dict[str, str]
) -> tuple[MissingFieldGroup, ...]:
    """Group by (form, exact field set), counting records per pattern.

    One record missing eight fields is an abandoned entry; eight records each
    missing one is a systematic gap. Those warrant different conversations, and
    a flat per-field tally cannot tell them apart because both produce the same
    totals. Grouping preserves the distinction without naming any record.
    """
    buckets: dict[tuple[str, tuple[str, ...]], int] = defaultdict(int)
    for form, fields in entries:
        if fields:
            buckets[(form, tuple(sorted(fields)))] += 1
    # Most-incomplete pattern first, then the most widespread — as the
    # tracker orders them. Form and fields break ties so output is stable.
    ordered = sorted(buckets.items(), key=lambda kv: (-len(kv[0][1]), -kv[1], kv[0]))
    return tuple(
        MissingFieldGroup(
            form=form,
            records=count,
            fields=tuple(MissingField(field=f, label=labels.get(f, f)) for f in fields),
        )
        for (form, fields), count in ordered
    )


def _plural(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


def assess(
    records: list[dict],
    program_year: int,
    crosswalk: dict[str, str],
    labels: dict[str, str],
    today: date,
) -> tuple[list[Assessment], list[str]]:
    """Assessments per (hospital, period), plus warnings.

    `crosswalk` maps REDCap DAG -> CHA ID. A DAG with data but no crosswalk
    entry is reported as a warning rather than silently dropped: silence would
    read as a hospital that did not submit.

    `today` flags NTSV rows whose delivery date has not happened yet — almost
    always a data-entry error. Only the count leaves this function.
    """
    warnings: list[str] = []
    seen_dags: set[str] = set()
    today_iso = today.isoformat()

    # (cha_id, period) -> accumulator
    cells: dict[tuple[str, str], dict] = defaultdict(
        lambda: {
            "ntsv_total": 0,
            "ntsv_complete": 0,
            "attestations": 0,
            "attestation_complete": 0,
            "dates": [],
            "invalid_dates": 0,
            "future_dated": 0,
            "missing": [],
        }
    )

    for row in records:
        dag = str(row.get(F_DAG, "")).strip()
        if dag in IGNORED_DAGS:
            continue
        seen_dags.add(dag)
        cha_id = crosswalk.get(dag)
        if cha_id is None:
            continue

        kind = classify_row(row)
        if kind == "ntsv":
            period = ntsv_period(row)
            if period is None or not period.startswith(f"{program_year}-"):
                continue
            cell = cells[(cha_id, period)]
            cell["ntsv_total"] += 1
            missing = missing_ntsv_fields(row)
            if missing:
                cell["missing"].append((NTSV_FORM, missing))
            else:
                cell["ntsv_complete"] += 1
            delivered = str(row.get("delivery_date", "")).strip()[:10]
            if delivered and delivered > today_iso:
                cell["future_dated"] += 1
        elif kind == "no_ntsv":
            period = no_ntsv_period(row, program_year)
            if period is None:
                continue
            cell = cells[(cha_id, period)]
            cell["attestations"] += 1
            missing = missing_no_ntsv_fields(row)
            if missing:
                cell["missing"].append((NO_NTSV_FORM, missing))
            else:
                cell["attestation_complete"] += 1
        else:
            continue

        submitted_on = row.get(F_SUBMIT_DATE)
        if is_valid_date(submitted_on):
            cell["dates"].append(str(submitted_on).strip()[:10])
        elif is_filled(submitted_on):
            cell["invalid_dates"] += 1

    for dag in sorted(seen_dags - crosswalk.keys()):
        warnings.append(
            f'REDCap DAG "{dag}" has SOAR data but is not in the crosswalk; its rows were skipped.'
        )

    out: list[Assessment] = []
    for (cha_id, period), cell in sorted(cells.items()):
        ntsv_submitted = cell["ntsv_total"] > 0
        attestation_submitted = cell["attestations"] > 0
        # Real cases take precedence: where a hospital submitted NTSV rows, all
        # of them must pass. The attestation only decides a zero-case month.
        if ntsv_submitted:
            complete = cell["ntsv_complete"] == cell["ntsv_total"]
        elif attestation_submitted:
            complete = cell["attestation_complete"] == cell["attestations"]
        else:
            complete = False

        # Counts only — never the dates themselves.
        notes: list[str] = []
        if cell["future_dated"]:
            notes.append(
                f"{_plural(cell['future_dated'], 'NTSV record has', 'NTSV records have')} "
                "a delivery date in the future — possible data-entry error."
            )
        if cell["invalid_dates"]:
            notes.append(
                f"{_plural(cell['invalid_dates'], 'record has', 'records have')} a submission "
                "date that is not a valid date — timeliness may be affected."
            )

        out.append(
            Assessment(
                cha_id=cha_id,
                period=period,
                submitted=ntsv_submitted or attestation_submitted,
                complete=complete,
                earliest_submission_date=min(cell["dates"]) if cell["dates"] else None,
                records=RecordCounts(
                    total=cell["ntsv_total"],
                    complete=cell["ntsv_complete"],
                    attestation=cell["attestations"],
                ),
                attestation_only=attestation_submitted and not ntsv_submitted,
                missing_field_groups=_group_missing(cell["missing"], labels),
                notes=tuple(notes),
            )
        )
    return out, warnings

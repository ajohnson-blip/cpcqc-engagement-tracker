"""TtT (Turning the Tide): monthly hospital reports, linked to patient-level forms.

Ported from the tracker's ttt-engagement.ts and ttt-dyadic.ts and the reading
half of ttt-sync.service.ts, themselves a port of CHA's TtT validation, so they
agree field for field.

Three REDCap projects, joined on CHA ID through crosswalk.ttt.json, because the
projects spell some hospitals' data access groups differently:

- The hospital project: one monthly report per hospital, with aggregate
  screening counts, among them positive SUD screens. Its required fields come
  from the live data dictionary. The form has no date field, so a report's
  submission date is the earliest "create" entry for its record in REDCap's
  log, which the token needs the Logging right to read.
- The patient project: one form per patient. Patient-level, so only ever
  counted: each row is reduced to its group, the month of its delivery date
  and whether it is eligible as soon as it is read, and nothing else is kept.
- The CHoSEN Dyadic project, where Denver Health enters its patient forms
  instead. It is shared with other collaboratives, so only the rows of the
  crosswalk's `dyadic_dag` groups are kept, and its eligibility field and
  substance codes are its own.

A month's report is complete when ANY of its records passes the required-field
check, CHA's rule. Linkage compares positive screens with eligible patient
forms: below the floor (no form at all against positives) the tracker treats
the month as incomplete; below the ideal (one form per positive) is reported
and never blocks.

What the tracker keeps: deadlines, timeliness, the months before CPCQC's
criteria took effect, dispositions, task state. This module answers only "did
they submit, is it complete, when did it arrive, how many patient forms back
it".
"""
from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date
from typing import TYPE_CHECKING

from ..crosswalk import TttCrosswalk
from ..errors import ProjectConfigurationError
from ..models import Assessment, Linkage, RecordCounts
from ..redcap import RedcapClient, RedcapError, labels_from_metadata
from .common import group_missing, is_filled, is_valid_date, plural

if TYPE_CHECKING:
    from ..config import Config

PROGRAM = "TTT"
TOKEN_SETTINGS = ("REDCAP_TTT_HOSPITAL_TOKEN", "REDCAP_TTT_PATIENT_TOKEN", "REDCAP_TTT_DYADIC_TOKEN")
METHODOLOGY_VERSION = "ttt-2026.10"
REDCAP_PROJECT = "CPCQC TtT hospital and patient projects; CHoSEN Dyadic"

F_DAG = "redcap_data_access_group"
F_RECORD_ID = "record_id"

# --- Hospital project ---
HOSPITAL_FORM = "co_aim_sud_learning_collaborative_monthly_hospital"
F_MONTH = "month_reporting"
F_POSITIVES = "tot_sud_scrnd_pos"
# month_reporting is a code counted from January 2025 = 1, per the data
# dictionary, so January 2026 is 13.
MONTH_CODE_ANCHOR = (2025, 1)
# Marked required in REDCap but legitimately blank when anxiety is not
# assessed separately. @HIDDEN fields are dropped as well.
REQUIRED_FIELDS_EXCLUDE = frozenset({"tot_anx_scrnd"})
_HIDDEN = re.compile(r"@HIDDEN", re.IGNORECASE)

# --- Patient project and CHoSEN Dyadic ---
F_DELIVERY = "delivery_date_1"
SUBSTANCES = "substances_used_2"  # checkbox; REDCap expands it to substances_used_2___<code>
INELIGIBLE = 2

PATIENT_ELIGIBILITY_FIELD = "sample_check_patient"
# Excludes 7 (cannabis only) and 10 (nicotine only).
PATIENT_QUALIFYING_CODES = ("1", "2", "4", "5", "6", "8", "9")

DYADIC_ELIGIBILITY_FIELD = "sample_check_mat"
# NOT the patient project's scheme: in Dyadic 7 is alcohol, 8 nicotine and 9
# cannabis, all excluded. The checkbox shares its name across the two projects;
# the codes do not share their meanings. Do not unify the lists.
DYADIC_QUALIFYING_CODES = ("1", "2", "3", "4", "5", "6")

# Minimum necessary: the delivery date (reduced to its month on reading), the
# eligibility field and the substance checkboxes. Nothing else on either
# patient-level instrument is requested.
PATIENT_MINIMUM_FIELDS = [F_DELIVERY, PATIENT_ELIGIBILITY_FIELD, SUBSTANCES]
DYADIC_MINIMUM_FIELDS = [F_DELIVERY, DYADIC_ELIGIBILITY_FIELD, SUBSTANCES]


@dataclass(frozen=True)
class PatientForm:
    """All that is kept of a patient-level row."""
    dag: str
    # The delivery date's YYYY-MM; None when it is not a valid date.
    month: str | None
    eligible: bool


@dataclass(frozen=True)
class Fetched:
    hospital_rows: list[dict]
    required_fields: tuple[str, ...]
    labels: dict[str, str]
    # Record ID -> date of its earliest "create" log entry. None when the log
    # could not be read, so every report's submission date is unknown.
    created_on: dict[str, str] | None
    patient_forms: list[PatientForm]
    dyadic_forms: list[PatientForm]
    records_read: int
    warnings: tuple[str, ...] = ()


@contextmanager
def _reading(project: str):
    """Name the project in a REDCap failure — TtT reads three."""
    try:
        yield
    except RedcapError as exc:
        raise RedcapError(f"{project}: {exc}") from None


def fetch(client: RedcapClient, config: Config, crosswalk: TttCrosswalk) -> Fetched:
    tokens = config.tokens
    hospital_token = tokens["REDCAP_TTT_HOSPITAL_TOKEN"]
    warnings: list[str] = []

    with _reading("TtT hospital project"):
        # The dictionary first: it decides which fields the report is read for.
        meta = client.export_metadata(hospital_token)
        required = required_fields(meta)
        if not required:
            raise ProjectConfigurationError(
                f"The TtT hospital project's data dictionary marks no field on {HOSPITAL_FORM} as required, "
                "so completeness cannot be judged."
            )
        hospital_rows = client.export_records(hospital_token, _unique([F_MONTH, F_POSITIVES, *required]))

    # From January 1 of the earliest year assessed: every report for it was
    # created on or after then.
    log_since = f"{min(config.program_years)}-01-01 00:00"
    try:
        created_on = earliest_creation(client.export_log(hospital_token, log_since))
    except RedcapError as exc:
        # Timeliness unknown is the truth when the log is unreadable;
        # failing TtT for it would hide every other result.
        created_on = None
        warnings.append(
            f"REDCap's log for the TtT hospital project could not be read ({exc}), so no report has a "
            "submission date this run and timeliness reads as unknown. Reading it needs the Logging user "
            "right as well as Export."
        )

    with _reading("TtT patient project"):
        patient_forms = [
            reduce_patient_row(row, PATIENT_ELIGIBILITY_FIELD, PATIENT_QUALIFYING_CODES)
            for row in client.export_records(tokens["REDCAP_TTT_PATIENT_TOKEN"], PATIENT_MINIMUM_FIELDS)
        ]

    dyadic_forms: list[PatientForm] = []
    dyadic_read = 0
    if crosswalk.dyadic_dags:
        dyadic = client.at(config.ttt_dyadic_api_url) if config.ttt_dyadic_api_url else client
        with _reading("CHoSEN Dyadic project"):
            # Not by record_id: Dyadic's record-ID field may be named
            # otherwise, and naming a missing field fails the whole export.
            rows = dyadic.export_records(
                tokens["REDCAP_TTT_DYADIC_TOKEN"], DYADIC_MINIMUM_FIELDS, include_record_id=False
            )
        dyadic_read = len(rows)
        # Shared with other collaboratives: only the listed groups' rows are kept.
        dyadic_forms = [
            reduce_patient_row(row, DYADIC_ELIGIBILITY_FIELD, DYADIC_QUALIFYING_CODES)
            for row in rows
            if _dag(row) in crosswalk.dyadic_dags
        ]
        for dag in sorted(crosswalk.dyadic_dags.keys() - {f.dag for f in dyadic_forms}):
            cha_id = crosswalk.dyadic_dags[dag]
            warnings.append(
                f"The CHoSEN Dyadic project returned {plural(dyadic_read, 'row', 'rows')}, none in data access "
                f'group "{dag}", so {crosswalk.describe(cha_id)} has no patient forms from it. Check its '
                "dyadic_dag in crosswalk.ttt.json."
            )

    return Fetched(
        hospital_rows=hospital_rows,
        required_fields=required,
        labels=labels_from_metadata(meta),
        created_on=created_on,
        patient_forms=patient_forms,
        dyadic_forms=dyadic_forms,
        records_read=len(hospital_rows) + len(patient_forms) + dyadic_read,
        warnings=tuple(warnings),
    )


def _unique(names: list[str]) -> list[str]:
    return list(dict.fromkeys(names))


def _dag(row: dict) -> str:
    return str(row.get(F_DAG) or "").strip()


_LEADING_INT = re.compile(r"\s*([+-]?\d+)")


def _leading_int(value) -> int | None:
    """Integer as JavaScript's parseInt reads it, as the tracker does."""
    m = _LEADING_INT.match(str(value if value is not None else ""))
    return int(m.group(1)) if m else None


def required_fields(meta: list[dict]) -> tuple[str, ...]:
    """Fields the dictionary marks required on the monthly form, less @HIDDEN and the exclusions."""
    out: list[str] = []
    for m in meta:
        if not isinstance(m, dict):
            continue
        if str(m.get("required_field") or "").strip().lower() != "y":
            continue
        form = m.get("form_name")
        if form and form != HOSPITAL_FORM:
            continue
        if _HIDDEN.search(str(m.get("field_annotation") or "")):
            continue
        name = str(m.get("field_name") or "").strip()
        if name and name not in REQUIRED_FIELDS_EXCLUDE:
            out.append(name)
    return tuple(_unique(out))


def earliest_creation(log: list[dict]) -> dict[str, str]:
    """Record ID -> date of its earliest "create" entry. Nothing else in the log is kept."""
    out: dict[str, str] = {}
    for entry in log:
        if not isinstance(entry, dict) or "create" not in str(entry.get("action") or "").lower():
            continue
        record = str(entry.get("record") or "").strip()
        day = str(entry.get("timestamp") or "").strip()[:10]
        if record and is_valid_date(day) and (record not in out or day < out[record]):
            out[record] = day
    return out


def month_code_to_period(code) -> str | None:
    c = _leading_int(code)
    if c is None or c < 1:
        return None
    anchor_year, anchor_month = MONTH_CODE_ANCHOR
    months = anchor_month - 1 + c - 1
    return f"{anchor_year + months // 12}-{months % 12 + 1:02d}"


def is_eligible(row: dict, eligibility_field: str, qualifying_codes: tuple[str, ...]) -> bool:
    """CPCQC's "derived" rule: a qualifying substance is checked and the form
    is not marked ineligible. It counts real forms whose eligibility field was
    left blank."""
    ineligible = _leading_int(row.get(eligibility_field)) == INELIGIBLE
    qualifying = any(str(row.get(f"{SUBSTANCES}___{c}") or "").strip() == "1" for c in qualifying_codes)
    return qualifying and not ineligible


def reduce_patient_row(row: dict, eligibility_field: str, qualifying_codes: tuple[str, ...]) -> PatientForm:
    delivery = row.get(F_DELIVERY)
    return PatientForm(
        dag=_dag(row),
        month=str(delivery).strip()[:7] if is_valid_date(delivery) else None,
        eligible=is_eligible(row, eligibility_field, qualifying_codes),
    )


def positive_screens(value) -> tuple[int, bool]:
    """(count, readable). Blank is 0 and readable — an unentered field is a
    completeness matter. Anything but a whole number is 0 and unreadable."""
    if not is_filled(value):
        return 0, True
    try:
        n = float(str(value).strip())
    except ValueError:
        return 0, False
    if not math.isfinite(n) or n < 0 or n != int(n):
        return 0, False
    return int(n), True


def linkage(positives: int, patient_forms: int) -> Linkage:
    if positives <= 0:
        # Nothing to link: neither threshold can fail.
        return Linkage(positive_screens=0, patient_forms=patient_forms, shortfall=0, floor_met=True, ideal_met=True)
    return Linkage(
        positive_screens=positives,
        patient_forms=patient_forms,
        shortfall=max(positives - patient_forms, 0),
        floor_met=patient_forms >= 1,
        ideal_met=patient_forms >= positives,
    )


@dataclass
class _Month:
    total: int = 0
    complete: int = 0
    missing: list[list[str]] = field(default_factory=list)
    positives: int = 0
    unreadable_positives: int = 0
    dates: list[str] = field(default_factory=list)
    no_log_entry: int = 0

    def notes(self) -> list[str]:
        notes = []
        if self.total > 1:
            notes.append(
                f"{self.total} reports were entered for this month; their positive screens are added together."
            )
        if self.unreadable_positives:
            notes.append(
                f"{plural(self.unreadable_positives, 'report has', 'reports have')} a positive-screen count "
                "that is not a whole number, counted as 0."
            )
        if self.no_log_entry:
            notes.append(
                f"{plural(self.no_log_entry, 'report has', 'reports have')} no creation entry in REDCap's log, "
                f"so when {'it was' if self.no_log_entry == 1 else 'they were'} submitted is unknown."
            )
        return notes


def assess_year(
    fetched: Fetched, program_year: int, crosswalk: TttCrosswalk, today: date
) -> tuple[list[Assessment], list[str]]:
    """Assessments per (hospital, month), plus warnings.

    A month with patient forms but no report is listed too, as not
    submitted, so the tracker sees every month with data, as its own REDCap
    path does.
    """
    warnings = list(fetched.warnings)
    year = f"{program_year}-"

    # Group names are project configuration, not record content.
    for project, dags, mapped in (
        ("hospital", {_dag(r) for r in fetched.hospital_rows}, crosswalk.hospital_dags),
        ("patient", {f.dag for f in fetched.patient_forms}, crosswalk.patient_dags),
    ):
        for dag in sorted(dags - mapped.keys() - crosswalk.not_hospitals - {""}):
            warnings.append(
                f'REDCap DAG "{dag}" has TtT {project}-project data but is not in the crosswalk; its rows were skipped.'
            )

    reports: dict[tuple[str, str], _Month] = defaultdict(_Month)
    no_month: Counter[str] = Counter()
    for row in fetched.hospital_rows:
        cha_id = crosswalk.hospital_dags.get(_dag(row))
        if cha_id is None:
            continue
        period = month_code_to_period(row.get(F_MONTH))
        if period is None:
            if any(is_filled(row.get(f)) for f in (F_POSITIVES, *fetched.required_fields)):
                no_month[cha_id] += 1
            continue
        if not period.startswith(year):
            continue
        month = reports[(cha_id, period)]
        month.total += 1
        # Only fields the row carries are checked, as in the tracker: a
        # required checkbox arrives as its ___<code> columns and is not.
        missing = [f for f in fetched.required_fields if f in row and not is_filled(row.get(f))]
        if missing:
            month.missing.append(missing)
        else:
            month.complete += 1
        count, readable = positive_screens(row.get(F_POSITIVES))
        month.positives += count
        month.unreadable_positives += 0 if readable else 1
        if fetched.created_on is not None:
            created = fetched.created_on.get(str(row.get(F_RECORD_ID) or "").strip())
            if created:
                month.dates.append(created)
            else:
                month.no_log_entry += 1

    forms: Counter[tuple[str, str]] = Counter()
    undated: Counter[str] = Counter()
    for patient_forms, mapped in (
        (fetched.patient_forms, crosswalk.patient_dags),
        (fetched.dyadic_forms, crosswalk.dyadic_dags),
    ):
        for f in patient_forms:
            cha_id = mapped.get(f.dag)
            if cha_id is None or not f.eligible:
                continue
            if f.month is None:
                undated[cha_id] += 1
            elif f.month.startswith(year):
                forms[(cha_id, f.month)] += 1

    # Counts per hospital, never which records: those stay in REDCap.
    for cha_id, n in sorted(no_month.items()):
        warnings.append(
            f"{crosswalk.describe(cha_id)}: {plural(n, 'hospital report has', 'hospital reports have')} data "
            f"but no reporting month, so {'it is' if n == 1 else 'they are'} not counted in any month."
        )
    for cha_id, n in sorted(undated.items()):
        warnings.append(
            f"{crosswalk.describe(cha_id)}: {plural(n, 'eligible patient form has', 'eligible patient forms have')} "
            f"no valid delivery date, so {'it is' if n == 1 else 'they are'} not counted in any month's linkage."
        )

    out: list[Assessment] = []
    for key in sorted(reports.keys() | forms.keys()):
        cha_id, period = key
        month = reports.get(key)
        out.append(
            Assessment(
                cha_id=cha_id,
                period=period,
                submitted=month is not None,
                complete=month is not None and month.complete > 0,
                earliest_submission_date=min(month.dates) if month and month.dates else None,
                records=RecordCounts(total=month.total, complete=month.complete) if month else RecordCounts(),
                missing_field_groups=(
                    group_missing(((HOSPITAL_FORM, m) for m in month.missing), fetched.labels) if month else ()
                ),
                linkage=linkage(month.positives if month else 0, forms.get(key, 0)),
                notes=tuple(month.notes()) if month else (),
            )
        )
    return out, warnings

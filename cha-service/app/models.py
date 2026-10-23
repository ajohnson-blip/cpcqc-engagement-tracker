"""The output file's shapes, format v2.

These mirror docs/cha-sync-contract.md exactly. Each type serialises itself
with `to_dict()`, which names every key explicitly: the tracker refuses the
whole file if it finds a key the contract does not define, so nothing may be
added here without adding it to the contract too — and bumping
`FORMAT_VERSION` if the change is breaking.
"""
from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from typing import Literal

FORMAT_VERSION = "v2"

Program = Literal["SPARK", "NEST", "SOAR", "TTT"]
ErrorCode = Literal["redcap_unavailable", "configuration", "internal"]


@dataclass(frozen=True)
class MissingField:
    field: str
    label: str

    def to_dict(self) -> dict:
        return {"field": self.field, "label": self.label}


@dataclass(frozen=True)
class MissingFieldGroup:
    """Distinct pattern of missing required fields, with how many records share it.

    Grouped rather than flat so a program manager can tell an abandoned entry
    (one record missing many fields) from a systematic gap (many records each
    missing one). Carries no record identifiers — those stay in REDCap.
    """
    form: str
    records: int
    fields: tuple[MissingField, ...]

    def to_dict(self) -> dict:
        return {
            "form": self.form,
            "records": self.records,
            "fields": [f.to_dict() for f in self.fields],
        }


@dataclass(frozen=True)
class RecordCounts:
    total: int = 0
    complete: int = 0
    attestation: int = 0

    def to_dict(self) -> dict:
        return {"total": self.total, "complete": self.complete, "attestation": self.attestation}


@dataclass(frozen=True)
class FormCounts:
    """One instrument's rows for a hospital-period — NEST, which needs both its
    forms submitted, and reports which was missing when only one was."""
    form: str
    total: int = 0
    complete: int = 0

    def to_dict(self) -> dict:
        return {"form": self.form, "total": self.total, "complete": self.complete}


@dataclass(frozen=True)
class Linkage:
    """TtT only. Derived from patient-level records, so it must be computed here."""
    positive_screens: int = 0
    patient_forms: int = 0
    shortfall: int = 0
    floor_met: bool = False
    ideal_met: bool = False

    def to_dict(self) -> dict:
        return {
            "positive_screens": self.positive_screens,
            "patient_forms": self.patient_forms,
            "shortfall": self.shortfall,
            "floor_met": self.floor_met,
            "ideal_met": self.ideal_met,
        }


@dataclass(frozen=True)
class Assessment:
    cha_id: str
    period: str
    submitted: bool
    complete: bool
    # When the data was entered, never a clinical date. None when REDCap
    # captured no usable timestamp — the tracker then reports timeliness as
    # unknown.
    earliest_submission_date: str | None = None
    records: RecordCounts = dataclasses.field(default_factory=RecordCounts)
    attestation_only: bool = False
    missing_field_groups: tuple[MissingFieldGroup, ...] = ()
    # NEST only: per-form counts. None elsewhere.
    forms: tuple[FormCounts, ...] | None = None
    linkage: Linkage | None = None
    notes: tuple[str, ...] = ()

    def to_dict(self) -> dict:
        out = {
            "cha_id": self.cha_id,
            "period": self.period,
            "submitted": self.submitted,
            "complete": self.complete,
            "earliest_submission_date": self.earliest_submission_date,
            "records": self.records.to_dict(),
            "attestation_only": self.attestation_only,
            "missing_field_groups": [g.to_dict() for g in self.missing_field_groups],
            "notes": list(self.notes),
        }
        # Program-specific; omitted rather than null elsewhere, as the contract shows.
        if self.forms is not None:
            out["forms"] = [f.to_dict() for f in self.forms]
        if self.linkage is not None:
            out["linkage"] = self.linkage.to_dict()
        return out


@dataclass(frozen=True)
class Source:
    records_read: int
    redcap_project: str

    def to_dict(self) -> dict:
        return {"records_read": self.records_read, "redcap_project": self.redcap_project}


@dataclass(frozen=True)
class RunError:
    code: ErrorCode
    message: str

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message}


@dataclass(frozen=True)
class Run:
    """One program, one program year. Either complete or an error — never partial.

    Partial assessments are never sent: a program that silently omitted
    hospitals would read as those hospitals not having submitted.
    """
    program: Program
    program_year: int
    status: Literal["ok", "error"]
    methodology_version: str | None = None
    source: Source | None = None
    assessments: tuple[Assessment, ...] = ()
    warnings: tuple[str, ...] = ()
    error: RunError | None = None

    @classmethod
    def ok(
        cls,
        program: Program,
        program_year: int,
        methodology_version: str,
        source: Source,
        assessments: list[Assessment],
        warnings: list[str],
    ) -> Run:
        return cls(
            program=program,
            program_year=program_year,
            status="ok",
            methodology_version=methodology_version,
            source=source,
            assessments=tuple(assessments),
            warnings=tuple(warnings),
        )

    @classmethod
    def failed(cls, program: Program, program_year: int, code: ErrorCode, message: str) -> Run:
        return cls(
            program=program,
            program_year=program_year,
            status="error",
            error=RunError(code=code, message=message),
        )

    def to_dict(self) -> dict:
        if self.status == "error":
            assert self.error is not None
            return {
                "program": self.program,
                "program_year": self.program_year,
                "status": "error",
                "error": self.error.to_dict(),
            }
        assert self.source is not None and self.methodology_version is not None
        return {
            "program": self.program,
            "program_year": self.program_year,
            "status": "ok",
            "methodology_version": self.methodology_version,
            "source": self.source.to_dict(),
            "assessments": [a.to_dict() for a in self.assessments],
            "warnings": list(self.warnings),
        }


@dataclass(frozen=True)
class Snapshot:
    """The whole file: one per run of the script."""
    snapshot_id: str
    generated_at: str
    generator_name: str
    generator_version: str
    runs: tuple[Run, ...]

    def to_dict(self) -> dict:
        return {
            "format_version": FORMAT_VERSION,
            "snapshot_id": self.snapshot_id,
            "generated_at": self.generated_at,
            "generator": {"name": self.generator_name, "version": self.generator_version},
            "runs": [r.to_dict() for r in self.runs],
        }

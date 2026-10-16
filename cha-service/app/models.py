"""Request and response shapes for contract v1.

These mirror docs/cha-sync-contract.md exactly. If you change a field here,
change it there too and bump `contract_version` — the tracker rejects a
response whose version it does not recognise.
"""
from typing import Literal, Optional
from pydantic import BaseModel, Field

CONTRACT_VERSION = "v1"

Program = Literal["SPARK", "NEST", "SOAR", "TTT"]
EligibilityMode = Literal["derived", "explicit", "either"]


class RequestOptions(BaseModel):
    eligibility_mode: EligibilityMode = "derived"


class AssessRequest(BaseModel):
    contract_version: str
    program: Program
    program_year: int
    periods: Optional[list[str]] = None
    options: RequestOptions = Field(default_factory=RequestOptions)


class MissingField(BaseModel):
    field: str
    label: str


class MissingFieldGroup(BaseModel):
    """Distinct pattern of missing required fields, with how many records share it.

    Grouped rather than flat so a program manager can tell an abandoned entry
    (one record missing many fields) from a systematic gap (many records each
    missing one). Carries no record identifiers — those stay in REDCap.
    """
    form: str
    records: int
    fields: list[MissingField]


class RecordCounts(BaseModel):
    total: int = 0
    complete: int = 0
    attestation: int = 0


class Linkage(BaseModel):
    """TtT only. Derived from patient-level records, so it must be computed here."""
    positive_screens: int = 0
    patient_forms: int = 0
    shortfall: int = 0
    floor_met: bool = False
    ideal_met: bool = False


class Assessment(BaseModel):
    cha_id: str
    period: str
    submitted: bool
    complete: bool
    # When the data was entered, never a clinical date. Null when REDCap
    # captured no timestamp — the tracker then reports timeliness as N/A.
    earliest_submission_date: Optional[str] = None
    records: RecordCounts = Field(default_factory=RecordCounts)
    attestation_only: bool = False
    missing_field_groups: list[MissingFieldGroup] = Field(default_factory=list)
    linkage: Optional[Linkage] = None
    notes: list[str] = Field(default_factory=list)


class SourceInfo(BaseModel):
    records_read: int
    redcap_project: str


class AssessResponse(BaseModel):
    contract_version: str = CONTRACT_VERSION
    program: Program
    program_year: int
    # Identifies the ruleset that produced these figures. Change it whenever
    # required-field lists, eligibility criteria or thresholds change, so a
    # number can be traced to the rules behind it.
    methodology_version: str
    computed_at: str
    source: SourceInfo
    assessments: list[Assessment]
    warnings: list[str] = Field(default_factory=list)

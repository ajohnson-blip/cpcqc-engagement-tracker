"""The assessment service.

One endpoint: POST /v1/engagement/assess. It reads REDCap, applies the
program's rules, and returns one assessment per hospital per period. It writes
nothing, so it is safe to retry.

Deliberately NOT returned, ever: record identifiers, dates of birth or
delivery, ages, race, ethnicity, language, payor, or free text from any record.
The response carries counts, field names and labels. See
docs/cha-sync-contract.md for the full constraint list.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.responses import JSONResponse

from .auth import require_token
from .config import settings
from .models import CONTRACT_VERSION, AssessRequest, AssessResponse, SourceInfo
from .programs import soar
from .redcap import RedcapError, export_field_labels, export_records

app = FastAPI(title="CPCQC Engagement Assessment Service", version="0.1.0")

CROSSWALK_DIR = Path(__file__).parent


def _load_crosswalk(program: str) -> dict[str, dict]:
    path = CROSSWALK_DIR / f"crosswalk.{program.lower()}.json"
    if not path.exists():
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            {"error": {"code": "internal", "message": f"No crosswalk file for {program}."}},
        )
    return json.loads(path.read_text())


def _err(code: int, kind: str, message: str) -> HTTPException:
    return HTTPException(code, {"error": {"code": kind, "message": message}})


@app.get("/health")
def health() -> dict:
    """Unauthenticated liveness check. Reports no configuration detail."""
    return {"status": "ok", "contract_version": CONTRACT_VERSION}


@app.post("/v1/engagement/assess", response_model=AssessResponse)
def assess(req: AssessRequest, _: None = Depends(require_token)) -> AssessResponse:
    if req.contract_version != CONTRACT_VERSION:
        raise _err(
            400,
            "bad_request",
            f"Unsupported contract_version {req.contract_version!r}; this service implements {CONTRACT_VERSION}.",
        )

    if req.program != "SOAR":
        # Better an explicit refusal than an empty assessment list, which the
        # tracker would render as every hospital having submitted nothing.
        raise _err(
            400,
            "bad_request",
            f"Program {req.program} is not implemented yet; this service currently handles SOAR.",
        )

    token = settings.redcap_soar_token
    if not token:
        raise _err(500, "internal", "REDCAP_SOAR_TOKEN is not configured.")

    try:
        records = export_records(token, soar.MINIMUM_FIELDS)
        labels = export_field_labels(token)
    except RedcapError as exc:
        # Partial results are never returned: a sync that silently omitted
        # hospitals would read as non-participation.
        raise _err(502, "redcap_unavailable", str(exc)) from exc

    assessments, warnings = soar.assess(
        records=records,
        program_year=req.program_year,
        crosswalk=_load_crosswalk("soar"),
        labels=labels,
        periods=req.periods,
    )

    return AssessResponse(
        program=req.program,
        program_year=req.program_year,
        methodology_version=soar.METHODOLOGY_VERSION,
        computed_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        source=SourceInfo(records_read=len(records), redcap_project="CPCQC SOAR NTSV"),
        assessments=assessments,
        warnings=warnings,
    )


@app.exception_handler(HTTPException)
def http_exception_handler(_request, exc: HTTPException) -> JSONResponse:
    """Shape every error as the contract specifies: {"error": {code, message}}."""
    detail = exc.detail
    if isinstance(detail, dict) and "error" in detail:
        return JSONResponse(status_code=exc.status_code, content=detail)
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": "bad_request", "message": str(detail)}},
    )

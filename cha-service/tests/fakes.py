"""Test doubles. Synthetic data only — nothing here comes from REDCap."""
from __future__ import annotations

import json

import requests

from app.redcap import labels_from_metadata

# Shaped like a REDCap token so configuration accepts it; not a real one.
FAKE_TOKEN = "0123456789ABCDEF0123456789ABCDEF"


def response(status: int = 200, body=None, text: str | None = None) -> requests.Response:
    """A real requests.Response, so .json() and .text behave as in production."""
    res = requests.Response()
    res.status_code = status
    res._content = (json.dumps(body) if text is None else text).encode("utf-8")
    res.encoding = "utf-8"
    res.headers["Content-Type"] = "application/json"
    return res


class FakeSession:
    """Records each POST and replays scripted outcomes: a Response, or an exception to raise."""

    def __init__(self, *outcomes):
        self.outcomes = list(outcomes)
        self.calls: list[dict] = []

    def post(self, url, **kwargs):
        self.calls.append({"url": url, **kwargs})
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August",
          "September", "October", "November", "December")


def soar_dictionary(years=(2026,), labels=None) -> list[dict]:
    """A SOAR data dictionary: month_year_nontsv codes from 1 = January 2026, plus field labels."""
    choices = " | ".join(
        f"{i * 12 + j + 1}, {m} {y}" for i, y in enumerate(years) for j, m in enumerate(MONTHS)
    )
    meta = [{"field_name": "month_year_nontsv", "field_label": "Month", "select_choices_or_calculations": choices}]
    meta += [{"field_name": k, "field_label": v} for k, v in (labels or {}).items()]
    return meta


class FakeRedcapClient:
    """Stands in for RedcapClient: canned records and data dictionary, or an error."""

    def __init__(self, records=None, labels=None, error: BaseException | None = None, meta=None,
                 meta_error: BaseException | None = None, log=None, log_error: BaseException | None = None):
        self.records = records or []
        self.meta = meta if meta is not None else soar_dictionary(labels=labels)
        self.error = error
        self.meta_error = meta_error
        self.log = log or []
        self.log_error = log_error
        self.exports: list[dict] = []
        self.api_url = "https://redcap.example/api/"

    def export_records(self, token, fields, include_record_id=True):
        self.exports.append({"token": token, "fields": list(fields), "include_record_id": include_record_id})
        if self.error:
            raise self.error
        return self.records

    def export_metadata(self, token):
        if self.meta_error:
            raise self.meta_error
        return self.meta

    def export_field_labels(self, token):
        # As the real client: best effort, empty when the dictionary fails.
        if self.meta_error:
            return {}
        return labels_from_metadata(self.meta)

    def export_log(self, token, begin_time):
        self.exports.append({"token": token, "log_since": begin_time})
        if self.log_error:
            raise self.log_error
        return self.log

    def at(self, api_url):
        # The same canned data; recorded so a test can see the instance asked for.
        self.api_url = api_url
        return self

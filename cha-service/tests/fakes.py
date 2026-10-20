"""Test doubles. Synthetic data only — nothing here comes from REDCap."""
from __future__ import annotations

import json

import requests

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


class FakeRedcapClient:
    """Stands in for RedcapClient: canned records and labels, or an error."""

    def __init__(self, records=None, labels=None, error: BaseException | None = None):
        self.records = records or []
        self.labels = labels or {}
        self.error = error
        self.exports: list[dict] = []

    def export_records(self, token, fields, include_record_id=True):
        self.exports.append({"token": token, "fields": list(fields), "include_record_id": include_record_id})
        if self.error:
            raise self.error
        return self.records

    def export_field_labels(self, token):
        return self.labels

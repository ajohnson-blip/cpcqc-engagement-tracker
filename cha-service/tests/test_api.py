"""Endpoint behaviour: auth, versioning, and error shape."""
import pytest
from fastapi.testclient import TestClient

from app import main
from app.config import settings

TOKEN = "test-token-not-a-real-secret"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(settings, "auth_token", TOKEN)
    return TestClient(main.app, raise_server_exceptions=False)


def body(**over):
    b = {"contract_version": "v1", "program": "SOAR", "program_year": 2026}
    b.update(over)
    return b


def test_health_needs_no_auth(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["contract_version"] == "v1"


def test_missing_token_is_rejected(client):
    r = client.post("/v1/engagement/assess", json=body())
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "unauthorized"


def test_wrong_token_is_rejected(client):
    r = client.post("/v1/engagement/assess", json=body(),
                    headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401


def test_service_refuses_to_run_open_when_no_secret_is_set(monkeypatch):
    # A missing AUTH_TOKEN is a deployment mistake. Failing closed matters
    # because this service holds a REDCap token.
    monkeypatch.setattr(settings, "auth_token", "")
    c = TestClient(main.app, raise_server_exceptions=False)
    r = c.post("/v1/engagement/assess", json=body(),
               headers={"Authorization": "Bearer anything"})
    assert r.status_code == 500
    assert r.json()["error"]["code"] == "internal"


def test_unknown_contract_version_is_refused(client):
    r = client.post("/v1/engagement/assess", json=body(contract_version="v2"),
                    headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 400
    assert "v2" in r.json()["error"]["message"]


def test_unimplemented_program_refuses_rather_than_returning_nothing(client):
    # An empty assessment list would render in the tracker as every hospital
    # having submitted nothing.
    r = client.post("/v1/engagement/assess", json=body(program="TTT"),
                    headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 400
    assert "TTT" in r.json()["error"]["message"]


def test_missing_redcap_token_is_an_internal_error_not_an_empty_result(client, monkeypatch):
    monkeypatch.setattr(settings, "redcap_soar_token", "")
    r = client.post("/v1/engagement/assess", json=body(),
                    headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 500
    assert r.json()["error"]["code"] == "internal"

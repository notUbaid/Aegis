"""Tests for the dispatch service state machine."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

SERVICE_ROOT = Path(__file__).resolve().parent.parent


def _load_main():
    if str(SERVICE_ROOT) not in sys.path:
        sys.path.insert(0, str(SERVICE_ROOT))
    for key in [k for k in sys.modules if k.startswith("routers")]:
        del sys.modules[key]
    spec = importlib.util.spec_from_file_location("dispatch_main", SERVICE_ROOT / "main.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["dispatch_main"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def app_module():
    return _load_main()


@pytest.fixture(autouse=True)
def _patch_side_effects(app_module):
    """Silence Firestore + audit writes during tests."""
    with (
        patch.object(app_module, "write_audit", new=AsyncMock()),
        patch.object(app_module, "update_incident_status", new=AsyncMock()),
        patch.object(app_module, "send_to_tokens", return_value=[]),
    ):
        yield


def _page(client, dispatch_id: str, **overrides) -> None:
    """Helper: page a fresh dispatch so subsequent transitions are legal."""
    payload = {
        "dispatch_id": dispatch_id,
        "incident_id": overrides.get("incident_id", "INC-test"),
        "venue_id": overrides.get("venue_id", "taj-ahmedabad"),
        "responder_id": overrides.get("responder_id", "RSP-test"),
        "role": overrides.get("role", "Responder"),
        "severity": overrides.get("severity", "S2"),
        "category": overrides.get("category", "FIRE"),
        "zone_id": overrides.get("zone_id", "kitchen-main"),
        "rationale": overrides.get("rationale", "test"),
        "fcm_tokens": overrides.get("fcm_tokens", []),
    }
    resp = client.post("/v1/dispatches", json=payload)
    assert resp.status_code == 200, resp.text


@pytest.fixture(autouse=True)
def _reset_state(app_module) -> None:
    with TestClient(app_module.app):  # trigger lifespan so app.state is set
        app_module.app.state.memory_store.clear()
        for t in list(app_module.app.state.pending_timeouts.values()):
            t.cancel()
        app_module.app.state.pending_timeouts.clear()


@pytest.fixture
def client(app_module) -> TestClient:
    return TestClient(app_module.app)


def test_health(client: TestClient) -> None:
    assert client.get("/health").json()["service"] == "dispatch"


def test_ack_moves_to_acknowledged(client: TestClient) -> None:
    _page(client, "DSP-123")
    resp = client.post("/v1/dispatches/DSP-123/ack")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ACKNOWLEDGED"


def test_full_happy_path(client: TestClient) -> None:
    did = "DSP-abc"
    _page(client, did)
    assert client.post(f"/v1/dispatches/{did}/ack").json()["status"] == "ACKNOWLEDGED"
    assert client.post(f"/v1/dispatches/{did}/enroute").json()["status"] == "EN_ROUTE"
    assert client.post(f"/v1/dispatches/{did}/arrived").json()["status"] == "ARRIVED"
    final = client.get(f"/v1/dispatches/{did}").json()
    assert final["status"] == "ARRIVED"


def test_invalid_transition_rejected(client: TestClient) -> None:
    """Cannot mark ARRIVED without going through ACK + EN_ROUTE first."""
    did = "DSP-skip"
    _page(client, did)
    resp = client.post(f"/v1/dispatches/{did}/arrived")
    assert resp.status_code == 409


def test_create_dispatch_idempotent(client: TestClient) -> None:
    """Duplicate Pub/Sub delivery must not reset an acknowledged dispatch."""
    did = "DSP-dup"
    _page(client, did)
    assert client.post(f"/v1/dispatches/{did}/ack").json()["status"] == "ACKNOWLEDGED"
    # Second create_dispatch should be a no-op and keep status ACKNOWLEDGED.
    payload = {
        "dispatch_id": did,
        "incident_id": "INC-test",
        "venue_id": "taj-ahmedabad",
        "responder_id": "RSP-test",
        "role": "Responder",
        "severity": "S2",
        "category": "FIRE",
        "zone_id": "kitchen-main",
        "rationale": "redelivery",
        "fcm_tokens": [],
    }
    resp = client.post("/v1/dispatches", json=payload)
    assert resp.status_code == 200
    assert resp.json()["status"] == "ACKNOWLEDGED"


def test_get_unknown_returns_404(client: TestClient) -> None:
    resp = client.get("/v1/dispatches/UNKNOWN")
    assert resp.status_code == 404


def test_get_dispatch_falls_back_to_firestore(client: TestClient, app_module) -> None:
    # Populate memory store directly (simulating a persisted dispatch)
    app_module.app.state.memory_store["DSP-persisted"] = {
        "dispatch_id": "DSP-persisted",
        "incident_id": "INC-9",
        "venue_id": "taj-ahmedabad",
        "responder_id": "RSP-kavya",
        "role": "Doctor",
        "status": "ARRIVED",
        "last_updated_at": "2026-04-24T00:01:00+00:00",
        "paged_at": "2026-04-24T00:00:00+00:00",
    }
    resp = client.get("/v1/dispatches/DSP-persisted")

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ARRIVED"
    assert body["incident_id"] == "INC-9"
    assert body["responder_id"] == "RSP-kavya"


def test_create_dispatch_emits_fcm(client: TestClient, app_module) -> None:
    payload = {
        "dispatch_id": "DSP-xyz",
        "incident_id": "INC-1",
        "venue_id": "taj-ahmedabad",
        "responder_id": "RSP-priya",
        "role": "Duty Manager",
        "severity": "S2",
        "category": "FIRE",
        "zone_id": "kitchen-main",
        "rationale": "Kitchen fire",
        "fcm_tokens": ["token-a", "token-b"],
    }
    with patch.object(
        app_module, "send_to_tokens", return_value=["token-a", "token-b"]
    ) as mock_fcm:
        resp = client.post("/v1/dispatches", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "PAGED"
    mock_fcm.assert_called_once()

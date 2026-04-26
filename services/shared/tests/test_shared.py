"""Unit tests for aegis_shared: firestore, audit, auth, pubsub.

Service-level tests always mock these helpers at the call-site, so their
function bodies are never exercised. These tests call the real implementations
directly, mocking only the external SDK clients.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Shared mock factory
# ---------------------------------------------------------------------------


def _make_fs_client() -> MagicMock:
    """Chainable async Firestore client mock supporting all query patterns."""
    snap = MagicMock()
    snap.exists = True
    snap.to_dict.return_value = {
        "incident_id": "INC-1",
        "status": "DETECTED",
        "venue_id": "v1",
        "zone_id": "z1",
        "detected_at": "2099-01-01T00:00:00+00:00",
        "classification": {"category": "FIRE"},
    }

    sub_set = AsyncMock()
    sub_doc = MagicMock()
    sub_doc.set = sub_set
    sub_coll = MagicMock()
    sub_coll.document.return_value = sub_doc
    sub_coll.get = AsyncMock(return_value=[])

    device = MagicMock()
    device.to_dict.return_value = {"token": "tok-xyz"}
    user_doc = MagicMock()
    user_doc.to_dict.return_value = {"responder_id": "R1"}
    user_doc.reference = MagicMock()
    user_doc.reference.collection.return_value.get = AsyncMock(return_value=[device])

    doc = MagicMock()
    doc.set = AsyncMock()
    doc.get = AsyncMock(return_value=snap)
    doc.collection.return_value = sub_coll

    query = MagicMock()
    query.where.return_value = query
    query.order_by.return_value = query
    query.limit.return_value = query
    query.get = AsyncMock(return_value=[snap])

    coll = MagicMock()
    coll.document.return_value = doc
    coll.where.return_value = query
    coll.get = AsyncMock(return_value=[user_doc])

    client = MagicMock()
    client.collection.return_value = coll
    client.collection_group.return_value = query
    return client


# ============================================================
# firestore.py
# ============================================================


def test_get_firestore_client_raises_when_no_client():
    from aegis_shared import firestore as fs

    with (
        patch.object(fs, "_client_or_none", return_value=None),
        pytest.raises(RuntimeError, match="Firestore client unavailable"),
    ):
        fs.get_firestore_client()


def test_get_firestore_client_returns_mock():
    from aegis_shared import firestore as fs

    mock = MagicMock()
    with patch.object(fs, "_client_or_none", return_value=mock):
        assert fs.get_firestore_client() is mock


# -- upsert_incident --


async def test_upsert_incident_no_client_is_noop():
    from aegis_shared import firestore as fs

    m = MagicMock()
    m.model_dump.return_value = {"incident_id": "INC-1"}
    with patch.object(fs, "_client_or_none", return_value=None):
        await fs.upsert_incident(m)  # must not raise


async def test_upsert_incident_writes_to_collection():
    from aegis_shared import firestore as fs

    client = _make_fs_client()
    m = MagicMock()
    m.model_dump.return_value = {"incident_id": "INC-1", "status": "DETECTED"}
    with patch.object(fs, "_client_or_none", return_value=client):
        await fs.upsert_incident(m)
    client.collection.assert_called_with("incidents")


async def test_upsert_incident_missing_id_logs_warning():
    from aegis_shared import firestore as fs

    client = _make_fs_client()
    m = MagicMock()
    m.model_dump.return_value = {}  # no incident_id → ValueError caught
    with patch.object(fs, "_client_or_none", return_value=client):
        await fs.upsert_incident(m)


# -- append_incident_event --


async def test_append_incident_event_no_client_is_noop():
    from aegis_shared import firestore as fs

    with patch.object(fs, "_client_or_none", return_value=None):
        await fs.append_incident_event("INC-1", {"event_id": "E1"})


async def test_append_incident_event_pydantic_model():
    from aegis_shared import firestore as fs

    client = _make_fs_client()
    event = MagicMock()
    event.model_dump.return_value = {"event_id": "E1", "action": "CLASSIFIED"}
    with patch.object(fs, "_client_or_none", return_value=client):
        await fs.append_incident_event("INC-1", event)


async def test_append_incident_event_dict():
    from aegis_shared import firestore as fs

    client = _make_fs_client()
    with patch.object(fs, "_client_or_none", return_value=client):
        await fs.append_incident_event("INC-1", {"event_id": "E2"})


# -- update_incident_status --


async def test_update_incident_status_enum():
    from aegis_shared import firestore as fs
    from aegis_shared.schemas import IncidentStatus

    client = _make_fs_client()
    with patch.object(fs, "_client_or_none", return_value=client):
        await fs.update_incident_status("INC-1", IncidentStatus.ON_SCENE)
    client.collection.assert_called_with("incidents")


async def test_update_incident_status_string():
    from aegis_shared import firestore as fs

    client = _make_fs_client()
    with patch.object(fs, "_client_or_none", return_value=client):
        await fs.update_incident_status("INC-1", "DISPATCHED")


async def test_update_incident_status_invalid_raises():
    from aegis_shared import firestore as fs

    with (
        patch.object(fs, "_client_or_none", return_value=None),
        pytest.raises(ValueError, match="invalid incident status"),
    ):
        await fs.update_incident_status("INC-1", "NOT_A_STATUS")


async def test_update_incident_status_no_client_is_noop():
    from aegis_shared import firestore as fs
    from aegis_shared.schemas import IncidentStatus

    with patch.object(fs, "_client_or_none", return_value=None):
        await fs.update_incident_status("INC-1", IncidentStatus.CLOSED)


# -- upsert_dispatch --


async def test_upsert_dispatch_no_client_is_noop():
    from aegis_shared import firestore as fs

    with patch.object(fs, "_client_or_none", return_value=None):
        await fs.upsert_dispatch({"incident_id": "INC-1", "dispatch_id": "D-1"})


async def test_upsert_dispatch_with_client():
    from aegis_shared import firestore as fs

    client = _make_fs_client()
    d = MagicMock()
    d.model_dump.return_value = {"incident_id": "INC-1", "dispatch_id": "D-1"}
    with patch.object(fs, "_client_or_none", return_value=client):
        await fs.upsert_dispatch(d)


async def test_upsert_dispatch_missing_ids_logs_warning():
    from aegis_shared import firestore as fs

    client = _make_fs_client()
    d = MagicMock()
    d.model_dump.return_value = {"incident_id": "INC-1"}  # no dispatch_id
    with patch.object(fs, "_client_or_none", return_value=client):
        await fs.upsert_dispatch(d)


# -- get_responders_for_venue --


async def test_get_responders_for_venue_no_client():
    from aegis_shared import firestore as fs

    with patch.object(fs, "_client_or_none", return_value=None):
        assert await fs.get_responders_for_venue("venue-1") == []


async def test_get_responders_for_venue_with_client():
    from aegis_shared import firestore as fs

    client = _make_fs_client()
    with patch.object(fs, "_client_or_none", return_value=client):
        result = await fs.get_responders_for_venue("venue-1")
    assert isinstance(result, list)


# -- get_dispatch_by_id --


async def test_get_dispatch_by_id_no_client():
    from aegis_shared import firestore as fs

    with patch.object(fs, "_client_or_none", return_value=None):
        assert await fs.get_dispatch_by_id("D-1") is None


async def test_get_dispatch_by_id_found():
    from aegis_shared import firestore as fs

    client = _make_fs_client()
    with patch.object(fs, "_client_or_none", return_value=client):
        result = await fs.get_dispatch_by_id("D-1")
    assert result is not None


async def test_get_dispatch_by_id_not_found():
    from aegis_shared import firestore as fs

    client = _make_fs_client()
    client.collection_group.return_value.get = AsyncMock(return_value=[])
    with patch.object(fs, "_client_or_none", return_value=client):
        assert await fs.get_dispatch_by_id("missing") is None


# -- get_incident --


async def test_get_incident_no_client():
    from aegis_shared import firestore as fs

    with patch.object(fs, "_client_or_none", return_value=None):
        assert await fs.get_incident("INC-1") is None


async def test_get_incident_exists():
    from aegis_shared import firestore as fs

    client = _make_fs_client()
    with patch.object(fs, "_client_or_none", return_value=client):
        result = await fs.get_incident("INC-1")
    assert result is not None
    assert result["incident_id"] == "INC-1"


async def test_get_incident_not_exists():
    from aegis_shared import firestore as fs

    client = _make_fs_client()
    snap = MagicMock()
    snap.exists = False
    client.collection.return_value.document.return_value.get = AsyncMock(return_value=snap)
    with patch.object(fs, "_client_or_none", return_value=client):
        assert await fs.get_incident("ghost") is None


# -- get_active_incident --


async def test_get_active_incident_no_client():
    from aegis_shared import firestore as fs

    with patch.object(fs, "_client_or_none", return_value=None):
        assert await fs.get_active_incident("v1", "z1", "FIRE") is None


async def test_get_active_incident_matching():
    from aegis_shared import firestore as fs

    client = _make_fs_client()
    with patch.object(fs, "_client_or_none", return_value=client):
        result = await fs.get_active_incident("v1", "z1", "FIRE")
    assert result is not None
    assert result["classification"]["category"] == "FIRE"


async def test_get_active_incident_wrong_category():
    from aegis_shared import firestore as fs

    client = _make_fs_client()
    with patch.object(fs, "_client_or_none", return_value=client):
        result = await fs.get_active_incident("v1", "z1", "MEDICAL")
    assert result is None


async def test_get_active_incident_closed_status_skipped():
    from aegis_shared import firestore as fs

    client = _make_fs_client()
    closed_snap = MagicMock()
    closed_snap.to_dict.return_value = {
        "status": "CLOSED",
        "detected_at": "2099-01-01T00:00:00+00:00",
        "classification": {"category": "FIRE"},
        "venue_id": "v1",
        "zone_id": "z1",
    }
    client.collection.return_value.where.return_value.get = AsyncMock(return_value=[closed_snap])
    with patch.object(fs, "_client_or_none", return_value=client):
        assert await fs.get_active_incident("v1", "z1", "FIRE") is None


# -- patch_incident_fields --


async def test_patch_incident_fields_no_client():
    from aegis_shared import firestore as fs

    with patch.object(fs, "_client_or_none", return_value=None):
        await fs.patch_incident_fields("INC-1", {"status": "CLOSED"})


async def test_patch_incident_fields_merges():
    from aegis_shared import firestore as fs

    client = _make_fs_client()
    with patch.object(fs, "_client_or_none", return_value=client):
        await fs.patch_incident_fields("INC-1", {"s1_hitl_gated": False})
    client.collection.assert_called_with("incidents")


# -- get_fcm_tokens_for_responder --


async def test_get_fcm_tokens_no_client():
    from aegis_shared import firestore as fs

    with patch.object(fs, "_client_or_none", return_value=None):
        assert await fs.get_fcm_tokens_for_responder("R-1") == []


async def test_get_fcm_tokens_returns_tokens():
    from aegis_shared import firestore as fs

    client = _make_fs_client()
    device = MagicMock()
    device.to_dict.return_value = {"token": "tok-xyz"}
    user_doc = MagicMock()
    user_doc.reference.collection.return_value.get = AsyncMock(return_value=[device])
    # The where().get() chain must return user_docs, not incident snaps
    client.collection.return_value.where.return_value.get = AsyncMock(return_value=[user_doc])
    with patch.object(fs, "_client_or_none", return_value=client):
        tokens = await fs.get_fcm_tokens_for_responder("R-1")
    assert "tok-xyz" in tokens


# ============================================================
# audit.py
# ============================================================


def test_hash_object_with_bytes():
    from aegis_shared.audit import hash_object

    result = hash_object(b"hello world")
    assert len(result) == 16
    assert result == hash_object(b"hello world")  # deterministic


def test_hash_object_with_dict():
    from aegis_shared.audit import hash_object

    assert len(hash_object({"key": "value"})) == 16


def test_hash_object_different_inputs_differ():
    from aegis_shared.audit import hash_object

    assert hash_object({"a": 1}) != hash_object({"b": 2})


def test_bq_table_id_format():
    from aegis_shared.audit import _bq_table_id

    table_id = _bq_table_id()
    assert "events" in table_id
    assert "." in table_id


async def test_write_audit_returns_event(tmp_path, monkeypatch):
    from aegis_shared import audit

    monkeypatch.chdir(tmp_path)
    audit._PREV_HASH_BY_INCIDENT.clear()
    event = await audit.write_audit(
        venue_id="v1",
        action="TEST_ACTION",
        incident_id="INC-1",
    )
    assert event.action == "TEST_ACTION"
    assert event.venue_id == "v1"
    assert event.row_hash is not None


async def test_write_audit_hash_chain_links(tmp_path, monkeypatch):
    from aegis_shared import audit

    monkeypatch.chdir(tmp_path)
    audit._PREV_HASH_BY_INCIDENT.clear()
    e1 = await audit.write_audit(venue_id="v1", action="A1", incident_id="INC-chain")
    e2 = await audit.write_audit(venue_id="v1", action="A2", incident_id="INC-chain")
    assert e2.prev_hash == e1.row_hash


async def test_write_audit_hashes_input_output(tmp_path, monkeypatch):
    from aegis_shared import audit

    monkeypatch.chdir(tmp_path)
    audit._PREV_HASH_BY_INCIDENT.clear()
    event = await audit.write_audit(
        venue_id="v1",
        action="CLASSIFY",
        input_obj={"frame": "data"},
        output_obj={"category": "FIRE"},
        confidence=0.95,
        model_version="gemini-2.5-flash",
    )
    assert event.input_hash is not None
    assert event.output_hash is not None
    assert event.confidence == 0.95


def test_verify_chain_local_no_file():
    from aegis_shared.audit import verify_chain_local

    ok, broken = verify_chain_local()
    assert ok
    assert broken == []


async def test_verify_chain_local_valid_chain(tmp_path, monkeypatch):
    from aegis_shared import audit

    monkeypatch.chdir(tmp_path)
    audit._PREV_HASH_BY_INCIDENT.clear()
    await audit.write_audit(venue_id="v2", action="ACT1", incident_id="INC-vc")
    await audit.write_audit(venue_id="v2", action="ACT2", incident_id="INC-vc")
    ok, broken = audit.verify_chain_local()
    assert ok
    assert broken == []


async def test_verify_chain_local_detects_tamper(tmp_path, monkeypatch):
    from aegis_shared import audit

    monkeypatch.chdir(tmp_path)
    audit._PREV_HASH_BY_INCIDENT.clear()
    await audit.write_audit(venue_id="v3", action="A", incident_id="INC-tamper")
    path = audit._local_audit_path()
    content = path.read_text()
    row = json.loads(content.strip())
    row["row_hash"] = "0" * 64
    path.write_text(json.dumps(row) + "\n")
    ok, broken = audit.verify_chain_local()
    assert not ok
    assert len(broken) > 0


# ============================================================
# auth.py
# ============================================================


def test_principal_is_anonymous_default():
    from aegis_shared.auth import Principal

    assert Principal().is_anonymous is True


def test_principal_is_anonymous_false_with_uid():
    from aegis_shared.auth import Principal

    assert Principal(uid="user-123").is_anonymous is False


async def test_verify_request_no_bearer_local_returns_anonymous():
    from aegis_shared.auth import verify_request

    with patch("aegis_shared.auth._require_auth_enabled", return_value=False):
        p = await verify_request(authorization=None, x_firebase_appcheck=None)
    assert p.is_anonymous


async def test_verify_request_no_bearer_enforced_raises_401():
    from aegis_shared.auth import verify_request
    from fastapi import HTTPException

    with (
        patch("aegis_shared.auth._require_auth_enabled", return_value=True),
        pytest.raises(HTTPException) as exc_info,
    ):
        await verify_request(authorization=None, x_firebase_appcheck=None)
    assert exc_info.value.status_code == 401


async def test_verify_request_bearer_extracted_invalid_local():
    from aegis_shared.auth import verify_request

    with (
        patch("aegis_shared.auth._require_auth_enabled", return_value=False),
        patch("aegis_shared.auth._verify_id_token", return_value=None),
    ):
        p = await verify_request(authorization="Bearer bad-token", x_firebase_appcheck=None)
    assert p.is_anonymous


async def test_verify_request_bearer_invalid_enforced_raises_401():
    from aegis_shared.auth import verify_request
    from fastapi import HTTPException

    with (
        patch("aegis_shared.auth._require_auth_enabled", return_value=True),
        patch("aegis_shared.auth._verify_id_token", return_value=None),
        pytest.raises(HTTPException) as exc_info,
    ):
        await verify_request(authorization="Bearer bad-token", x_firebase_appcheck=None)
    assert exc_info.value.status_code == 401


async def test_verify_request_valid_token_builds_principal():
    from aegis_shared.auth import verify_request

    claims = {
        "uid": "user-123",
        "email": "test@example.com",
        "role": "operator",
        "venues": ["v1", "v2"],
        "skills": ["AED"],
    }
    with (
        patch("aegis_shared.auth._require_auth_enabled", return_value=True),
        patch("aegis_shared.auth._verify_id_token", return_value=claims),
    ):
        p = await verify_request(authorization="Bearer good-token", x_firebase_appcheck=None)
    assert p.uid == "user-123"
    assert p.email == "test@example.com"
    assert p.role == "operator"
    assert "v1" in p.venues
    assert "AED" in p.skills
    assert not p.is_anonymous


async def test_verify_request_with_app_check():
    from aegis_shared.auth import verify_request

    claims = {"uid": "u1", "email": None, "role": None, "venues": None, "skills": None}
    with (
        patch("aegis_shared.auth._require_auth_enabled", return_value=True),
        patch("aegis_shared.auth._verify_id_token", return_value=claims),
        patch("aegis_shared.auth._verify_app_check", return_value=True),
    ):
        p = await verify_request(
            authorization="Bearer tok",
            x_firebase_appcheck="app-check-token",
        )
    assert p.app_check_verified is True


def test_require_role_correct_role_passes():
    from aegis_shared.auth import Principal, require_role

    dep = require_role("operator")
    p = Principal(uid="u1", role="operator")

    async def _run():
        return await dep(principal=p)

    import asyncio

    result = asyncio.get_event_loop().run_until_complete(_run())
    assert result is p


async def test_require_role_wrong_role_raises_403():
    from aegis_shared.auth import Principal, require_role
    from fastapi import HTTPException

    dep = require_role("admin")
    p = Principal(uid="u1", role="operator")
    with pytest.raises(HTTPException) as exc_info:
        await dep(principal=p)
    assert exc_info.value.status_code == 403


# ============================================================
# pubsub.py
# ============================================================


def test_topic_path_format():
    from aegis_shared.pubsub import topic_path

    path = topic_path("my-topic")
    assert "my-topic" in path
    assert path.startswith("projects/")


def test_publish_json_pydantic_model():
    from aegis_shared.pubsub import publish_json
    from pydantic import BaseModel

    class Msg(BaseModel):
        value: str

    mock_future = MagicMock()
    mock_future.result.return_value = "msg-id-1"
    mock_pub = MagicMock()
    mock_pub.publish.return_value = mock_future

    with patch("aegis_shared.pubsub.get_publisher", return_value=mock_pub):
        result = publish_json("my-topic", Msg(value="hello"))

    assert result.message_id == "msg-id-1"
    assert result.topic == "my-topic"


def test_publish_json_dict_payload():
    from aegis_shared.pubsub import publish_json

    mock_future = MagicMock()
    mock_future.result.return_value = "msg-id-2"
    mock_pub = MagicMock()
    mock_pub.publish.return_value = mock_future

    with patch("aegis_shared.pubsub.get_publisher", return_value=mock_pub):
        result = publish_json("topic-x", {"key": "val"})

    assert result.message_id == "msg-id-2"


def test_publish_json_raises_downstream_on_failure():
    from aegis_shared.errors import DownstreamServiceError
    from aegis_shared.pubsub import publish_json

    mock_pub = MagicMock()
    mock_pub.publish.side_effect = Exception("connection refused")

    with (
        patch("aegis_shared.pubsub.get_publisher", return_value=mock_pub),
        patch("time.sleep"),  # suppress tenacity retry waits
        pytest.raises(DownstreamServiceError),
    ):
        publish_json("bad-topic", {"x": 1})


def test_publish_json_ordering_key_attached():
    from aegis_shared.pubsub import publish_json

    mock_future = MagicMock()
    mock_future.result.return_value = "msg-id-3"
    mock_pub = MagicMock()
    mock_pub.publish.return_value = mock_future

    mock_settings = MagicMock()
    mock_settings.using_pubsub_emulator = False
    mock_settings.gcp_project_id = "aegis-local"

    with (
        patch("aegis_shared.pubsub.get_publisher", return_value=mock_pub),
        patch("aegis_shared.pubsub.get_settings", return_value=mock_settings),
    ):
        publish_json("topic", {"x": 1}, ordering_key="venue-1")

    _, kwargs = mock_pub.publish.call_args
    assert kwargs.get("ordering_key") == "venue-1"


def test_publish_json_ordering_key_suppressed_in_emulator():
    from aegis_shared.pubsub import publish_json

    mock_future = MagicMock()
    mock_future.result.return_value = "msg-id-4"
    mock_pub = MagicMock()
    mock_pub.publish.return_value = mock_future

    mock_settings = MagicMock()
    mock_settings.using_pubsub_emulator = True
    mock_settings.gcp_project_id = "aegis-local"

    with (
        patch("aegis_shared.pubsub.get_publisher", return_value=mock_pub),
        patch("aegis_shared.pubsub.get_settings", return_value=mock_settings),
    ):
        publish_json("topic", {"x": 1}, ordering_key="venue-1")

    _, kwargs = mock_pub.publish.call_args
    assert "ordering_key" not in kwargs


# ============================================================
# fcm.py (minimal — just the no-app fast-path)
# ============================================================


def test_send_to_tokens_no_app_returns_empty():
    from aegis_shared import fcm

    with patch.object(fcm, "_firebase_app", return_value=None):
        assert fcm.send_to_tokens(["tok1"], title="T", body="B") == []


def test_send_to_tokens_empty_list_returns_empty():
    from aegis_shared import fcm

    mock_app = MagicMock()
    with patch.object(fcm, "_firebase_app", return_value=mock_app):
        assert fcm.send_to_tokens([], title="T", body="B") == []


def test_send_to_topic_no_app_returns_none():
    from aegis_shared import fcm

    with patch.object(fcm, "_firebase_app", return_value=None):
        assert fcm.send_to_topic("topic", title="T", body="B") is None

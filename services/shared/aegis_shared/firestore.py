"""Firestore client wrapper.

Respects ``FIRESTORE_EMULATOR_HOST`` automatically (set in local dev via .env).
In prod, uses ADC. Exposes helpers used across services for writing incidents,
dispatches, and state transitions. If the Firestore SDK fails to initialise
(e.g., in unit tests without creds), callers get ``None`` back and no-op.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

from aegis_shared.config import get_settings
from aegis_shared.logger import get_logger

log = get_logger(__name__)


@lru_cache(maxsize=1)
def _client_or_none() -> Any | None:
    try:
        from google.cloud import firestore  # type: ignore[attr-defined]

        settings = get_settings()
        if settings.using_firestore_emulator:
            log.info("firestore_using_emulator", host=settings.firestore_emulator_host)
        return firestore.AsyncClient(
            project=settings.gcp_project_id,
            database=settings.firestore_database,
        )
    except Exception as exc:
        log.warning("firestore_client_unavailable", error=str(exc))
        return None


def get_firestore_client() -> Any:
    """Return the cached async Firestore client (may raise if unavailable)."""
    client = _client_or_none()
    if client is None:
        raise RuntimeError("Firestore client unavailable")
    return client


async def upsert_incident(incident: Any) -> None:
    """Write the incident doc under ``/incidents/{incident_id}``.

    ``incident`` is anything with ``.model_dump(mode='json')`` — i.e., any
    Pydantic BaseModel. No-ops if Firestore is unreachable.
    """
    client = _client_or_none()
    if client is None:
        return
    try:
        data = incident.model_dump(mode="json")
        doc = data.get("incident_id")
        if not doc:
            raise ValueError("incident_id is required for upsert_incident")
        await client.collection("incidents").document(doc).set(data, merge=True)
        log.info("firestore_incident_upserted", incident_id=doc)
    except Exception as exc:
        log.warning("firestore_incident_upsert_failed", error=str(exc))


async def append_incident_event(incident_id: str, event: Any) -> None:
    client = _client_or_none()
    if client is None:
        return
    try:
        data = event.model_dump(mode="json") if hasattr(event, "model_dump") else dict(event)
        event_id = data.get("event_id", "evt")
        await (
            client.collection("incidents")
            .document(incident_id)
            .collection("events")
            .document(event_id)
            .set(data)
        )
    except Exception as exc:
        log.warning("firestore_event_append_failed", error=str(exc))


async def update_incident_status(incident_id: str, to_status: Any) -> None:
    """Patch the parent incident's ``status`` field.

    Used by the dispatch service when a responder reaches ARRIVED so the parent
    incident leaves DISPATCHED and reflects ON_SCENE in real-time UIs.
    Validates ``to_status`` against the IncidentStatus enum so we cannot write
    a typo and break UI rendering.
    """
    from aegis_shared.schemas import IncidentStatus

    if isinstance(to_status, IncidentStatus):
        status_value = to_status.value
    else:
        try:
            status_value = IncidentStatus(str(to_status)).value
        except ValueError as exc:
            raise ValueError(f"invalid incident status: {to_status!r}") from exc

    client = _client_or_none()
    if client is None:
        return
    try:
        await (
            client.collection("incidents")
            .document(incident_id)
            .set({"status": status_value}, merge=True)
        )
        log.info(
            "firestore_incident_status_updated",
            incident_id=incident_id,
            status=status_value,
        )
    except Exception as exc:
        log.warning(
            "firestore_incident_status_update_failed",
            incident_id=incident_id,
            error=str(exc),
        )


async def upsert_dispatch(dispatch: Any) -> None:
    client = _client_or_none()
    if client is None:
        return
    try:
        data = (
            dispatch.model_dump(mode="json") if hasattr(dispatch, "model_dump") else dict(dispatch)
        )
        incident_id = data.get("incident_id")
        dispatch_id = data.get("dispatch_id")
        if not incident_id or not dispatch_id:
            raise ValueError("upsert_dispatch requires both incident_id and dispatch_id")
        await (
            client.collection("incidents")
            .document(incident_id)
            .collection("dispatches")
            .document(dispatch_id)
            .set(data, merge=True)
        )
        log.info("firestore_dispatch_upserted", dispatch_id=dispatch_id, incident_id=incident_id)
    except Exception as exc:
        log.warning("firestore_dispatch_upsert_failed", error=str(exc))


async def get_responders_for_venue(venue_id: str) -> list[dict[str, Any]]:
    """Return responder documents under ``/venues/{venue_id}/responders``."""
    client = _client_or_none()
    if client is None:
        return []
    try:
        snapshot = await (
            client.collection("venues").document(venue_id).collection("responders").get()
        )
        return [doc.to_dict() for doc in snapshot]
    except Exception as exc:
        log.warning("firestore_responders_fetch_failed", error=str(exc))
        return []


async def get_dispatch_by_id(dispatch_id: str) -> dict[str, Any] | None:
    """Return a dispatch document from any incident subcollection."""
    client = _client_or_none()
    if client is None:
        return None
    try:
        # Use the FieldFilter form — positional ``.where("x", "==", y)`` is
        # deprecated in google-cloud-firestore >= 2.16 and will be removed.
        from google.cloud.firestore_v1.base_query import FieldFilter

        query = (
            client.collection_group("dispatches")
            .where(filter=FieldFilter("dispatch_id", "==", dispatch_id))
            .limit(1)
        )
        snapshot = await query.get()
        if not snapshot:
            return None
        return snapshot[0].to_dict()
    except Exception as exc:
        log.warning("firestore_dispatch_fetch_failed", dispatch_id=dispatch_id, error=str(exc))
        return None
 
 
async def get_incident(incident_id: str) -> dict[str, Any] | None:
    """Return an incident document by ID."""
    client = _client_or_none()
    if client is None:
        return None
    try:
        doc = await client.collection("incidents").document(incident_id).get()
        return doc.to_dict() if doc.exists else None
    except Exception as exc:
        log.warning("firestore_incident_fetch_failed", incident_id=incident_id, error=str(exc))
        return None


async def get_fcm_tokens_for_responder(responder_id: str) -> list[str]:
    """Return all active FCM tokens for a responder.

    Queries /users where responder_id matches, then reads each user's
    /users/{uid}/devices subcollection and collects token strings.
    Returns empty list on any failure — callers treat push as best-effort.
    """
    client = _client_or_none()
    if client is None:
        return []
    try:
        from google.cloud.firestore_v1.base_query import FieldFilter

        user_docs = await (
            client.collection("users")
            .where(filter=FieldFilter("responder_id", "==", responder_id))
            .get()
        )
        tokens: list[str] = []
        for user_doc in user_docs:
            devices = await user_doc.reference.collection("devices").get()
            for device in devices:
                token = device.to_dict().get("token", "")
                if token:
                    tokens.append(token)
        return tokens
    except Exception as exc:
        log.warning("firestore_fcm_tokens_fetch_failed", responder_id=responder_id, error=str(exc))
        return []

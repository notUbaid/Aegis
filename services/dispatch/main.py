"""Dispatch service.

Owns the responder-engagement state machine per blueprint §9.2:

    PAGED → ACKNOWLEDGED → EN_ROUTE → ARRIVED → HANDED_OFF
                ↘ DECLINED
                ↘ TIMED_OUT (if no ack within 15s)

Responsibilities:
    - Subscribe to ``dispatch-events`` (Pub/Sub push) and materialise dispatches
      in Firestore (``/incidents/{incident_id}/dispatches/{dispatch_id}``).
    - Send FCM push to the responder's registered devices (or topic).
    - Serve HTTP endpoints staff/responder apps call to transition state.
    - Enforce the 15 s acknowledge timeout — if the primary does not ack, the
      backup ladder is paged automatically.

Everything here emits audit events via ``aegis_shared.audit`` so the chain of
custody for each dispatch is provable end-to-end.
"""

from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

from aegis_shared import setup_logging
from aegis_shared.audit import write_audit
from aegis_shared.errors import AegisError
from aegis_shared.fcm import send_to_tokens
from aegis_shared.firestore import (
    get_dispatch_by_id,
    get_fcm_tokens_for_responder,
    get_incident,
    update_incident_status,
    upsert_dispatch,
)
from aegis_shared.logger import get_logger
from aegis_shared.schemas import (
    Dispatch,
    DispatchStatus,
    IncidentStatus,
    PubSubEnvelope,
    new_id,
)
from aegis_shared.auth import Principal, verify_request
from aegis_shared.security import apply_security_middleware
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

ACK_TIMEOUT_SECONDS = 15

# Valid forward transitions for the dispatch state machine. A transition
# from a status to itself is treated as idempotent (no-op) by ``_record``.
VALID_TRANSITIONS: dict[DispatchStatus, set[DispatchStatus]] = {
    DispatchStatus.PAGED: {
        DispatchStatus.ACKNOWLEDGED,
        DispatchStatus.DECLINED,
        DispatchStatus.TIMED_OUT,
    },
    DispatchStatus.ACKNOWLEDGED: {
        DispatchStatus.EN_ROUTE,
        DispatchStatus.DECLINED,
    },
    DispatchStatus.EN_ROUTE: {
        DispatchStatus.ARRIVED,
        DispatchStatus.DECLINED,
    },
    DispatchStatus.ARRIVED: {
        DispatchStatus.HANDED_OFF,
    },
    DispatchStatus.HANDED_OFF: set(),
    DispatchStatus.DECLINED: set(),
    DispatchStatus.TIMED_OUT: set(),
}


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    setup_logging("dispatch")
    get_logger(__name__).info("dispatch_service_started")
    yield


app = FastAPI(title="Aegis Dispatch", version="0.1.0", lifespan=lifespan)

# Apply CORS + security headers middleware
apply_security_middleware(app)


@app.exception_handler(AegisError)
async def aegis_exception_handler(request: Request, exc: AegisError) -> JSONResponse:
    log = get_logger(__name__)
    log.error("aegis_error", path=request.url.path, category=exc.audit_category, detail=str(exc))
    return JSONResponse(
        status_code=exc.http_status,
        content={"detail": str(exc), "category": exc.audit_category},
    )


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    log = get_logger(__name__)
    from fastapi import HTTPException as FastAPIHTTPException
    from fastapi.exceptions import RequestValidationError

    status_code = 500
    detail: Any = "Internal Server Error"

    if isinstance(exc, FastAPIHTTPException):
        status_code = exc.status_code
        detail = exc.detail
    elif isinstance(exc, RequestValidationError):
        status_code = 422
        detail = exc.errors()
    else:
        log.exception("unhandled_exception", path=request.url.path)

    return JSONResponse(
        status_code=status_code,
        content={"detail": detail},
    )


app.state.pending_timeouts = {}  # asyncio tasks — per-process, best-effort
log = get_logger(__name__)


class DispatchState(BaseModel):
    dispatch_id: str
    incident_id: str | None = None
    venue_id: str | None = None
    responder_id: str | None = None
    status: DispatchStatus
    last_updated_at: datetime


class CreateDispatch(BaseModel):
    dispatch_id: str | None = None
    incident_id: str
    venue_id: str
    responder_id: str
    role: str = "Responder"
    severity: str = "S2"
    category: str = "OTHER"
    zone_id: str = ""
    rationale: str = ""
    fcm_tokens: list[str] = []
    escalation_chain: list[dict[str, Any]] = []
    # Original dispatch-decision time on the orchestrator. When the message is
    # delivered via Pub/Sub there is propagation lag, so the dispatch service
    # honours this rather than stamping its own service-receive time.
    paged_at: datetime | None = None


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "dispatch"}


def _validate_transition(current: DispatchStatus | None, target: DispatchStatus) -> None:
    """Raise HTTPException 409 if ``target`` is not a legal next state."""
    if current is None:
        # First write — only PAGED is a valid initial state.
        if target != DispatchStatus.PAGED:
            raise HTTPException(
                status_code=409,
                detail=f"cannot start dispatch in status {target.value}; expected PAGED",
            )
        return
    if current == target:
        return  # idempotent
    allowed = VALID_TRANSITIONS.get(current, set())
    if target not in allowed:
        raise HTTPException(
            status_code=409,
            detail=(
                f"invalid transition {current.value} → {target.value}; "
                f"allowed: {[s.value for s in allowed]}"
            ),
        )


async def _record(
    dispatch_id: str,
    status: DispatchStatus,
    *,
    incident_id: str | None = None,
    venue_id: str | None = None,
    responder_id: str | None = None,
    extra: dict[str, Any] | None = None,
) -> DispatchState:
    now = datetime.now(UTC)

    # Always read from Firestore — authoritative across all instances.
    persisted = await get_dispatch_by_id(dispatch_id)
    entry: dict[str, Any] = _hydrate_dispatch_entry(persisted) if persisted else {}

    current = entry.get("status")
    _validate_transition(current, status)
    if current == status and entry:
        # Idempotent re-delivery — return current state without re-emitting side effects.
        return DispatchState(
            dispatch_id=dispatch_id,
            incident_id=entry.get("incident_id"),
            venue_id=entry.get("venue_id"),
            responder_id=entry.get("responder_id"),
            status=status,
            last_updated_at=entry.get("last_updated_at", now),
        )

    updated: dict[str, Any] = {
        **entry,
        "dispatch_id": dispatch_id,
        "status": status,
        "last_updated_at": now,
        "incident_id": incident_id or entry.get("incident_id"),
        "venue_id": venue_id or entry.get("venue_id"),
        "responder_id": responder_id or entry.get("responder_id"),
        **(extra or {}),
    }

    if updated.get("incident_id") and updated.get("venue_id"):
        paged_at = updated.get("paged_at")
        dispatch = Dispatch(
            dispatch_id=dispatch_id,
            venue_id=updated["venue_id"],
            incident_id=updated["incident_id"],
            responder_id=updated.get("responder_id", "unknown"),
            role=updated.get("role", "Responder"),
            status=status,
            notes=updated.get("rationale", ""),
            escalation_chain=updated.get("escalation_chain", []),
            **({"paged_at": paged_at} if isinstance(paged_at, datetime) else {}),
        )
        if status == DispatchStatus.ACKNOWLEDGED:
            dispatch.acknowledged_at = now
        elif status == DispatchStatus.EN_ROUTE:
            dispatch.en_route_at = now
        elif status == DispatchStatus.ARRIVED:
            dispatch.arrived_at = now
        elif status == DispatchStatus.HANDED_OFF:
            dispatch.handed_off_at = now
        await upsert_dispatch(dispatch)

    await write_audit(
        venue_id=updated.get("venue_id", "unknown"),
        incident_id=updated.get("incident_id"),
        action=f"dispatch.{status.value.lower()}",
        actor_type="human"
        if status
        in (
            DispatchStatus.ACKNOWLEDGED,
            DispatchStatus.EN_ROUTE,
            DispatchStatus.ARRIVED,
            DispatchStatus.HANDED_OFF,
        )
        else "system",
        actor_id=updated.get("responder_id", "system"),
        output_obj={"dispatch_id": dispatch_id, "status": status.value},
        explanation=f"Dispatch {dispatch_id} transitioned to {status.value}.",
    )

    log.info(
        "dispatch_state_changed",
        dispatch_id=dispatch_id,
        status=status.value,
        incident_id=updated.get("incident_id"),
    )
    return DispatchState(
        dispatch_id=dispatch_id,
        incident_id=updated.get("incident_id"),
        venue_id=updated.get("venue_id"),
        responder_id=updated.get("responder_id"),
        status=status,
        last_updated_at=now,
    )


async def _schedule_ack_timeout(dispatch_id: str) -> None:
    """Wait ACK_TIMEOUT_SECONDS; if still PAGED in Firestore, mark timed-out and escalate."""
    await asyncio.sleep(ACK_TIMEOUT_SECONDS)
    persisted = await get_dispatch_by_id(dispatch_id)
    if not persisted:
        return
    entry = _hydrate_dispatch_entry(persisted)
    if entry.get("status") == DispatchStatus.PAGED:
        await _record(dispatch_id, DispatchStatus.TIMED_OUT)
        log.warning("dispatch_ack_timeout", dispatch_id=dispatch_id)
        await _page_next_in_chain(persisted)


def _arm_timeout(dispatch_id: str) -> None:
    existing = app.state.pending_timeouts.pop(dispatch_id, None)
    if existing and not existing.done():
        existing.cancel()
    task = asyncio.create_task(_schedule_ack_timeout(dispatch_id))
    app.state.pending_timeouts[dispatch_id] = task


def _cancel_timeout(dispatch_id: str) -> None:
    task = app.state.pending_timeouts.pop(dispatch_id, None)
    if task and not task.done():
        task.cancel()


async def _page_next_in_chain(dispatch_doc: dict[str, Any]) -> None:
    """Page the next backup responder when a dispatch is declined or timed out.

    Reads escalation_chain from the original dispatch doc, pops the first entry,
    creates a new dispatch for them with the remaining chain. If the chain is
    empty, logs a warning — all responders are exhausted.
    """
    chain: list[dict[str, Any]] = dispatch_doc.get("escalation_chain", [])
    if not chain:
        log.warning(
            "dispatch_chain_exhausted",
            incident_id=dispatch_doc.get("incident_id"),
            venue_id=dispatch_doc.get("venue_id"),
        )
        return

    next_entry = chain[0]
    remaining = chain[1:]

    incident_id = dispatch_doc.get("incident_id", "")
    venue_id = dispatch_doc.get("venue_id", "")

    # Read incident for severity/category/zone — needed for FCM notification body.
    severity, category, zone_id = "S2", "OTHER", ""
    incident_doc = await get_incident(incident_id)
    if incident_doc:
        clf = incident_doc.get("classification") or {}
        severity = clf.get("severity", "S2")
        category = clf.get("category", "OTHER")
        zone_id = incident_doc.get("zone_id", "")

    log.info(
        "dispatch_escalating",
        incident_id=incident_id,
        next_responder=next_entry.get("responder_id"),
        remaining_chain_length=len(remaining),
    )
    await _do_create_dispatch(
        CreateDispatch(
            incident_id=incident_id,
            venue_id=venue_id,
            responder_id=next_entry.get("responder_id", ""),
            role=next_entry.get("role", "Responder"),
            severity=severity,
            category=category,
            zone_id=zone_id,
            rationale=next_entry.get("rationale", ""),
            escalation_chain=remaining,
        )
    )


async def _do_create_dispatch(req: CreateDispatch) -> DispatchState:
    """Business logic for dispatch creation — called by the HTTP route and the Pub/Sub subscriber."""
    dispatch_id = req.dispatch_id or new_id("DSP")

    # Idempotency: read authoritative state from Firestore.
    persisted = await get_dispatch_by_id(dispatch_id)
    existing = _hydrate_dispatch_entry(persisted) if persisted else None
    if existing and existing.get("status") and existing["status"] != DispatchStatus.PAGED:
        log.info(
            "dispatch_create_idempotent_skip",
            dispatch_id=dispatch_id,
            current_status=existing["status"].value,
        )
        return DispatchState(
            dispatch_id=dispatch_id,
            incident_id=existing.get("incident_id"),
            venue_id=existing.get("venue_id"),
            responder_id=existing.get("responder_id"),
            status=existing["status"],
            last_updated_at=existing.get("last_updated_at", datetime.now(UTC)),
        )
    already_paged = bool(existing and existing.get("status") == DispatchStatus.PAGED)

    state = await _record(
        dispatch_id,
        DispatchStatus.PAGED,
        incident_id=req.incident_id,
        venue_id=req.venue_id,
        responder_id=req.responder_id,
        extra={
            "role": req.role,
            "rationale": req.rationale,
            "paged_at": req.paged_at or datetime.now(UTC),
            "escalation_chain": req.escalation_chain,
        },
    )
    if not already_paged:
        _arm_timeout(dispatch_id)

        title = f"Aegis · {req.severity} {req.category}"
        body = req.rationale or f"Incident {req.incident_id} needs your attention."

        # Merge tokens passed inline (from orchestrator's dispatch_event payload)
        # with tokens fetched live from Firestore /users/{uid}/devices.
        # Firestore is the authoritative source; inline tokens are a fallback
        # for cases where the orchestrator has pre-fetched them.
        firestore_tokens = await get_fcm_tokens_for_responder(req.responder_id)
        all_tokens = list({*req.fcm_tokens, *firestore_tokens})

        if all_tokens:
            # FCM Admin SDK is sync HTTP. Hand off to a worker thread so the
            # endpoint does not block the event loop for ~300ms per token.
            await asyncio.to_thread(
                send_to_tokens,
                all_tokens,
                title=title,
                body=body,
                data={
                    "dispatch_id": dispatch_id,
                    "incident_id": req.incident_id,
                    "venue_id": req.venue_id,
                    "severity": req.severity,
                    "category": req.category,
                    "zone_id": req.zone_id,
                    "deep_link": f"aegis://incident/{req.incident_id}",
                },
            )
    return state


@app.post("/v1/dispatches", response_model=DispatchState)
async def create_dispatch(
    req: CreateDispatch,
    _: Principal = Depends(verify_request),
) -> DispatchState:
    """Create a dispatch and send push. Authenticated; idempotent under at-least-once delivery."""
    return await _do_create_dispatch(req)


@app.post("/v1/dispatches/{dispatch_id}/ack", response_model=DispatchState)
async def ack(dispatch_id: str, _: Principal = Depends(verify_request)) -> DispatchState:
    _cancel_timeout(dispatch_id)
    return await _record(dispatch_id, DispatchStatus.ACKNOWLEDGED)


@app.post("/v1/dispatches/{dispatch_id}/enroute", response_model=DispatchState)
async def enroute(dispatch_id: str, _: Principal = Depends(verify_request)) -> DispatchState:
    _cancel_timeout(dispatch_id)
    return await _record(dispatch_id, DispatchStatus.EN_ROUTE)


@app.post("/v1/dispatches/{dispatch_id}/arrived", response_model=DispatchState)
async def arrived(dispatch_id: str, _: Principal = Depends(verify_request)) -> DispatchState:
    _cancel_timeout(dispatch_id)
    state = await _record(dispatch_id, DispatchStatus.ARRIVED)
    if state.incident_id:
        # Promote the parent incident to ON_SCENE so the dashboard reflects
        # that a responder has physically reached the location.
        await update_incident_status(state.incident_id, IncidentStatus.ON_SCENE.value)
    return state


@app.post("/v1/dispatches/{dispatch_id}/handoff", response_model=DispatchState)
async def handoff(dispatch_id: str, _: Principal = Depends(verify_request)) -> DispatchState:
    _cancel_timeout(dispatch_id)
    return await _record(dispatch_id, DispatchStatus.HANDED_OFF)


@app.post("/v1/dispatches/{dispatch_id}/decline", response_model=DispatchState)
async def decline(dispatch_id: str, _: Principal = Depends(verify_request)) -> DispatchState:
    _cancel_timeout(dispatch_id)
    # Read before recording so we have the chain regardless of Firestore merge timing.
    persisted = await get_dispatch_by_id(dispatch_id)
    state = await _record(dispatch_id, DispatchStatus.DECLINED)
    if persisted:
        await _page_next_in_chain(persisted)
    return state


@app.get("/v1/dispatches/{dispatch_id}", response_model=DispatchState)
async def get_dispatch(dispatch_id: str, _: Principal = Depends(verify_request)) -> DispatchState:
    persisted = await get_dispatch_by_id(dispatch_id)
    if not persisted:
        raise HTTPException(status_code=404, detail="dispatch not found")
    entry = _hydrate_dispatch_entry(persisted)
    # Re-arm ACK timeout on any instance that reads a still-PAGED dispatch —
    # ensures enforcement survives instance restarts.
    if entry["status"] == DispatchStatus.PAGED:
        _arm_timeout(dispatch_id)
    return DispatchState(
        dispatch_id=dispatch_id,
        incident_id=entry.get("incident_id"),
        venue_id=entry.get("venue_id"),
        responder_id=entry.get("responder_id"),
        status=entry["status"],
        last_updated_at=entry["last_updated_at"],
    )


def _hydrate_dispatch_entry(data: dict[str, Any]) -> dict[str, Any]:
    raw_status = data.get("status", DispatchStatus.PAGED.value)
    try:
        status = DispatchStatus(raw_status)
    except ValueError:
        log.warning(
            "dispatch_unknown_status_in_firestore",
            dispatch_id=data.get("dispatch_id"),
            raw_status=raw_status,
        )
        status = DispatchStatus.PAGED
    paged_at = data.get("paged_at")
    return {
        "dispatch_id": data["dispatch_id"],
        "incident_id": data.get("incident_id"),
        "venue_id": data.get("venue_id"),
        "responder_id": data.get("responder_id"),
        "role": data.get("role", "Responder"),
        "rationale": data.get("notes", ""),
        "status": status,
        "paged_at": _coerce_datetime(paged_at) if paged_at else None,
        "last_updated_at": _latest_dispatch_timestamp(data),
        "escalation_chain": data.get("escalation_chain", []),
    }


def _latest_dispatch_timestamp(data: dict[str, Any]) -> datetime:
    for key in (
        "handed_off_at",
        "arrived_at",
        "en_route_at",
        "acknowledged_at",
        "paged_at",
    ):
        value = data.get(key)
        if value:
            return _coerce_datetime(value)
    return datetime.now(UTC)


def _coerce_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value
    if hasattr(value, "to_datetime"):
        return value.to_datetime()
    if hasattr(value, "ToDatetime"):
        return value.ToDatetime()
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return datetime.now(UTC)
    return datetime.now(UTC)


# ---------- Pub/Sub push subscriber ----------


@app.post("/pubsub/dispatch-events")
async def pubsub_dispatch_events(envelope: PubSubEnvelope) -> dict[str, str]:
    """Push endpoint for ``dispatch-events``.

    Expected payload (JSON) matches ``DispatchEvent`` with ``to_status=PAGED`` and
    a ``payload`` dict containing responder_id, role, severity, category, zone_id,
    rationale, and an optional ``fcm_tokens`` array.
    """
    if not envelope.message.data:
        raise HTTPException(status_code=400, detail="empty message")
    try:
        raw = base64.b64decode(envelope.message.data).decode("utf-8")
        payload = json.loads(raw)
    except (ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail="invalid payload") from exc

    if payload.get("to_status") != DispatchStatus.PAGED.value:
        # Non-paging events are observed elsewhere; ack quietly.
        return {"ack": "true"}

    data = payload.get("payload", {})
    paged_at: datetime | None = None
    event_time = payload.get("event_time")
    if isinstance(event_time, str):
        try:
            paged_at = datetime.fromisoformat(event_time.replace("Z", "+00:00"))
        except ValueError:
            paged_at = None
    await _do_create_dispatch(
        CreateDispatch(
            dispatch_id=payload["dispatch_id"],
            incident_id=payload["incident_id"],
            venue_id=payload["venue_id"],
            responder_id=data.get("responder_id", "unknown"),
            role=data.get("role", "Responder"),
            severity=data.get("severity", "S2"),
            category=data.get("category", "OTHER"),
            zone_id=data.get("zone_id", ""),
            rationale=data.get("rationale", ""),
            fcm_tokens=data.get("fcm_tokens", []),
            escalation_chain=data.get("escalation_chain", []),
            paged_at=paged_at,
        )
    )
    return {"ack": "true"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8004, reload=True)  # noqa: S104

"""Orchestrator service.

HTTP wrapper around ``agents.orchestrator.OrchestratorAgent``.

Endpoints:
    GET  /health
    POST /v1/handle                 accept ONE perceptual signal (legacy shape)
    POST /v1/handle-batch           accept a batch of signals + responders
    POST /pubsub/perceptual-signals Pub/Sub push subscriber

Every handled incident produces:
    - Audit events on every transition (append-only hash chain via aegis_shared.audit)
    - Firestore writes on incidents, events, dispatches (so UIs subscribe)
    - Pub/Sub publishes to ``incident-events`` and ``dispatch-events``
    - Best-effort responder fetch from Firestore; falls back to a baked-in demo
      roster so Phase 1 demo flows still work before onboarding.
"""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from aegis_shared import get_settings, setup_logging
from aegis_shared.errors import AegisError
from aegis_shared.firestore import (
    append_incident_event,
    get_responders_for_venue,
    upsert_dispatch,
    upsert_incident,
)
from aegis_shared.logger import get_logger
from aegis_shared.pubsub import publish_json
from aegis_shared.schemas import (
    Dispatch,
    DispatchEvent,
    DispatchStatus,
    IncidentEvent,
    IncidentStatus,
    PerceptualSignal,
    PubSubEnvelope,
    ResponderSkill,
    new_id,
)
from aegis_shared.security import apply_security_middleware
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from agents.dispatcher.agent import ResponderRecord, _derive_required_skills
from agents.orchestrator.agent import (
    OrchestratorAgent,
    OrchestratorInput,
    OrchestratorOutput,
)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    setup_logging("orchestrator")
    log = get_logger(__name__)
    log.info(
        "orchestrator_service_started",
        project=get_settings().gcp_project_id,
    )
    yield
    log.info("orchestrator_service_stopped")


app = FastAPI(
    title="Aegis Orchestrator",
    version="0.1.0",
    description="Agentic orchestration for incident detection and response.",
    lifespan=lifespan,
)

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


# Initialise at import time so ``TestClient(app)`` without a context manager
# still finds the agent. The agent is cheap to construct.
app.state.agent = OrchestratorAgent()


# ---- Request / response shapes ----


class HandleBatchRequest(BaseModel):
    venue_id: str
    zone_id: str
    signals: list[PerceptualSignal] = Field(default_factory=list)
    responders: list[dict[str, Any]] | None = None
    venue_context: dict[str, Any] = Field(default_factory=dict)
    language_preferences: list[str] = Field(default_factory=list)
    drill_mode: bool = Field(
        default=False,
        description=(
            "Convenience flag; merged into venue_context.drill_mode. When true "
            "no authority webhook fires and every audit row is tagged as drill."
        ),
    )


class HandleResponse(BaseModel):
    result: OrchestratorOutput
    dispatched: bool
    reasoning: str


# ---- Demo roster (used if Firestore has no responders for this venue) ----

DEMO_RESPONDERS: list[ResponderRecord] = [
    ResponderRecord(
        responder_id="RSP-priya",
        display_name="Priya Iyer",
        role="Duty Manager",
        skills=[ResponderSkill.FIRE_WARDEN, ResponderSkill.FIRST_AID, ResponderSkill.EVACUATION],
        languages=["hi", "en", "gu"],
        distance_m=18,
        workload=0,
        fcm_tokens=[],
    ),
    ResponderRecord(
        responder_id="RSP-john",
        display_name="John Mathew",
        role="Fire Warden",
        skills=[ResponderSkill.FIRE_WARDEN, ResponderSkill.EVACUATION],
        languages=["en", "ml"],
        distance_m=40,
        workload=0,
        fcm_tokens=[],
    ),
    ResponderRecord(
        responder_id="RSP-kavya",
        display_name="Dr. Kavya Rao",
        role="On-Call Doctor",
        skills=[ResponderSkill.BLS, ResponderSkill.ACLS, ResponderSkill.FIRST_AID],
        languages=["en", "hi", "kn"],
        distance_m=220,
        workload=0,
        fcm_tokens=[],
    ),
    ResponderRecord(
        responder_id="RSP-arjun",
        display_name="Arjun Shah",
        role="Security Lead",
        skills=[ResponderSkill.SECURITY, ResponderSkill.EVACUATION],
        languages=["hi", "gu", "en"],
        distance_m=60,
        workload=0,
        fcm_tokens=[],
    ),
]


def _record_from_doc(doc: dict[str, Any]) -> ResponderRecord:
    return ResponderRecord(
        responder_id=doc.get("responder_id") or doc.get("id") or new_id("RSP"),
        display_name=doc.get("display_name") or doc.get("name", "Responder"),
        role=doc.get("role", "Responder"),
        skills=[ResponderSkill(s) for s in doc.get("skills", [])],
        languages=doc.get("languages", ["en"]),
        on_shift=bool(doc.get("on_shift", True)),
        credential_valid=bool(doc.get("credential_valid", True)),
        distance_m=float(doc.get("distance_m", 100)),
        workload=int(doc.get("workload", 0)),
        fcm_tokens=doc.get("fcm_tokens", []),
    )


async def _resolve_responders(
    venue_id: str, override: list[dict[str, Any]] | None
) -> list[ResponderRecord]:
    if override:
        return [_record_from_doc(d) for d in override]
    docs = await get_responders_for_venue(venue_id)
    if docs:
        return [_record_from_doc(d) for d in docs]
    return DEMO_RESPONDERS


# ---- Routes ----


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "orchestrator"}


@app.post("/v1/handle", response_model=HandleResponse)
async def handle_signal(signal: PerceptualSignal) -> HandleResponse:
    """Back-compat endpoint: a single signal, demo roster."""
    batch = HandleBatchRequest(
        venue_id=signal.venue_id,
        zone_id=signal.zone_id,
        signals=[signal],
    )
    return await handle_batch(batch)


@app.post("/v1/handle-batch", response_model=HandleResponse)
async def handle_batch(req: HandleBatchRequest) -> HandleResponse:
    settings = get_settings()
    if not req.signals:
        raise HTTPException(status_code=400, detail="no signals supplied")

    responders = await _resolve_responders(req.venue_id, req.responders)

    # Merge the top-level drill_mode flag into venue_context for convenience.
    venue_context = {**req.venue_context}
    if req.drill_mode:
        venue_context["drill_mode"] = True

    agent: OrchestratorAgent = app.state.agent
    result = await agent.run(
        OrchestratorInput(
            signals=req.signals,
            venue_id=req.venue_id,
            zone_id=req.zone_id,
            responders=responders,
            venue_context=venue_context,
            language_preferences=req.language_preferences,
        )
    )

    incident = result.incident
    classification = result.classification

    # Firestore: incident + classified event
    await upsert_incident(incident)
    classified_event = IncidentEvent(
        venue_id=incident.venue_id,
        incident_id=incident.incident_id,
        from_status=IncidentStatus.DETECTED,
        to_status=IncidentStatus.CLASSIFIED,
        actor_type="agent",
        actor_id="orchestrator",
        payload={
            "classification": classification.model_dump(mode="json"),
            "agent_trace": result.agent_trace,
        },
    )
    await append_incident_event(incident.incident_id, classified_event)

    # Pub/Sub: incident classified
    publish_json(
        settings.pubsub_topic_incidents,
        classified_event,
        ordering_key=f"{incident.venue_id}:{incident.incident_id}",
        attributes={
            "venue_id": incident.venue_id,
            "incident_id": incident.incident_id,
            "to_status": classified_event.to_status.value,
        },
    )

    # Materialise dispatches + publish
    # SAFETY GATE: S1 incidents in non-autonomous mode require operator approval.
    # We still return the advisory plan but skip materialising real pages.
    dispatched = False
    required_skills = _derive_required_skills(classification, [])
    if result.s1_hitl_gated:
        log_gate = get_logger(__name__)
        log_gate.warning(
            "s1_dispatch_gated",
            incident_id=incident.incident_id,
            venue_id=incident.venue_id,
            reason="autonomous_mode=false; advisory only",
        )
    else:
        for entry in result.dispatch.dispatched:
            dispatch = Dispatch(
                venue_id=incident.venue_id,
                incident_id=incident.incident_id,
                responder_id=entry.responder_id,
                role=entry.role,
                status=DispatchStatus.PAGED,
                required_skills=required_skills,
                notes=entry.rationale,
            )
            await upsert_dispatch(dispatch)

            dispatch_event = DispatchEvent(
                venue_id=incident.venue_id,
                incident_id=incident.incident_id,
                dispatch_id=dispatch.dispatch_id,
                to_status=DispatchStatus.PAGED,
                payload={
                    "responder_id": entry.responder_id,
                    "role": entry.role,
                    "score": entry.score,
                    "eta_seconds": entry.eta_seconds,
                    "severity": classification.severity.value,
                    "category": classification.category.value,
                    "zone_id": incident.zone_id,
                    "rationale": entry.rationale,
                    "drill": result.drill_mode,
                },
            )
            publish_json(
                settings.pubsub_topic_dispatch,
                dispatch_event,
                ordering_key=f"{incident.venue_id}:{incident.incident_id}",
                attributes={
                    "venue_id": incident.venue_id,
                    "incident_id": incident.incident_id,
                    "dispatch_id": dispatch.dispatch_id,
                },
            )
            dispatched = True

    reasoning = classification.rationale
    if result.cascade.rationale:
        reasoning = f"{reasoning} Cascade: {result.cascade.rationale}"
    if result.s1_hitl_gated:
        reasoning = (
            f"{reasoning} [Advisory only — S1 incident, autonomous_mode=false; "
            f"awaiting operator approval to dispatch.]"
        )

    log = get_logger(__name__)
    log.info(
        "orchestrator_handled",
        incident_id=incident.incident_id,
        venue_id=incident.venue_id,
        severity=classification.severity.value,
        dispatched=dispatched,
    )

    return HandleResponse(result=result, dispatched=dispatched, reasoning=reasoning)


# ---- Pub/Sub push subscriber ----


@app.post("/pubsub/perceptual-signals")
async def pubsub_perceptual(envelope: PubSubEnvelope) -> dict[str, str]:
    """Push endpoint for the perceptual-signals topic (production path)."""
    if not envelope.message.data:
        raise HTTPException(status_code=400, detail="empty message")
    try:
        raw = base64.b64decode(envelope.message.data).decode("utf-8")
        payload = json.loads(raw)
    except (ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail="invalid payload") from exc

    signal = PerceptualSignal.model_validate(payload)
    batch = HandleBatchRequest(
        venue_id=signal.venue_id,
        zone_id=signal.zone_id,
        signals=[signal],
    )
    await handle_batch(batch)
    return {"ack": "true"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8003, reload=True)  # noqa: S104

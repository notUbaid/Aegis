"""Core Pydantic schemas for Aegis events and entities.

These models define the wire format for every Pub/Sub topic and the shape of
every Firestore document. Service contracts are tested against these.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field


def utc_now() -> datetime:
    return datetime.now(UTC)


def new_id(prefix: str) -> str:
    """Generate a prefixed ID like 'INC-7741abcd'."""
    return f"{prefix}-{uuid4().hex[:8]}"


# ===== Enums =====


class IncidentCategory(StrEnum):
    FIRE = "FIRE"
    MEDICAL = "MEDICAL"
    STAMPEDE = "STAMPEDE"
    VIOLENCE = "VIOLENCE"
    SUSPICIOUS = "SUSPICIOUS"
    OTHER = "OTHER"


class Severity(StrEnum):
    S1_CRITICAL = "S1"
    S2_URGENT = "S2"
    S3_MONITOR = "S3"
    S4_NUISANCE = "S4"


class IncidentStatus(StrEnum):
    DETECTED = "DETECTED"
    CLASSIFIED = "CLASSIFIED"
    DISPATCHED = "DISPATCHED"
    ACKNOWLEDGED = "ACKNOWLEDGED"
    EN_ROUTE = "EN_ROUTE"
    ON_SCENE = "ON_SCENE"
    TRIAGED = "TRIAGED"
    RESOLVING = "RESOLVING"
    VERIFIED = "VERIFIED"
    CLOSED = "CLOSED"
    DISMISSED = "DISMISSED"
    NOTE = "NOTE"  # operator annotation, not a status transition


class SignalModality(StrEnum):
    VISION = "VISION"
    SENSOR = "SENSOR"
    PHONE = "PHONE"
    MANUAL = "MANUAL"


# ===== Geo =====


class GeoPoint(BaseModel):
    model_config = ConfigDict(frozen=True)
    lat: Annotated[float, Field(ge=-90, le=90)]
    lng: Annotated[float, Field(ge=-180, le=180)]


class ZoneRef(BaseModel):
    venue_id: str
    zone_id: str


# ===== Perceptual signal (from Vision / Audio / Fusion → Orchestrator) =====


class BoundingBox(BaseModel):
    """Normalised region of interest (0..1 fractions of the frame)."""

    x: Annotated[float, Field(ge=0, le=1)]
    y: Annotated[float, Field(ge=0, le=1)]
    w: Annotated[float, Field(ge=0, le=1)]
    h: Annotated[float, Field(ge=0, le=1)]
    label: str = ""


class VisionEvidence(BaseModel):
    """Structured evidence extracted by the Vision classifier."""

    flame_visible: bool = False
    smoke_density: float | None = None
    people_count_estimate: int | None = None
    distress_posture_detected: bool = False
    weapon_visible: bool = False
    regions_of_interest: list[BoundingBox] = Field(default_factory=list)


class VisionClassification(BaseModel):
    """Output schema enforced on the Gemini Vision classifier."""

    category: IncidentCategory
    sub_type: str | None = None
    confidence: Annotated[float, Field(ge=0, le=1)]
    evidence: VisionEvidence = Field(default_factory=VisionEvidence)
    rationale: str = ""


class PerceptualSignal(BaseModel):
    """Output of the perception layer for one observation window."""

    signal_id: str = Field(default_factory=lambda: new_id("SIG"))
    venue_id: str
    zone_id: str
    modality: SignalModality
    detected_at: datetime = Field(default_factory=utc_now)
    category_hint: IncidentCategory | None = None
    confidence: Annotated[float, Field(ge=0, le=1)] = 0.0
    evidence_uri: str | None = None  # gs://... pointing to redacted frame/clip
    vision: VisionClassification | None = None
    raw: dict[str, object] = Field(default_factory=dict)


# ===== Incident =====


class CascadePrediction(BaseModel):
    horizon_seconds: int
    outcome: str
    probability: Annotated[float, Field(ge=0, le=1)]


class IncidentClassification(BaseModel):
    category: IncidentCategory
    sub_type: str | None = None
    severity: Severity
    confidence: Annotated[float, Field(ge=0, le=1)]
    rationale: str = ""
    cascade_predictions: list[CascadePrediction] = Field(default_factory=list)


class Incident(BaseModel):
    incident_id: str = Field(default_factory=lambda: new_id("INC"))
    venue_id: str
    zone_id: str
    status: IncidentStatus = IncidentStatus.DETECTED
    classification: IncidentClassification | None = None
    detected_at: datetime = Field(default_factory=utc_now)
    resolved_at: datetime | None = None
    summary: str = ""
    agent_trace_id: str | None = None
    s1_hitl_gated: bool = False
    advisory_dispatch_plan: dict[str, object] | None = None


class IncidentEvent(BaseModel):
    """A state transition on an incident, emitted to `incident-events`."""

    event_id: str = Field(default_factory=lambda: new_id("EVT"))
    event_time: datetime = Field(default_factory=utc_now)
    venue_id: str
    incident_id: str
    from_status: IncidentStatus | None = None
    to_status: IncidentStatus
    actor_type: Literal["agent", "human", "system"]
    actor_id: str
    payload: dict[str, object] = Field(default_factory=dict)


# ===== Dispatch =====


class ResponderSkill(StrEnum):
    FIRST_AID = "FIRST_AID"
    BLS = "BLS"  # Basic Life Support
    ACLS = "ACLS"  # Advanced Cardiac Life Support
    FIRE_WARDEN = "FIRE_WARDEN"
    SECURITY = "SECURITY"
    EVACUATION = "EVACUATION"


class DispatchStatus(StrEnum):
    PAGED = "PAGED"
    ACKNOWLEDGED = "ACKNOWLEDGED"
    DECLINED = "DECLINED"
    EN_ROUTE = "EN_ROUTE"
    ARRIVED = "ARRIVED"
    HANDED_OFF = "HANDED_OFF"
    TIMED_OUT = "TIMED_OUT"


class EscalationEntry(BaseModel):
    """One rung of the backup paging ladder stored inside a Dispatch doc."""

    responder_id: str
    role: str
    rationale: str = ""


class Dispatch(BaseModel):
    dispatch_id: str = Field(default_factory=lambda: new_id("DSP"))
    venue_id: str
    incident_id: str
    responder_id: str
    role: str
    status: DispatchStatus = DispatchStatus.PAGED
    paged_at: datetime = Field(default_factory=utc_now)
    acknowledged_at: datetime | None = None
    en_route_at: datetime | None = None
    arrived_at: datetime | None = None
    handed_off_at: datetime | None = None
    required_skills: list[ResponderSkill] = Field(default_factory=list)
    notes: str = ""
    escalation_chain: list[EscalationEntry] = Field(default_factory=list)


class DispatchEvent(BaseModel):
    """Emitted on `dispatch-events` when a dispatch changes state."""

    event_id: str = Field(default_factory=lambda: new_id("DEV"))
    event_time: datetime = Field(default_factory=utc_now)
    venue_id: str
    incident_id: str
    dispatch_id: str
    to_status: DispatchStatus
    payload: dict[str, object] = Field(default_factory=dict)


# ===== Audit =====


class PubSubMessage(BaseModel):
    """Inner ``message`` field of a Pub/Sub push delivery envelope.

    Pub/Sub pushes camelCase JSON (``messageId``); we accept both casings via
    Pydantic's alias generator so callers can pick whichever shape fits.
    """

    model_config = ConfigDict(populate_by_name=True)

    data: str | None = None
    attributes: dict[str, str] | None = None
    message_id: str | None = Field(default=None, alias="messageId")


class PubSubEnvelope(BaseModel):
    """Outer envelope for Pub/Sub push delivery."""

    message: PubSubMessage
    subscription: str | None = None


class AuditEvent(BaseModel):
    """A single append-only audit row (also published to `audit-events`)."""

    event_id: str = Field(default_factory=lambda: new_id("AUD"))
    event_time: datetime = Field(default_factory=utc_now)
    venue_id: str
    incident_id: str | None = None
    actor_type: Literal["agent", "human", "system"]
    actor_id: str
    action: str
    input_hash: str | None = None
    output_hash: str | None = None
    prev_hash: str | None = None
    row_hash: str | None = None  # SHA-256 over above fields (computed by audit svc)
    model_version: str | None = None
    confidence: float | None = None
    explanation: str = ""
    extra: dict[str, object] = Field(default_factory=dict)

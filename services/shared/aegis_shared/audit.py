"""Append-only audit log with SHA-256 hash chain.

Every action Aegis takes — classifier call, agent decision, dispatch, human
override — is recorded here. Two sinks, both written in every call:

    1. **BigQuery** (primary, production) — partitioned by ``DATE(event_time)``,
       clustered by ``venue_id, incident_id``. Structured streaming insert.
    2. **Local JSONL** (fallback, dev) — one line per event under
       ``./.audit/aegis_audit.jsonl``. Used in emulator-only / CI runs when
       BigQuery credentials are absent.

Every row carries:

    event_id, event_time, venue_id, incident_id, actor_type, actor_id,
    action, input_hash, output_hash, prev_hash, row_hash, model_version,
    confidence, explanation, extra

where ``prev_hash`` links to the previous row for the same incident and
``row_hash`` is SHA-256 over the row's fields concatenated with ``prev_hash``.
A daily integrity job (Phase 2) re-walks the chain and alerts on break.

The writer is **thread-safe** via a single async lock so row hashes remain
monotonic per-incident even under concurrent writes.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any

from aegis_shared.config import get_settings
from aegis_shared.logger import get_logger
from aegis_shared.schemas import AuditEvent

log = get_logger(__name__)

_LOCK = asyncio.Lock()
_PREV_HASH_BY_INCIDENT: dict[str, str] = {}


def _serialise_for_hash(event: AuditEvent) -> str:
    """Canonical string used for the row hash pre-image."""
    core = {
        "event_id": event.event_id,
        "event_time": event.event_time.isoformat(),
        "venue_id": event.venue_id,
        "incident_id": event.incident_id,
        "actor_type": event.actor_type,
        "actor_id": event.actor_id,
        "action": event.action,
        "input_hash": event.input_hash,
        "output_hash": event.output_hash,
        "model_version": event.model_version,
        "confidence": event.confidence,
        "explanation": event.explanation,
        "extra": event.extra,
        "prev_hash": event.prev_hash,
    }
    return json.dumps(core, sort_keys=True, default=str)


def _compute_row_hash(event: AuditEvent) -> str:
    pre = _serialise_for_hash(event)
    return hashlib.sha256(pre.encode("utf-8")).hexdigest()


def hash_object(obj: Any) -> str:
    """Stable short hash for an arbitrary JSON-serialisable object."""
    if isinstance(obj, bytes):
        return hashlib.sha256(obj).hexdigest()[:16]
    payload = json.dumps(obj, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


# ---------- Sinks ----------


def _local_audit_path() -> Path:
    root = Path.cwd() / ".audit"
    root.mkdir(parents=True, exist_ok=True)
    return root / "aegis_audit.jsonl"


def _write_jsonl(event: AuditEvent) -> None:
    line = event.model_dump_json() + "\n"
    with _local_audit_path().open("a", encoding="utf-8") as fp:
        fp.write(line)


@lru_cache(maxsize=1)
def _bq_client() -> Any | None:
    """Return a BigQuery client, or ``None`` if unavailable.

    We intentionally don't raise on missing creds — the JSONL sink keeps us
    running in local dev, and prod deploys will have ADC.
    """
    settings = get_settings()
    try:
        from google.cloud import bigquery  # type: ignore[import-untyped]

        return bigquery.Client(project=settings.gcp_project_id)
    except Exception as exc:
        log.warning("audit_bq_client_unavailable", error=str(exc))
        return None


def _bq_table_id() -> str:
    settings = get_settings()
    return f"{settings.gcp_project_id}.{settings.bq_dataset_audit}.events"


def _write_bigquery(event: AuditEvent) -> None:
    client = _bq_client()
    if client is None:
        return
    row = event.model_dump(mode="json")
    # BigQuery streaming insert expects a list of dicts.
    errors = client.insert_rows_json(_bq_table_id(), [row])
    if errors:
        log.warning("audit_bq_insert_errors", errors=errors)


# ---------- Public API ----------


async def write_audit(
    *,
    venue_id: str,
    action: str,
    actor_type: str = "agent",
    actor_id: str = "orchestrator",
    incident_id: str | None = None,
    input_obj: Any | None = None,
    output_obj: Any | None = None,
    model_version: str | None = None,
    confidence: float | None = None,
    explanation: str = "",
    extra: dict[str, Any] | None = None,
) -> AuditEvent:
    """Append one audit event to every configured sink and return it.

    The function is async only because it uses an ``asyncio.Lock`` to keep the
    per-incident hash chain strictly monotonic under concurrent writes; the
    underlying BigQuery and file writes are synchronous and non-blocking for
    typical event volumes.
    """
    event = AuditEvent(
        event_time=datetime.now(UTC),
        venue_id=venue_id,
        incident_id=incident_id,
        actor_type=actor_type,
        actor_id=actor_id,
        action=action,
        input_hash=hash_object(input_obj) if input_obj is not None else None,
        output_hash=hash_object(output_obj) if output_obj is not None else None,
        model_version=model_version,
        confidence=confidence,
        explanation=explanation,
        extra=extra or {},
    )
    async with _LOCK:
        chain_key = event.incident_id or f"venue:{event.venue_id}"
        event.prev_hash = _PREV_HASH_BY_INCIDENT.get(chain_key)
        event.row_hash = _compute_row_hash(event)
        _PREV_HASH_BY_INCIDENT[chain_key] = event.row_hash

    try:
        _write_jsonl(event)
    except Exception as exc:
        log.error("audit_jsonl_write_failed", error=str(exc))

    try:
        _write_bigquery(event)
    except Exception as exc:
        log.warning("audit_bq_write_failed", error=str(exc))

    log.info(
        "audit_written",
        event_id=event.event_id,
        incident_id=event.incident_id,
        action=event.action,
        row_hash=event.row_hash[:12] if event.row_hash else None,
    )
    return event


def verify_chain_local() -> tuple[bool, list[str]]:
    """Walk the local JSONL chain and verify each ``row_hash``.

    Returns ``(ok, broken_event_ids)``. Used by the integrity CLI.
    """
    path = _local_audit_path()
    if not path.exists():
        return True, []
    prev_by_incident: dict[str, str] = {}
    broken: list[str] = []
    with path.open("r", encoding="utf-8") as fp:
        for raw_line in fp:
            line = raw_line.strip()
            if not line:
                continue
            event = AuditEvent.model_validate_json(line)
            chain_key = event.incident_id or f"venue:{event.venue_id}"
            expected_prev = prev_by_incident.get(chain_key)
            if event.prev_hash != expected_prev:
                broken.append(event.event_id)
                continue
            recomputed = _compute_row_hash(event.model_copy(update={"row_hash": None}))
            if recomputed != event.row_hash:
                broken.append(event.event_id)
                continue
            prev_by_incident[chain_key] = event.row_hash or ""
    return not broken, broken

"""Pub/Sub publisher + subscriber helpers.

Encapsulates the boilerplate around:
    - Topic paths
    - Ordering keys
    - Message attributes (trace_id, venue_id, etc.)
    - Serialization (JSON via Pydantic)
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from pydantic import BaseModel

from aegis_shared.config import get_settings
from aegis_shared.errors import DownstreamServiceError
from aegis_shared.logger import get_logger

log = get_logger(__name__)


@dataclass
class PublishResult:
    topic: str
    message_id: str


@lru_cache(maxsize=1)
def get_publisher() -> Any:
    """Return a cached Pub/Sub publisher client."""
    from google.cloud import pubsub_v1  # type: ignore[import-untyped,attr-defined]

    settings = get_settings()
    if settings.using_pubsub_emulator:
        log.info("pubsub_using_emulator", host=settings.pubsub_emulator_host)

    return pubsub_v1.PublisherClient()


def topic_path(topic: str) -> str:
    settings = get_settings()
    return f"projects/{settings.gcp_project_id}/topics/{topic}"


def publish_json(
    topic: str,
    payload: BaseModel | dict[str, Any],
    *,
    ordering_key: str | None = None,
    attributes: dict[str, str] | None = None,
) -> PublishResult:
    """Publish a JSON-serialized payload.

    Uses ordering keys when provided, but disables them when running
    against the Pub/Sub emulator (which does not support ordering).
    """
    settings = get_settings()
    publisher = get_publisher()
    path = topic_path(topic)

    # Serialize payload
    if isinstance(payload, BaseModel):
        data = payload.model_dump_json().encode("utf-8")
    else:
        data = json.dumps(payload, default=str).encode("utf-8")

    kwargs: dict[str, Any] = {"data": data}

    if attributes:
        kwargs.update(attributes)

    # ✅ FIX: only use ordering keys when NOT using emulator
    if ordering_key and not settings.using_pubsub_emulator:
        kwargs["ordering_key"] = ordering_key
    elif ordering_key and settings.using_pubsub_emulator:
        log.warning(
            "pubsub_ordering_disabled_in_emulator",
            topic=topic,
            ordering_key=ordering_key,
        )

    try:
        future = publisher.publish(path, **kwargs)
        message_id = future.result(timeout=10)
    except Exception as exc:
        log.error("pubsub_publish_failed", topic=topic, error=str(exc))
        raise DownstreamServiceError(
            f"Failed to publish to {topic}",
            context={"topic": topic},
        ) from exc

    log.info(
        "pubsub_published",
        topic=topic,
        message_id=message_id,
        ordering_key=ordering_key,
    )

    return PublishResult(topic=topic, message_id=message_id)

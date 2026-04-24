"""Seed a venue into Firestore from a JSON config.

Phase 1 path: the blueprint (§87) says "one venue (configured via JSON, no UI
for onboarding yet)". This script reads ``config/venues/<venue_id>.json`` and
writes the top-level venue doc + zones / cameras / sensors / responders
sub-collections.

Run against the emulator (local) or production (after `firebase use`).

Usage::

    # Emulator (no creds needed):
    $env:FIRESTORE_EMULATOR_HOST="127.0.0.1:8080"
    python scripts/seed_venue.py config/venues/taj-ahmedabad.json

    # Production:
    python scripts/seed_venue.py config/venues/taj-ahmedabad.json --prod
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path


async def seed(config_path: Path, prod: bool) -> None:
    if not prod and not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        sys.stderr.write(
            "Refusing to write to production without --prod. "
            "Set FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 for emulator runs.\n"
        )
        sys.exit(2)

    cfg = json.loads(config_path.read_text(encoding="utf-8"))
    venue_id = cfg["venue_id"]

    from aegis_shared.firestore import get_firestore_client

    client = get_firestore_client()
    venue_ref = client.collection("venues").document(venue_id)

    top = {k: v for k, v in cfg.items() if k not in {"zones", "cameras", "sensors", "responders"}}
    await venue_ref.set(top, merge=True)

    async def _batch_write(subcollection: str, items: list[dict], id_key: str) -> None:
        for item in items:
            await venue_ref.collection(subcollection).document(item[id_key]).set(item, merge=True)

    await _batch_write("zones", cfg.get("zones", []), "zone_id")
    await _batch_write("cameras", cfg.get("cameras", []), "camera_id")
    await _batch_write("sensors", cfg.get("sensors", []), "sensor_id")
    await _batch_write("responders", cfg.get("responders", []), "responder_id")

    print(
        f"Seeded venue {venue_id}: {len(cfg.get('zones', []))} zones, "
        f"{len(cfg.get('cameras', []))} cameras, {len(cfg.get('sensors', []))} sensors, "
        f"{len(cfg.get('responders', []))} responders."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path, help="Path to a venue JSON file.")
    parser.add_argument(
        "--prod", action="store_true", help="Write to real Firestore (requires ADC)."
    )
    args = parser.parse_args()

    if not args.config.is_file():
        sys.stderr.write(f"config not found: {args.config}\n")
        sys.exit(2)

    asyncio.run(seed(args.config, args.prod))


if __name__ == "__main__":
    main()

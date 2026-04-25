"use client";

import { getDb, type Incident, type IncidentStatus, type Severity } from "@aegis/ui-web";
import {
  collection,
  doc,
  setDoc,
  serverTimestamp,
} from "firebase/firestore";

const DISPATCH_BASE = process.env.NEXT_PUBLIC_DISPATCH_URL || "http://localhost:8004";
const ORCH_BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "http://localhost:8003";
const VISION_BASE = process.env.NEXT_PUBLIC_VISION_URL || "http://localhost:8002";
const INGEST_BASE = process.env.NEXT_PUBLIC_INGEST_URL || "http://localhost:8001";

const SERVICE_BASES = {
  ingest: INGEST_BASE,
  vision: VISION_BASE,
  orchestrator: ORCH_BASE,
  dispatch: DISPATCH_BASE,
} as const;
export type ServiceName = keyof typeof SERVICE_BASES;

// ── Firestore helpers ─────────────────────────────────────────────────────
async function appendIncidentEvent(
  incidentId: string,
  toStatus: IncidentStatus,
  fromStatus: IncidentStatus | null,
  actorId: string,
  payload: Record<string, unknown> = {},
) {
  const db = getDb();
  const eventsCol = collection(db, "incidents", incidentId, "events");
  const eventId = `op-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await setDoc(doc(eventsCol, eventId), {
    event_id: eventId,
    event_time: new Date().toISOString(),
    venue_id: "taj-ahmedabad",
    incident_id: incidentId,
    from_status: fromStatus,
    to_status: toStatus,
    actor_type: "operator",
    actor_id: actorId,
    payload,
    created_at: serverTimestamp(),
  });
}

async function patchIncidentStatus(
  incident: Incident,
  next: IncidentStatus,
  actorId: string,
  payload: Record<string, unknown> = {},
) {
  const db = getDb();
  const update: Partial<Incident> & { resolved_at?: string } = { status: next };
  if (next === "CLOSED" || next === "DISMISSED") {
    update.resolved_at = new Date().toISOString();
  }
  await setDoc(doc(db, "incidents", incident.incident_id), update, { merge: true });
  await appendIncidentEvent(incident.incident_id, next, incident.status, actorId, payload);
}

// ── Incident state mutations ──────────────────────────────────────────────
export async function acknowledgeIncident(incident: Incident, actor = "operator-w") {
  await patchIncidentStatus(incident, "ACKNOWLEDGED", actor);
}

export async function dismissIncident(incident: Incident, actor = "operator-w") {
  await patchIncidentStatus(incident, "DISMISSED", actor, { reason: "false_positive" });
}

export async function resolveIncident(incident: Incident, actor = "operator-w") {
  await patchIncidentStatus(incident, "CLOSED", actor);
}

export async function escalateIncident(
  incident: Incident,
  authorities: string[],
  actor = "operator-w",
) {
  await patchIncidentStatus(incident, "DISPATCHED", actor, {
    escalated: true,
    authorities,
    sendai_packet: true,
  });
}

export async function addOperatorNote(incidentId: string, text: string, actor = "operator-w") {
  const db = getDb();
  const eventsCol = collection(db, "incidents", incidentId, "events");
  const eventId = `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await setDoc(doc(eventsCol, eventId), {
    event_id: eventId,
    event_time: new Date().toISOString(),
    venue_id: "taj-ahmedabad",
    incident_id: incidentId,
    to_status: "NOTE",
    actor_type: "operator",
    actor_id: actor,
    payload: { note: text },
    created_at: serverTimestamp(),
  });
}

// ── Dispatch API calls ────────────────────────────────────────────────────
export type DispatchAction = "ack" | "enroute" | "arrived" | "handoff" | "decline";

export async function callDispatch(dispatchId: string, action: DispatchAction): Promise<void> {
  const res = await fetch(`${DISPATCH_BASE}/v1/dispatches/${dispatchId}/${action}`, {
    method: "POST",
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`dispatch ${action} failed: ${res.status} ${txt}`);
  }
}

export interface PageRequest {
  incident_id: string;
  venue_id: string;
  responder_id: string;
  role: string;
  severity: Severity;
  category: string;
  zone_id: string;
  rationale: string;
}

export async function pageResponder(req: PageRequest): Promise<{ dispatch_id: string }> {
  const res = await fetch(`${DISPATCH_BASE}/v1/dispatches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...req, fcm_tokens: [] }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`page responder failed: ${res.status} ${txt}`);
  }
  return (await res.json()) as { dispatch_id: string };
}

// ── Health checks ─────────────────────────────────────────────────────────
export async function checkHealth(svc: ServiceName, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(`${SERVICE_BASES[svc]}/health`, { signal, cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function checkAllHealth(): Promise<Record<ServiceName, boolean>> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 3500);
  try {
    const entries = await Promise.all(
      (Object.keys(SERVICE_BASES) as ServiceName[]).map(async (name) => {
        const ok = await checkHealth(name, ctrl.signal);
        return [name, ok] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<ServiceName, boolean>;
  } finally {
    clearTimeout(timeout);
  }
}

export const SERVICE_PORTS: Record<ServiceName, number> = {
  ingest: 8001,
  vision: 8002,
  orchestrator: 8003,
  dispatch: 8004,
};

// ── Drill: full pipeline ──────────────────────────────────────────────────
export interface DrillStep {
  label: string;
  status: "pending" | "running" | "ok" | "error";
  detail?: string;
}

export async function runDrill(
  venueId: string,
  zoneId: string,
  onStep: (i: number, patch: Partial<DrillStep>) => void,
): Promise<{ ok: boolean }> {
  // Step 1: ingest
  onStep(0, { status: "running" });
  const frame = await loadDemoFrame();
  const blob = new Blob([new Uint8Array(frame)], { type: "image/jpeg" });
  const form = new FormData();
  form.append("venue_id", venueId);
  form.append("camera_id", "demo-cam");
  form.append("zone_id", zoneId);
  form.append("frame", blob, "demo.jpg");
  const ingest = await fetch(`${INGEST_BASE}/v1/frames`, { method: "POST", body: form });
  if (!ingest.ok) {
    onStep(0, { status: "error", detail: `ingest ${ingest.status}` });
    return { ok: false };
  }
  onStep(0, { status: "ok", detail: "frame accepted" });

  // Step 2: vision
  onStep(1, { status: "running" });
  const b64 = await blobToBase64(blob);
  const visRes = await fetch(`${VISION_BASE}/v1/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      venue_id: venueId,
      camera_id: "demo-cam",
      zone_id: zoneId,
      frame_base64: b64,
      publish: false,
    }),
  });
  if (!visRes.ok) {
    onStep(1, { status: "error", detail: `vision ${visRes.status}` });
    return { ok: false };
  }
  const vis = await visRes.json();
  onStep(1, {
    status: "ok",
    detail: `${vis.signal.category_hint} · conf ${Math.round(vis.signal.confidence * 100)}% · ${
      vis.used_gemini ? "Gemini" : "fallback"
    }`,
  });

  // Step 3: orchestrator
  onStep(2, { status: "running" });
  const orchRes = await fetch(`${ORCH_BASE}/v1/handle-batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      venue_id: venueId,
      zone_id: zoneId,
      signals: [vis.signal],
      drill_mode: true,
    }),
  });
  if (!orchRes.ok) {
    onStep(2, { status: "error", detail: `orchestrator ${orchRes.status}` });
    return { ok: false };
  }
  const orch = await orchRes.json();
  onStep(2, {
    status: "ok",
    detail: `${orch.result?.incident?.incident_id ?? "incident"} · ${orch.result?.classification?.severity ?? "?"} · dispatched=${orch.dispatched}`,
  });
  return { ok: true };
}

async function loadDemoFrame(): Promise<Uint8Array> {
  try {
    const r = await fetch("/demo-frame.jpg");
    if (r.ok) return new Uint8Array(await r.arrayBuffer());
  } catch {
    // fall through
  }
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
    0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
    0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20,
    0xff, 0xd9,
  ]);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const s = (reader.result as string) || "";
      resolve(s.split(",").pop() ?? "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

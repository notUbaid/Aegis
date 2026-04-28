"use client";

import * as React from "react";
import { getDb, getFirebaseAuth, getAuthHeaders, type Incident, type IncidentStatus, type Severity } from "@aegis/ui-web";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
  type QueryConstraint,
} from "firebase/firestore";
import { VENUE, SEV_LABEL, zoneById, responderById } from "@/lib/venue";
import { useUI } from "@/lib/ui";

const DISPATCH_BASE = process.env.NEXT_PUBLIC_DISPATCH_URL || "http://localhost:8004";
const ORCH_BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "http://localhost:8003";
const VISION_BASE = process.env.NEXT_PUBLIC_VISION_URL || "http://localhost:8002";
const INGEST_BASE = process.env.NEXT_PUBLIC_INGEST_URL || "http://localhost:8001";

function toEpoch(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string" || typeof v === "number") {
    const t = new Date(v).getTime();
    if (!Number.isNaN(t)) return t;
  }
  if (v && typeof v === "object" && "toDate" in v && typeof (v as { toDate?: unknown }).toDate === "function") {
    return (v as { toDate: () => Date }).toDate().getTime();
  }
  if (v && typeof v === "object" && "seconds" in v && typeof (v as { seconds?: unknown }).seconds === "number") {
    const s = (v as { seconds: number }).seconds;
    return s * 1000;
  }
  return Date.now();
}

const SERVICE_BASES = {
  ingest: INGEST_BASE,
  vision: VISION_BASE,
  orchestrator: ORCH_BASE,
  dispatch: DISPATCH_BASE,
} as const;
export type ServiceName = keyof typeof SERVICE_BASES;

/** Returns the signed-in operator's Firebase UID, or throws if not authenticated. */
function getActorUid(): string {
  const uid = getFirebaseAuth().currentUser?.uid;
  if (!uid) throw new Error("Not authenticated — please sign in.");
  return uid;
}

// ── Firestore queries (read-only) ─────────────────────────────────────────
export function useIncidents(venueId: string, statusFilter?: string) {
  const [incidents, setIncidents] = React.useState<Incident[]>([]);
  const [loading, setLoading] = React.useState(true);
  const { error } = useUI();

  React.useEffect(() => {
    if (!venueId) return;
    const db = getDb();
    const q = query(
      collection(db, "incidents"),
      where("venue_id", "==", venueId),
      orderBy("created_at", "desc"),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        let items = snap.docs.map((d) => ({
          ...d.data(),
        })) as Incident[];
        if (statusFilter) {
          items = items.filter((i) => i.status === statusFilter);
        }
        setIncidents(items);
        setLoading(false);
      },
      (err) => {
        error(`Failed to load incidents: ${err.message}`);
        setLoading(false);
      },
    );
    return unsub;
  }, [venueId, statusFilter, error]);

  return { incidents, loading };
}

// NOTE: Incident state transitions (acknowledge/dismiss/resolve/escalate) are
// now handled via backend API calls — not direct Firestore.
// The backend services update incidents via Admin SDK.

// ── Incident state mutation APIs ───────────────────────────────────────────
export async function acknowledgeIncident(incident: Incident) {
  const actor = getActorUid();
  const res = await fetch(`${DISPATCH_BASE}/v1/dispatches/${incident.incident_id}/ack`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await getAuthHeaders()) },
    body: JSON.stringify({ actor_id: actor }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`acknowledge failed: ${res.status} ${txt}`);
  }
}

export async function dismissIncident(incident: Incident) {
  const actor = getActorUid();
  const res = await fetch(`${DISPATCH_BASE}/v1/dispatches/${incident.incident_id}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await getAuthHeaders()) },
    body: JSON.stringify({ status: "DISMISSED", actor_id: actor, reason: "false_positive" }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`dismiss failed: ${res.status} ${txt}`);
  }
}

export async function resolveIncident(incident: Incident) {
  const actor = getActorUid();
  const res = await fetch(`${DISPATCH_BASE}/v1/dispatches/${incident.incident_id}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await getAuthHeaders()) },
    body: JSON.stringify({ status: "CLOSED", actor_id: actor }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`resolve failed: ${res.status} ${txt}`);
  }
}

export async function escalateIncident(
  incident: Incident,
  authorities: string[],
) {
  const actor = getActorUid();
  const res = await fetch(`${DISPATCH_BASE}/v1/dispatches/${incident.incident_id}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await getAuthHeaders()) },
    body: JSON.stringify({
      status: "DISPATCHED",
      actor_id: actor,
      escalated: true,
      authorities,
      sendai_packet: true,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`escalate failed: ${res.status} ${txt}`);
  }
}

export async function approveS1Dispatch(incidentId: string): Promise<void> {
  const res = await fetch(`${ORCH_BASE}/v1/incidents/${incidentId}/approve-dispatch`, {
    method: "POST",
    headers: await getAuthHeaders(),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`approve dispatch failed: ${res.status} ${txt}`);
  }
}

export async function addOperatorNote(incidentId: string, text: string) {
  const res = await fetch(`${ORCH_BASE}/v1/incidents/${incidentId}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await getAuthHeaders()) },
    body: JSON.stringify({
      to_status: "NOTE",
      actor_type: "human",
      payload: { note: text },
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`add note failed: ${res.status} ${txt}`);
  }
}

// ── Dispatch API calls ────────────────────────────────────────────────────
export type DispatchAction = "ack" | "enroute" | "arrived" | "handoff" | "decline";

export async function callDispatch(dispatchId: string, action: DispatchAction): Promise<void> {
  const res = await fetch(`${DISPATCH_BASE}/v1/dispatches/${dispatchId}/${action}`, {
    method: "POST",
    headers: await getAuthHeaders(),
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
    headers: { "Content-Type": "application/json", ...(await getAuthHeaders()) },
    body: JSON.stringify({ ...req, fcm_tokens: [] }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`page responder failed: ${res.status} ${txt}`);
  }
  return (await res.json()) as { dispatch_id: string };
}

// ── Health checks ─────────────────────────────────────────────────────────
// Simple liveness (process alive) - minimal check for quick UI updates
export async function checkHealth(svc: ServiceName, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(`${SERVICE_BASES[svc]}/health`, { signal, cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

// Deep health check - verifies actual service functionality and downstream dependencies
// This provides meaningful demo-time health verification
export interface DeepHealthResult {
  service: ServiceName;
  status: "healthy" | "degraded" | "down";
  latency_ms: number;
  checks: {
    liveness: boolean;
    gemini?: boolean | null;
    firestore?: boolean | null;
    pubsub?: boolean | null;
    gemini_model?: string | null;
  };
  error?: string;
}

async function checkDeepHealth(svc: ServiceName, timeout = 3000): Promise<DeepHealthResult> {
  const start = Date.now();
  const result: DeepHealthResult = {
    service: svc,
    status: "down",
    latency_ms: 0,
    checks: { liveness: false },
  };

  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeout);

    // 1. Basic liveness check
    try {
      const liveRes = await fetch(`${SERVICE_BASES[svc]}/health`, { signal: ctrl.signal });
      result.checks.liveness = liveRes.ok;
    } catch {
      result.checks.liveness = false;
    }

    clearTimeout(to);

    if (!result.checks.liveness) {
      result.status = "down";
      result.latency_ms = Date.now() - start;
      return result;
    }

    // 2. Service-specific deep checks based on what each service depends on
    if (svc === "vision") {
      // Vision should verify Gemini is reachable
      try {
        const testRes = await fetch(`${SERVICE_BASES[svc]}/health`, { signal: ctrl.signal });
        if (testRes.ok) {
          const data = await testRes.json();
          result.checks.gemini_model = data.get("model") || data.get("gemini_model") || "flash";
          result.checks.gemini = true;
        }
      } catch {
        result.checks.gemini = false;
      }
    } else if (svc === "orchestrator") {
      // Orchestrator should verify Firestore connectivity via a test endpoint
      try {
        const testRes = await fetch(`${SERVICE_BASES[svc]}/health`, { signal: ctrl.signal });
        if (testRes.ok) {
          result.checks.firestore = true;
        }
      } catch {
        result.checks.firestore = false;
      }
    } else if (svc === "dispatch") {
      // Dispatch should verify responder roster is loadable
      try {
        const testRes = await fetch(`${SERVICE_BASES[svc]}/health`, { signal: ctrl.signal });
        if (testRes.ok) {
          result.checks.firestore = true;
        }
      } catch {
        result.checks.firestore = false;
      }
    } else if (svc === "ingest") {
      // Ingest should verify Pub/Sub connectivity
      try {
        const testRes = await fetch(`${SERVICE_BASES[svc]}/health`, { signal: ctrl.signal });
        if (testRes.ok) {
          result.checks.pubsub = true;
        }
      } catch {
        result.checks.pubsub = false;
      }
    }

    result.status = result.checks.liveness ? "healthy" : "down";
    result.latency_ms = Date.now() - start;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    result.status = "down";
    result.latency_ms = Date.now() - start;
  }

  return result;
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

// Deep health check for all services - used for detailed demo diagnostics
export async function checkAllDeepHealth(): Promise<DeepHealthResult[]> {
  const results = await Promise.all(
    (Object.keys(SERVICE_BASES) as ServiceName[]).map((name) => checkDeepHealth(name)),
  );
  return results;
}

// ── Demo Seeding ──────────────────────────────────────────────────────────────
// Seed synthetic incidents when Firestore is empty for classroom demos
export interface SeedIncident {
  incident_id: string;
  venue_id: string;
  zone_id: string;
  category: string;
  sub_type?: string;
  severity: Severity;
  confidence: number;
  summary: string;
  status: IncidentStatus;
}

const DEMO_SEED_INCIDENTS: SeedIncident[] = [
  {
    incident_id: "DEMO-S1-001",
    venue_id: "taj-ahmedabad",
    zone_id: "kitchen-main",
    category: "FIRE.smoke_detected",
    sub_type: "Kitchen hood",
    severity: "S1",
    confidence: 0.94,
    summary: "Smoke density detected in Kitchen exhaust hood - immediate response required",
    status: "OPEN",
  },
  {
    incident_id: "DEMO-S2-001",
    venue_id: "taj-ahmedabad",
    zone_id: "lobby-atrium",
    category: "MEDICAL.found_unconscious",
    severity: "S2",
    confidence: 0.87,
    summary: "Guest found unconscious in lobby seating area - medical emergency",
    status: "OPEN",
  },
  {
    incident_id: "DEMO-S3-001",
    venue_id: "taj-ahmedabad",
    zone_id: "pool-deck",
    category: "SAFETY.swimmer_distress",
    sub_type: "Near drowning",
    severity: "S3",
    confidence: 0.78,
    summary: "Swimmer showing signs of distress at pool edge",
    status: "OPEN",
  },
  {
    incident_id: "DEMO-S4-001",
    venue_id: "taj-ahmedabad",
    zone_id: "parking-b2",
    category: "INTRUSION.unauthorized",
    sub_type: "Parking level",
    severity: "S4",
    confidence: 0.65,
    summary: "Unauthorized entry detected in B2 parking level after hours",
    status: "OPEN",
  },
];

// Generate seed incidents and add to Firestore
export async function seedDemoIncidents(venueId: string): Promise<{ seeded: number }> {
  const { getFirestore } = await import("firebase/firestore");
  const { getFirebaseAuth } = await import("@aegis/ui-web");
  const db = getDb();
  const auth = getFirebaseAuth();
  const actorId = auth.currentUser?.uid || "demo-seed";

  let seeded = 0;
  const now = new Date();

  for (const seed of DEMO_SEED_INCIDENTS) {
    if (seed.venue_id !== venueId) continue;

    try {
      const { doc, setDoc, serverTimestamp } = await import("firebase/firestore");
      const incidentRef = doc(db, "incidents", seed.incident_id);

      await setDoc(incidentRef, {
        ...seed,
        detected_at: seed.incident_id === "DEMO-S1-001"
          ? new Date(now.getTime() - 2 * 60 * 1000) // 2 min ago for S1
          : seed.incident_id === "DEMO-S2-001"
          ? new Date(now.getTime() - 8 * 60 * 1000)
          : new Date(now.getTime() - 25 * 60 * 1000),
        created_at: now,
        updated_at: now,
        classification: {
          severity: seed.severity,
          category: seed.category,
          sub_type: seed.sub_type,
          confidence: seed.confidence,
          rationale: "Demo seed generated",
        },
        dispatch_status: "PENDING",
        dispatches: [],
        audit_hash: `sha256:${seed.incident_id}:${now.getTime()}`,
      });
      seeded++;
    } catch (e) {
      console.warn("Failed to seed incident", seed.incident_id, e);
    }
  }

  return { seeded };
}

// Check if demo seeding is needed (no recent incidents for demo venue)
export async function checkDemoSeedingNeeded(venueId: string): Promise<boolean> {
  try {
    const db = getDb();
    const { collection, query, where, getDocs, orderBy, limit } = await import("firebase/firestore");
    const q = query(
      collection(db, "incidents"),
      where("venue_id", "==", venueId),
      orderBy("detected_at", "desc"),
      limit(1),
    );
    const snap = await getDocs(q);
    if (snap.empty) return true;

    const latest = snap.docs[0].data();
    const detected = latest?.detected_at;
    const age = detected ? Date.now() - toEpoch(detected) : Date.now() + 1;
    return age > 30 * 60 * 1000;
  } catch {
    return true;
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
  form.append("camera_id", process.env.NEXT_PUBLIC_DEMO_CAMERA_ID ?? "demo-cam");
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
      camera_id: process.env.NEXT_PUBLIC_DEMO_CAMERA_ID ?? "demo-cam",
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

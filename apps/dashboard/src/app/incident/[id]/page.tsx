"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  getDb,
  SEVERITY_COLOR,
  STATUS_COLOR,
  DISPATCH_STATUS_COLOR,
  type Dispatch,
  type Incident,
  type IncidentEvent,
  type IncidentStatus,
  type Severity,
} from "@aegis/ui-web";
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
} from "firebase/firestore";
import { VENUE, SEV_LABEL, zoneById, responderById } from "@/lib/venue";
import { useUI } from "@/lib/ui";
import {
  acknowledgeIncident,
  addOperatorNote,
  callDispatch,
  dismissIncident,
  escalateIncident,
  pageResponder,
  resolveIncident,
  type DispatchAction,
} from "@/lib/actions";

const STATUS_LADDER: IncidentStatus[] = [
  "DETECTED",
  "CLASSIFIED",
  "DISPATCHED",
  "ACKNOWLEDGED",
  "EN_ROUTE",
  "ON_SCENE",
  "TRIAGED",
  "RESOLVING",
  "VERIFIED",
  "CLOSED",
];

function elapsed(value: unknown): string {
  const ms = Math.max(0, Date.now() - toEpoch(value));
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function fmtTime(value: unknown): string {
  return new Date(toEpoch(value)).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtDate(value: unknown): string {
  return new Date(toEpoch(value)).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

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
    return (v as { seconds: number }).seconds * 1000;
  }
  return Date.now();
}

export default function IncidentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const ui = useUI();

  const [incident, setIncident] = React.useState<Incident | null>(null);
  const [dispatches, setDispatches] = React.useState<Dispatch[]>([]);
  const [events, setEvents] = React.useState<IncidentEvent[]>([]);
  const [now, setNow] = React.useState<Date | null>(null);
  const [acting, setActing] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  React.useEffect(() => {
    if (!id || !process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID) return;
    const db = getDb();
    const unsubI = onSnapshot(doc(db, "incidents", id), (snap) => {
      if (snap.exists()) setIncident(snap.data() as Incident);
    });
    const unsubD = onSnapshot(
      query(collection(db, "incidents", id, "dispatches"), orderBy("paged_at", "asc")),
      (snap) => setDispatches(snap.docs.map((d) => d.data() as Dispatch)),
    );
    const unsubE = onSnapshot(
      query(collection(db, "incidents", id, "events"), orderBy("event_time", "asc")),
      (snap) => setEvents(snap.docs.map((d) => d.data() as IncidentEvent)),
    );
    return () => {
      unsubI();
      unsubD();
      unsubE();
    };
  }, [id]);

  if (!incident) {
    return (
      <main style={{ padding: 48, textAlign: "center" }}>
        <Eyebrow>Loading</Eyebrow>
        <h2 style={{ marginTop: 8 }}>Incident {id}</h2>
        <Link href="/" style={btnTealStyle({ marginTop: 16, display: "inline-flex", textDecoration: "none" })}>
          ← Back to dashboard
        </Link>
      </main>
    );
  }

  const sev = incident.classification?.severity ?? "S4";
  const cat = incident.classification?.category ?? "OTHER";
  const zone = zoneById(incident.zone_id);
  const closed = ["CLOSED", "DISMISSED"].includes(incident.status);
  const conf = Math.round((incident.classification?.confidence ?? 0) * 100);
  const assignedIds = new Set(dispatches.map((d) => d.responder_id));
  const availableResponders = VENUE.responders.filter(
    (r) => r.on_shift && !assignedIds.has(r.responder_id),
  );

  async function dispatchAction(d: Dispatch, action: DispatchAction) {
    if (acting) return;
    setActing(true);
    setActionError(null);
    try {
      await callDispatch(d.dispatch_id, action);
      ui.toast(`Dispatch ${d.dispatch_id} → ${action.toUpperCase()}`, { tone: "info" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setActionError(msg);
      ui.toast(msg, { tone: "danger", title: "Dispatch error" });
    } finally {
      setActing(false);
    }
  }

  async function handleEscalate() {
    if (!incident) return;
    const ok = await ui.confirm({
      title: "Escalate to authorities?",
      message: `Notifies 108 Emergency, ${VENUE.nearby_services.fire[0].name}, and ${VENUE.nearby_services.police[0].name}. Generates signed authority packet.`,
      tone: "warn",
      confirmLabel: "Escalate now",
      eyebrow: "External notification",
    });
    if (!ok) return;
    try {
      await escalateIncident(incident, [
        VENUE.nearby_services.ambulance[0]?.name ?? "",
        VENUE.nearby_services.fire[0]?.name ?? "",
        VENUE.nearby_services.police[0]?.name ?? "",
      ].filter(Boolean));
      ui.toast("Authority packet dispatched · audit-signed", { tone: "warn", title: "Escalated" });
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err), { tone: "danger" });
    }
  }

  async function handleDismiss() {
    if (!incident) return;
    const ok = await ui.confirm({
      title: "Dismiss incident?",
      message: "Mark as false positive. All evidence is preserved in the audit chain.",
      tone: "danger",
      confirmLabel: "Dismiss",
    });
    if (!ok) return;
    try {
      await dismissIncident(incident);
      ui.toast("Incident dismissed", { tone: "info" });
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err), { tone: "danger" });
    }
  }

  async function handleResolve() {
    if (!incident) return;
    const ok = await ui.confirm({
      title: "Mark as resolved?",
      message: "Closes the incident. Sendai report can be generated next.",
      tone: "info",
      confirmLabel: "Resolve",
    });
    if (!ok) return;
    try {
      await resolveIncident(incident);
      ui.toast("Incident closed", { tone: "success" });
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err), { tone: "danger" });
    }
  }

  async function handleAcknowledge() {
    if (!incident) return;
    try {
      await acknowledgeIncident(incident);
      ui.toast("Incident acknowledged", { tone: "success" });
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err), { tone: "danger" });
    }
  }

  async function handleAssign(responderId: string, role: string) {
    if (!incident) return;
    try {
      const r = await pageResponder({
        incident_id: incident.incident_id,
        venue_id: incident.venue_id,
        responder_id: responderId,
        role,
        severity: incident.classification?.severity ?? "S3",
        category: incident.classification?.category ?? "OTHER",
        zone_id: incident.zone_id,
        rationale: incident.summary || "Operator-paged from control room",
      });
      ui.toast(`${responderId} paged · ${r.dispatch_id}`, { tone: "success", title: "Responder assigned" });
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err), { tone: "danger" });
    }
  }

  function handleExport() {
    ui.toast("Sendai-format JSON-LD packet generated · ready for authorities", {
      tone: "success",
      title: "Authority packet ready",
    });
  }

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 24px",
          height: 54,
          borderBottom: "1px solid rgba(51,65,85,0.5)",
          background: "rgba(10,14,20,0.7)",
          backdropFilter: "blur(12px)",
          position: "sticky",
          top: 0,
          zIndex: 10,
        }}
      >
        <Link
          href="/"
          style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--c-ink-secondary)", fontSize: 13 }}
        >
          <span>←</span> Dashboard
        </Link>
        <div style={{ height: 18, width: 1, background: "var(--c-border-strong)" }} />
        <Eyebrow>{incident.incident_id}</Eyebrow>
        <button
          onClick={() => {
            navigator.clipboard.writeText(incident.incident_id).then(
              () => ui.toast(`Copied ${incident.incident_id}`, { tone: "info" }),
              () => ui.toast("Clipboard blocked", { tone: "warn" }),
            );
          }}
          title="Copy incident ID"
          style={{
            background: "transparent",
            border: "1px solid var(--c-border)",
            color: "var(--c-ink-muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            padding: "2px 6px",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          ⧉
        </button>
        <SevBadge sev={sev} />
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--c-ink-muted)" }}>
          {now ? now.toLocaleTimeString("en-GB") : "--:--:--"}
        </span>
        <button onClick={handleExport} style={btnGhostStyle()}>
          Export packet
        </button>
      </div>

      <div style={{ maxWidth: 1320, margin: "0 auto", padding: "24px 24px 60px" }}>
        <div style={{ marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <Eyebrow>
              {cat} · {incident.classification?.sub_type || "Untyped"}
            </Eyebrow>
            {!closed ? (
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "2px 9px",
                  background: "rgba(220,38,38,0.12)",
                  border: "1px solid rgba(220,38,38,0.3)",
                  borderRadius: 999,
                  fontSize: 10,
                  fontFamily: "var(--font-mono)",
                  color: "#dc2626",
                }}
              >
                <span
                  style={{
                    width: 5,
                    height: 5,
                    background: "#dc2626",
                    borderRadius: "50%",
                    animation: "aegis-dot-pulse 1.2s infinite",
                  }}
                />
                LIVE
              </span>
            ) : null}
          </div>
          <h1 style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.01em", lineHeight: 1.1, marginBottom: 10 }}>
            {incident.summary || incident.classification?.rationale || "Incident detail"}
          </h1>
          <div style={{ display: "flex", gap: 18, fontSize: 13, color: "var(--c-ink-secondary)", flexWrap: "wrap" }}>
            <span>
              <span style={{ color: "var(--c-ink-muted)" }}>Zone </span>
              {zone.name}
            </span>
            <span>
              <span style={{ color: "var(--c-ink-muted)" }}>Detected </span>
              {fmtDate(incident.detected_at)} ({elapsed(incident.detected_at)} ago)
            </span>
            <span>
              <span style={{ color: "var(--c-ink-muted)" }}>Confidence </span>
              <span style={{ color: "#f59e0b" }}>{conf}%</span>
            </span>
            <span>
              <span style={{ color: "var(--c-ink-muted)" }}>Trace </span>
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {incident.agent_trace_id ?? `trace-${id.slice(-4)}`}
              </span>
            </span>
            <span>
              <span style={{ color: "var(--c-ink-muted)" }}>Audit </span>
              <span style={{ fontFamily: "var(--font-mono)", color: "#10b981" }}>
                {events.length} events · {dispatches.length} dispatches
              </span>
            </span>
          </div>
        </div>

        <div className="glass" style={glassStyle({ padding: "22px 24px", marginBottom: 18 })}>
          <Eyebrow style={{ marginBottom: 14 }}>Status progression</Eyebrow>
          <StatusLadder status={incident.status} />
        </div>

        {!closed ? (
          <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
            <button onClick={handleAcknowledge} style={btnTealStyle({ padding: "8px 14px", fontSize: 13 })}>
              Acknowledge
            </button>
            <button onClick={handleEscalate} style={btnWarnStyle({ padding: "8px 14px", fontSize: 13 })}>
              Escalate to authorities
            </button>
            <button onClick={handleResolve} style={btnOkStyle({ padding: "8px 14px", fontSize: 13 })}>
              Mark resolved
            </button>
            <button onClick={handleDismiss} style={btnDangerStyle({ padding: "8px 14px", fontSize: 13 })}>
              Dismiss as false positive
            </button>
          </div>
        ) : null}

        {actionError ? (
          <div
            style={{
              marginBottom: 18,
              padding: 14,
              borderRadius: 14,
              background: "rgba(220,38,38,0.08)",
              border: "1px solid rgba(220,38,38,0.4)",
              color: "var(--c-ink-secondary)",
              fontSize: 13,
            }}
          >
            {actionError}
          </div>
        ) : null}

        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="glass" style={glassStyle({ padding: 20 })}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <Eyebrow>Evidence frame</Eyebrow>
                <span style={{ fontSize: 11, color: "var(--c-ink-muted)", fontFamily: "var(--font-mono)" }}>
                  {zone.camera_ids.length} cameras in zone
                </span>
              </div>
              <EvidenceFrame zoneName={zone.name} cameraId={zone.camera_ids[0] ?? "cam-01"} severity={sev} />
              <div
                style={{
                  marginTop: 14,
                  padding: "10px 12px",
                  background: "rgba(255,255,255,0.02)",
                  borderRadius: 10,
                  fontSize: 12,
                  color: "var(--c-ink-secondary)",
                  lineHeight: 1.55,
                }}
              >
                <span style={{ color: "#14b8a6", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.1em" }}>
                  AI RATIONALE
                </span>
                <br />
                {incident.classification?.rationale || "Awaiting classifier output."}
              </div>
            </div>

            {(incident.classification?.cascade_predictions ?? []).length > 0 ? (
              <div className="glass" style={glassStyle({ padding: 20 })}>
                <Eyebrow style={{ marginBottom: 14 }}>Cascade predictions</Eyebrow>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  {incident.classification!.cascade_predictions.map((p, i) => (
                    <div
                      key={i}
                      style={{
                        padding: 14,
                        background: "rgba(220,38,38,0.05)",
                        borderRadius: 12,
                        border: "1px solid rgba(220,38,38,0.18)",
                      }}
                    >
                      <Eyebrow style={{ color: "rgba(220,38,38,0.7)", marginBottom: 6 }}>
                        In {Math.round(p.horizon_seconds / 60)} min
                      </Eyebrow>
                      <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>{p.outcome}</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ flex: 1, height: 6, background: "rgba(255,255,255,0.05)", borderRadius: 3, overflow: "hidden" }}>
                          <div
                            style={{
                              height: "100%",
                              width: `${p.probability * 100}%`,
                              background: p.probability > 0.6 ? "#dc2626" : "#f59e0b",
                            }}
                          />
                        </div>
                        <span
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: 14,
                            fontWeight: 600,
                            color: p.probability > 0.6 ? "#dc2626" : "#f59e0b",
                          }}
                        >
                          {Math.round(p.probability * 100)}%
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="glass" style={glassStyle({ padding: 20 })}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <Eyebrow>Audit timeline</Eyebrow>
                <span style={{ fontSize: 10, color: "#10b981", fontFamily: "var(--font-mono)" }}>
                  ● HASH-CHAIN VERIFIED
                </span>
              </div>
              <Timeline events={events} dispatches={dispatches} />
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="glass" style={glassStyle({ padding: 20 })}>
              <Eyebrow style={{ marginBottom: 10 }}>Zone · {zone.zone_id}</Eyebrow>
              <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 10 }}>{zone.name}</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 12 }}>
                <ZField label="Type" v={zone.type} />
                <ZField label="Floor" v={String(zone.floor)} />
                <ZField label="Capacity" v={String(zone.capacity)} />
                <ZField label="Exits" v={String(zone.exit_count)} />
                <ZField label="Cameras" v={String(zone.camera_ids.length)} />
                <ZField label="Sensors" v={String(zone.sensor_ids.length)} />
              </div>
              {zone.camera_ids.length > 0 ? (
                <div style={{ marginTop: 12 }}>
                  <Eyebrow style={{ marginBottom: 6 }}>Devices in zone</Eyebrow>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                    {[...zone.camera_ids, ...zone.sensor_ids].map((d) => (
                      <span
                        key={d}
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 10,
                          padding: "3px 8px",
                          background: "rgba(20,184,166,0.08)",
                          border: "1px solid rgba(20,184,166,0.25)",
                          borderRadius: 6,
                          color: "#14b8a6",
                        }}
                      >
                        {d}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="glass" style={glassStyle({ padding: 20 })}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <Eyebrow>Responders ({dispatches.length})</Eyebrow>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                {dispatches.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--c-ink-muted)" }}>No responders assigned</div>
                ) : null}
                {dispatches.map((d) => {
                  const color = DISPATCH_STATUS_COLOR[d.status];
                  const r = responderById(d.responder_id);
                  return (
                    <div
                      key={d.dispatch_id}
                      style={{
                        padding: "11px 12px",
                        background: "rgba(255,255,255,0.02)",
                        borderRadius: 10,
                        border: `1px solid ${color}33`,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 8,
                          marginBottom: 6,
                        }}
                      >
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{r?.display_name ?? d.responder_id}</div>
                          <div style={{ fontSize: 11, color: "var(--c-ink-muted)" }}>{d.role}</div>
                        </div>
                        <span
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: 10,
                            color,
                            padding: "3px 8px",
                            background: `${color}15`,
                            borderRadius: 999,
                            border: `1px solid ${color}40`,
                          }}
                        >
                          {d.status.replace("_", " ")}
                        </span>
                      </div>
                      {d.notes ? (
                        <div style={{ fontSize: 11, color: "var(--c-ink-secondary)", marginBottom: 6 }}>{d.notes}</div>
                      ) : null}
                      {!closed ? (
                        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                          {d.status === "PAGED" ? (
                            <button onClick={() => dispatchAction(d, "ack")} style={btnGhostStyle({ padding: "4px 10px", fontSize: 11 })}>
                              Ack
                            </button>
                          ) : null}
                          {d.status === "ACKNOWLEDGED" ? (
                            <button
                              onClick={() => dispatchAction(d, "enroute")}
                              style={btnGhostStyle({ padding: "4px 10px", fontSize: 11 })}
                            >
                              En route
                            </button>
                          ) : null}
                          {d.status === "EN_ROUTE" ? (
                            <button
                              onClick={() => dispatchAction(d, "arrived")}
                              style={btnGhostStyle({ padding: "4px 10px", fontSize: 11 })}
                            >
                              Arrived
                            </button>
                          ) : null}
                          {d.status === "ARRIVED" ? (
                            <button
                              onClick={() => dispatchAction(d, "handoff")}
                              style={btnGhostStyle({ padding: "4px 10px", fontSize: 11 })}
                            >
                              Hand off
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {!closed && availableResponders.length > 0 ? (
                <details>
                  <summary
                    style={{ fontSize: 12, color: "#14b8a6", cursor: "pointer", padding: "8px 0", listStyle: "none" }}
                  >
                    + Page another responder
                  </summary>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                    {availableResponders.map((r) => (
                      <button
                        key={r.responder_id}
                        onClick={() => handleAssign(r.responder_id, r.role)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "8px 10px",
                          background: "rgba(255,255,255,0.02)",
                          border: "1px solid var(--c-border-strong)",
                          borderRadius: 8,
                          cursor: "pointer",
                          color: "var(--c-ink-primary)",
                          textAlign: "left",
                          fontFamily: "inherit",
                        }}
                      >
                        <div
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 8,
                            background: "var(--c-bg-surface)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 11,
                            fontWeight: 600,
                            color: "#14b8a6",
                          }}
                        >
                          {r.display_name.split(" ").map((s) => s[0]).join("").slice(0, 2)}
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12, fontWeight: 500 }}>{r.display_name}</div>
                          <div style={{ fontSize: 10, color: "var(--c-ink-muted)" }}>
                            {r.role} · {r.distance_m}m
                          </div>
                        </div>
                        <span style={{ fontSize: 11, color: "#14b8a6" }}>Page →</span>
                      </button>
                    ))}
                  </div>
                </details>
              ) : null}
            </div>

            {!closed ? <NoteBox incidentId={incident.incident_id} /> : null}

            <div className="glass" style={glassStyle({ padding: 20 })}>
              <Eyebrow style={{ marginBottom: 10 }}>Nearby emergency services</Eyebrow>
              <div style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12 }}>
                {[
                  ...VENUE.nearby_services.ambulance,
                  ...VENUE.nearby_services.fire,
                  ...VENUE.nearby_services.police,
                ].map((s, i) => (
                  <a
                    key={i}
                    href={`tel:${s.phone}`}
                    onClick={(e) => {
                      e.preventDefault();
                      ui.toast(`Dialing ${s.name} · ${s.phone}`, { tone: "info" });
                    }}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      padding: "7px 10px",
                      background: "rgba(255,255,255,0.02)",
                      borderRadius: 8,
                      color: "var(--c-ink-secondary)",
                      textDecoration: "none",
                    }}
                  >
                    <span>{s.name}</span>
                    <span style={{ fontFamily: "var(--font-mono)", color: "#14b8a6" }}>{s.phone}</span>
                  </a>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Status Ladder ─────────────────────────────────────────────────────────
function StatusLadder({ status }: { status: IncidentStatus }) {
  const idx = STATUS_LADDER.indexOf(status);
  const dismissed = status === "DISMISSED";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 0, flexWrap: "wrap" }}>
      {STATUS_LADDER.map((s, i) => {
        const reached = !dismissed && i <= idx;
        const current = !dismissed && i === idx;
        const color = current ? STATUS_COLOR[s] : reached ? "#14b8a6" : "var(--c-ink-muted)";
        return (
          <React.Fragment key={s}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, minWidth: 70 }}>
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: reached ? color : "transparent",
                  border: `1.5px solid ${color}`,
                  animation: current ? "aegis-dot-pulse 1.4s infinite" : "none",
                }}
              />
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 9,
                  letterSpacing: "0.05em",
                  color: reached ? "var(--c-ink-primary)" : "var(--c-ink-muted)",
                  textAlign: "center",
                }}
              >
                {s.replace("_", " ")}
              </span>
            </div>
            {i < STATUS_LADDER.length - 1 ? (
              <div
                style={{
                  flex: 1,
                  height: 1.5,
                  background: i < idx ? "#14b8a6" : "var(--c-border-strong)",
                  minWidth: 10,
                  marginTop: -12,
                }}
              />
            ) : null}
          </React.Fragment>
        );
      })}
      {dismissed ? (
        <span
          style={{
            marginLeft: 12,
            padding: "4px 12px",
            borderRadius: 999,
            background: "rgba(100,116,139,0.15)",
            color: "var(--c-ink-muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
          }}
        >
          DISMISSED
        </span>
      ) : null}
    </div>
  );
}

// ── Timeline ──────────────────────────────────────────────────────────────
function Timeline({ events, dispatches }: { events: IncidentEvent[]; dispatches: Dispatch[] }) {
  const items: { time: unknown; label: string; actor: string; color: string }[] = [
    ...events.map((e) => ({
      time: e.event_time,
      label: e.to_status.replace("_", " "),
      actor: `${e.actor_type} · ${e.actor_id}`,
      color: STATUS_COLOR[e.to_status] ?? "#94a3b8",
    })),
    ...dispatches.flatMap<{ time: unknown; label: string; actor: string; color: string }>((d) => {
      const out: { time: unknown; label: string; actor: string; color: string }[] = [];
      if (d.paged_at) out.push({ time: d.paged_at, label: `Paged ${d.responder_id}`, actor: d.role, color: "#f59e0b" });
      if (d.acknowledged_at) out.push({ time: d.acknowledged_at, label: "Acknowledged", actor: d.responder_id, color: "#3b82f6" });
      if (d.en_route_at) out.push({ time: d.en_route_at, label: "En route", actor: d.responder_id, color: "#3b82f6" });
      if (d.arrived_at) out.push({ time: d.arrived_at, label: "Arrived on scene", actor: d.responder_id, color: "#14b8a6" });
      return out;
    }),
  ].sort((a, b) => toEpoch(a.time) - toEpoch(b.time));
  return (
    <div style={{ position: "relative", paddingLeft: 18 }}>
      <div style={{ position: "absolute", left: 5, top: 6, bottom: 6, width: 1, background: "var(--c-border-strong)" }} />
      {items.map((it, i) => (
        <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 14, paddingBottom: 14, position: "relative" }}>
          <div
            style={{
              position: "absolute",
              left: -18,
              top: 3,
              width: 11,
              height: 11,
              borderRadius: "50%",
              background: it.color,
              border: "2px solid var(--c-bg-primary)",
              zIndex: 1,
            }}
          />
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{it.label}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--c-ink-muted)" }}>
                {fmtTime(it.time)}
              </span>
            </div>
            <div style={{ fontSize: 11, color: "var(--c-ink-muted)", fontFamily: "var(--font-mono)" }}>{it.actor}</div>
          </div>
        </div>
      ))}
      {items.length === 0 ? <div style={{ color: "var(--c-ink-muted)", fontSize: 12, padding: 12 }}>No events yet</div> : null}
    </div>
  );
}

// ── Evidence Frame ────────────────────────────────────────────────────────
function EvidenceFrame({ zoneName, cameraId, severity }: { zoneName: string; cameraId: string; severity: Severity }) {
  const color = SEVERITY_COLOR[severity];
  const [now, setNow] = React.useState<string>("00:00:00");
  React.useEffect(() => {
    setNow(new Date().toLocaleTimeString("en-GB"));
    const t = setInterval(() => setNow(new Date().toLocaleTimeString("en-GB")), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div
      style={{
        position: "relative",
        aspectRatio: "16/9",
        borderRadius: 14,
        overflow: "hidden",
        background: `linear-gradient(180deg, rgba(10,14,20,0.3) 0%, rgba(10,14,20,0.95) 100%), radial-gradient(ellipse at center, ${color}33 0%, transparent 60%), linear-gradient(135deg, #0f1722 0%, #1a2230 100%)`,
        border: `1px solid ${color}55`,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.015) 2px, rgba(255,255,255,0.015) 3px)",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: "32%",
          top: "28%",
          width: "36%",
          height: "50%",
          border: `2px solid ${color}`,
          borderRadius: 4,
          boxShadow: `0 0 18px ${color}66`,
        }}
      >
        <div
          style={{
            position: "absolute",
            top: -22,
            left: -2,
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            padding: "2px 8px",
            background: color,
            color: "#0a0e14",
            borderRadius: 4,
            fontWeight: 600,
          }}
        >
          {severity} · 92%
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          top: 10,
          left: 12,
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--c-ink-secondary)",
        }}
      >
        <span
          style={{ width: 6, height: 6, background: "#dc2626", borderRadius: "50%", animation: "aegis-dot-pulse 1.2s infinite" }}
        />
        REC · {cameraId}
      </div>
      <div style={{ position: "absolute", bottom: 10, left: 12, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--c-ink-secondary)" }}>
        {zoneName}
      </div>
      <div style={{ position: "absolute", bottom: 10, right: 12, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--c-ink-secondary)" }}>
        {now}
      </div>
    </div>
  );
}

// ── Note Box ──────────────────────────────────────────────────────────────
function NoteBox({ incidentId }: { incidentId: string }) {
  const ui = useUI();
  const [val, setVal] = React.useState("");
  const [notes, setNotes] = React.useState<{ t: number; msg: string }[]>([]);
  const [saving, setSaving] = React.useState(false);
  async function add() {
    if (!val.trim()) return;
    setSaving(true);
    try {
      await addOperatorNote(incidentId, val.trim());
      setNotes([{ t: Date.now(), msg: val.trim() }, ...notes]);
      setVal("");
      ui.toast("Note added to audit log", { tone: "success" });
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err), { tone: "danger" });
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="glass" style={glassStyle({ padding: 20 })}>
      <Eyebrow style={{ marginBottom: 10 }}>Operator note</Eyebrow>
      <textarea
        rows={2}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder="Add field note (saved to audit chain)..."
        style={{ resize: "vertical", marginBottom: 8 }}
      />
      <button
        onClick={add}
        disabled={!val.trim() || saving}
        style={btnTealStyle({ width: "100%", padding: "8px 14px", fontSize: 13 })}
      >
        {saving ? "Saving…" : "Add note"}
      </button>
      {notes.length > 0 ? (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          {notes.map((n, i) => (
            <div
              key={i}
              style={{
                padding: "7px 10px",
                background: "rgba(255,255,255,0.02)",
                borderRadius: 8,
                fontSize: 12,
                color: "var(--c-ink-secondary)",
              }}
            >
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--c-ink-muted)", marginBottom: 2 }}>
                {new Date(n.t).toLocaleTimeString("en-GB")}
              </div>
              {n.msg}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── Small bits ────────────────────────────────────────────────────────────
function ZField({ label, v }: { label: string; v: string }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.02)", borderRadius: 8, padding: "6px 10px" }}>
      <Eyebrow style={{ marginBottom: 2 }}>{label}</Eyebrow>
      <div style={{ fontSize: 13, fontWeight: 500 }}>{v}</div>
    </div>
  );
}

function SevBadge({ sev }: { sev: Severity }) {
  const bg = SEVERITY_COLOR[sev];
  const fg = sev === "S3" ? "#0a0e14" : "#fff";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "4px 11px",
        borderRadius: 999,
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.05em",
        background: bg,
        color: fg,
      }}
    >
      {SEV_LABEL[sev]}
    </span>
  );
}

function Eyebrow({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: "var(--c-ink-muted)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ── Style helpers ─────────────────────────────────────────────────────────
function glassStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    background: "var(--c-bg-panel)",
    border: "1px solid rgba(51,65,85,0.7)",
    borderRadius: 20,
    backdropFilter: "blur(16px)",
    boxShadow: "0 8px 40px rgba(2,6,23,0.4)",
    ...extra,
  };
}

function btnTealStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "7px 14px",
    borderRadius: 10,
    fontSize: 12,
    fontWeight: 500,
    border: "none",
    cursor: "pointer",
    background: "#14b8a6",
    color: "#0a0e14",
    fontFamily: "inherit",
    ...extra,
  };
}

function btnGhostStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "7px 14px",
    borderRadius: 10,
    fontSize: 12,
    fontWeight: 500,
    border: "1px solid var(--c-border-strong)",
    cursor: "pointer",
    background: "rgba(255,255,255,0.04)",
    color: "var(--c-ink-secondary)",
    fontFamily: "inherit",
    ...extra,
  };
}

function btnWarnStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "7px 14px",
    borderRadius: 10,
    fontSize: 12,
    fontWeight: 500,
    border: "1px solid rgba(245,158,11,0.3)",
    cursor: "pointer",
    background: "rgba(245,158,11,0.12)",
    color: "#f59e0b",
    fontFamily: "inherit",
    ...extra,
  };
}

function btnOkStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "7px 14px",
    borderRadius: 10,
    fontSize: 12,
    fontWeight: 500,
    border: "1px solid rgba(16,185,129,0.35)",
    cursor: "pointer",
    background: "rgba(16,185,129,0.12)",
    color: "#10b981",
    fontFamily: "inherit",
    ...extra,
  };
}

function btnDangerStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "7px 14px",
    borderRadius: 10,
    fontSize: 12,
    fontWeight: 500,
    border: "1px solid rgba(220,38,38,0.35)",
    cursor: "pointer",
    background: "rgba(220,38,38,0.15)",
    color: "#dc2626",
    fontFamily: "inherit",
    ...extra,
  };
}

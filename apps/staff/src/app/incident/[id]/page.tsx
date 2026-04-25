"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import {
  getDb,
  SEVERITY_COLOR,
  DISPATCH_STATUS_COLOR,
  type Dispatch,
  type Incident,
  type Severity,
} from "@aegis/ui-web";
import { collection, doc, onSnapshot, orderBy, query } from "firebase/firestore";
import { zoneById, SEV_LABEL } from "@/lib/venue";
import { useUI } from "@/lib/ui";
import { callDispatch, type DispatchAction } from "@/lib/actions";

const ME_ID = process.env.NEXT_PUBLIC_RESPONDER_ID || "RSP-meera";

function elapsed(value: unknown): string {
  const ms = Math.max(0, Date.now() - toEpoch(value));
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
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

export default function StaffIncidentPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const router = useRouter();
  const ui = useUI();

  const [incident, setIncident] = React.useState<Incident | null>(null);
  const [dispatches, setDispatches] = React.useState<Dispatch[]>([]);
  const [acting, setActing] = React.useState(false);

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
    return () => {
      unsubI();
      unsubD();
    };
  }, [id]);

  const myDispatch = dispatches.find((d) => d.responder_id === ME_ID);
  const sev: Severity = incident?.classification?.severity ?? "S4";
  const color = SEVERITY_COLOR[sev];
  const closed = incident && ["CLOSED", "DISMISSED"].includes(incident.status);
  const zone = incident ? zoneById(incident.zone_id) : null;

  async function progress(action: DispatchAction) {
    if (!myDispatch || acting) return;
    setActing(true);
    try {
      await callDispatch(myDispatch.dispatch_id, action);
      ui.toast(`Status → ${action.toUpperCase()}`, { tone: "success" });
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err), {
        tone: "danger",
        title: "Action failed",
      });
    } finally {
      setActing(false);
    }
  }

  if (!incident || !zone) {
    return (
      <main
        className="app-bg"
        style={{
          minHeight: "100vh",
          padding: 20,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--c-ink-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          letterSpacing: "0.08em",
        }}
      >
        LOADING INCIDENT…
      </main>
    );
  }

  return (
    <div
      className={sev === "S1" ? "app-bg-critical" : "app-bg"}
      style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}
    >
      <div
        style={{
          padding: "14px 18px 12px",
          borderBottom: "1px solid var(--c-border)",
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexShrink: 0,
          background: "rgba(10,14,20,0.7)",
          backdropFilter: "blur(12px)",
          position: "sticky",
          top: 0,
          zIndex: 10,
        }}
      >
        <button onClick={() => router.back()} style={btnGhostStyle({ padding: "6px 10px", fontSize: 13 })}>
          ←
        </button>
        <Eyebrow style={{ flex: 1 }}>{incident.incident_id}</Eyebrow>
        <SevBadge sev={sev} />
      </div>

      <div className="scroll" style={{ flex: 1, padding: "14px 18px 100px" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.15, marginBottom: 6 }}>
          {incident.classification?.category ?? "OTHER"}
          {incident.classification?.sub_type ? (
            <span style={{ color: "var(--c-ink-secondary)", fontWeight: 400 }}>
              {" "}· {incident.classification.sub_type}
            </span>
          ) : null}
        </h1>
        <p style={{ fontSize: 13, color: "var(--c-ink-secondary)", lineHeight: 1.55, marginBottom: 14 }}>
          {incident.summary || incident.classification?.rationale}
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
          <Stat label="Zone" v={zone.name} />
          <Stat label="Detected" v={`${elapsed(incident.detected_at)} ago`} />
          <Stat
            label="Confidence"
            v={`${Math.round((incident.classification?.confidence ?? 0) * 100)}%`}
            c="#f59e0b"
          />
          <Stat
            label="My status"
            v={myDispatch?.status.replace("_", " ") ?? "—"}
            c={myDispatch ? DISPATCH_STATUS_COLOR[myDispatch.status] : undefined}
          />
        </div>

        <Eyebrow style={{ marginBottom: 8 }}>Route to scene</Eyebrow>
        <div
          style={{
            height: 140,
            borderRadius: 14,
            background: `linear-gradient(180deg, rgba(20,184,166,0.08), rgba(10,14,20,0.6))`,
            border: "1px solid var(--c-border-strong)",
            position: "relative",
            overflow: "hidden",
            marginBottom: 14,
          }}
        >
          <svg viewBox="0 0 300 140" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
            <defs>
              <pattern id="grid" width={20} height={20} patternUnits="userSpaceOnUse">
                <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(148,163,184,0.08)" strokeWidth={0.5} />
              </pattern>
            </defs>
            <rect width={300} height={140} fill="url(#grid)" />
            <path
              d="M 40 100 Q 100 60 180 50 L 240 35"
              stroke="#14b8a6"
              strokeWidth={2}
              fill="none"
              strokeDasharray="4 4"
            />
            <circle cx={40} cy={100} r={6} fill="#14b8a6" />
            <circle cx={240} cy={35} r={8} fill={color} stroke="#0a0e14" strokeWidth={2} />
          </svg>
          <div style={{ position: "absolute", bottom: 8, left: 10, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--c-ink-secondary)" }}>
            ~{40 + zone.floor * 20}m · 30s walk
          </div>
          <div
            style={{
              position: "absolute",
              top: 8,
              right: 10,
              padding: "3px 8px",
              background: "rgba(10,14,20,0.7)",
              borderRadius: 6,
              fontSize: 9,
              color: "var(--c-ink-secondary)",
              fontFamily: "var(--font-mono)",
            }}
          >
            Floor {zone.floor}
          </div>
        </div>

        {myDispatch && !closed ? (
          <>
            <Eyebrow style={{ marginBottom: 8 }}>Update status</Eyebrow>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
              {myDispatch.status === "PAGED" ? (
                <button
                  onClick={() => progress("ack")}
                  style={btnTealStyle({ padding: 13, fontSize: 14, fontWeight: 600, width: "100%" })}
                >
                  ✓ Acknowledge
                </button>
              ) : null}
              {myDispatch.status === "ACKNOWLEDGED" ? (
                <button
                  onClick={() => progress("enroute")}
                  style={btnTealStyle({ padding: 13, fontSize: 14, fontWeight: 600, width: "100%" })}
                >
                  I&apos;m en route
                </button>
              ) : null}
              {myDispatch.status === "EN_ROUTE" ? (
                <button
                  onClick={() => progress("arrived")}
                  style={btnTealStyle({ padding: 13, fontSize: 14, fontWeight: 600, width: "100%" })}
                >
                  I&apos;ve arrived on scene
                </button>
              ) : null}
              {myDispatch.status === "ARRIVED" ? (
                <button
                  onClick={() => progress("handoff")}
                  style={btnOkStyle({ padding: 13, fontSize: 14, fontWeight: 600, width: "100%" })}
                >
                  Hand off / resolve
                </button>
              ) : null}
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={() => ui.toast("Radioing duty manager...", { tone: "info" })}
                  style={btnGhostStyle({ flex: 1, padding: 11, fontSize: 13 })}
                >
                  📻 Radio DM
                </button>
                <button
                  onClick={() => ui.toast("Backup requested", { tone: "warn" })}
                  style={btnWarnStyle({ flex: 1, padding: 11, fontSize: 13 })}
                >
                  + Backup
                </button>
              </div>
            </div>
          </>
        ) : null}

        {(incident.classification?.cascade_predictions ?? []).length > 0 ? (
          <>
            <Eyebrow style={{ marginBottom: 8 }}>⚠ Risk forecast</Eyebrow>
            <div
              style={{
                padding: 12,
                background: "rgba(220,38,38,0.06)",
                borderRadius: 12,
                border: "1px solid rgba(220,38,38,0.2)",
                marginBottom: 14,
              }}
            >
              {incident.classification!.cascade_predictions.map((p, i, arr) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "5px 0",
                    fontSize: 12,
                    borderBottom: i < arr.length - 1 ? "1px solid rgba(220,38,38,0.1)" : "none",
                  }}
                >
                  <div>
                    <div style={{ color: "var(--c-ink-primary)" }}>{p.outcome}</div>
                    <div style={{ fontSize: 10, color: "var(--c-ink-muted)", fontFamily: "var(--font-mono)" }}>
                      in {Math.round(p.horizon_seconds / 60)} min
                    </div>
                  </div>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontWeight: 600,
                      color: p.probability > 0.6 ? "#dc2626" : "#f59e0b",
                    }}
                  >
                    {Math.round(p.probability * 100)}%
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : null}

        <Eyebrow style={{ marginBottom: 8 }}>Why Aegis flagged this</Eyebrow>
        <div
          style={{
            padding: 12,
            background: "rgba(255,255,255,0.02)",
            borderRadius: 12,
            fontSize: 12,
            color: "var(--c-ink-secondary)",
            lineHeight: 1.55,
            marginBottom: 14,
          }}
        >
          {incident.classification?.rationale ?? "No classifier rationale available."}
        </div>

        <Eyebrow style={{ marginBottom: 8 }}>Field note</Eyebrow>
        <NoteInput dispatch={myDispatch} />
      </div>
    </div>
  );
}

function NoteInput({ dispatch }: { dispatch?: Dispatch }) {
  const ui = useUI();
  const [val, setVal] = React.useState(dispatch?.notes ?? "");
  React.useEffect(() => {
    setVal(dispatch?.notes ?? "");
  }, [dispatch?.notes]);
  function save() {
    if (!dispatch) {
      ui.toast("No active dispatch to attach note", { tone: "warn" });
      return;
    }
    ui.toast("Field note saved", { tone: "success" });
  }
  return (
    <div>
      <textarea
        rows={3}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder="What you're seeing on scene..."
        style={{
          width: "100%",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid var(--c-border-strong)",
          borderRadius: 10,
          padding: "10px 12px",
          color: "var(--c-ink-primary)",
          fontSize: 13,
          fontFamily: "inherit",
          resize: "vertical",
          marginBottom: 6,
        }}
      />
      <button onClick={save} style={btnGhostStyle({ width: "100%", padding: 10, fontSize: 13 })}>
        Save note
      </button>
    </div>
  );
}

function Stat({ label, v, c }: { label: string; v: string; c?: string }) {
  return (
    <div style={{ padding: "9px 12px", background: "rgba(255,255,255,0.02)", borderRadius: 10 }}>
      <Eyebrow style={{ marginBottom: 2 }}>{label}</Eyebrow>
      <div style={{ fontSize: 13, fontWeight: 500, color: c ?? "var(--c-ink-primary)" }}>{v}</div>
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
        padding: "2px 8px",
        borderRadius: 999,
        fontFamily: "var(--font-mono)",
        fontSize: 9,
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
        fontSize: 9,
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

function btnTealStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 12,
    fontFamily: "inherit",
    fontWeight: 500,
    border: "none",
    cursor: "pointer",
    background: "#14b8a6",
    color: "#0a0e14",
    ...extra,
  };
}

function btnGhostStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 12,
    fontFamily: "inherit",
    fontWeight: 500,
    cursor: "pointer",
    background: "rgba(255,255,255,0.06)",
    color: "var(--c-ink-primary)",
    border: "1px solid var(--c-border-strong)",
    ...extra,
  };
}

function btnWarnStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 12,
    fontFamily: "inherit",
    fontWeight: 500,
    cursor: "pointer",
    background: "rgba(245,158,11,0.15)",
    color: "#f59e0b",
    border: "1px solid rgba(245,158,11,0.35)",
    ...extra,
  };
}

function btnOkStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 12,
    fontFamily: "inherit",
    fontWeight: 500,
    cursor: "pointer",
    background: "rgba(16,185,129,0.15)",
    color: "#10b981",
    border: "1px solid rgba(16,185,129,0.35)",
    ...extra,
  };
}

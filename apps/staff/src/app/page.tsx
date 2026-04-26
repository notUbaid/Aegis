"use client";

import * as React from "react";
import {
  getDb,
  useAuth,
  SEVERITY_COLOR,
  DISPATCH_STATUS_COLOR,
  type Dispatch,
  type Incident,
  type Severity,
} from "@aegis/ui-web";
import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  where,
  type QueryConstraint,
} from "firebase/firestore";
import { useRouter } from "next/navigation";
import { VENUE, SEV_LABEL, zoneById, responderById } from "@/lib/venue";
import { useUI } from "@/lib/ui";
import { callDispatch } from "@/lib/actions";
import { useFcmToken } from "@/lib/useFcmToken";

const DEFAULT_VENUE_ID = process.env.NEXT_PUBLIC_DEMO_VENUE_ID || "taj-ahmedabad";

const ACTIVE_DISPATCH = ["PAGED", "ACKNOWLEDGED", "EN_ROUTE", "ARRIVED"] as const;
const SEV_RANK: Record<Severity, number> = { S1: 0, S2: 1, S3: 2, S4: 3 };

const isActiveDispatch = (s: Dispatch["status"]) =>
  (ACTIVE_DISPATCH as readonly Dispatch["status"][]).includes(s);

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

type Tab = "home" | "history" | "profile";

export default function StaffApp() {
  const { user, loading: authLoading } = useAuth();
  const [responderId, setResponderId] = React.useState<string | null>(null);
  const [incidents, setIncidents] = React.useState<Incident[]>([]);
  const [dispatches, setDispatches] = React.useState<Dispatch[]>([]);
  const [venueId, setVenueId] = React.useState<string>(DEFAULT_VENUE_ID);
  const [tab, setTab] = React.useState<Tab>("home");
  const [error, setError] = React.useState<string | null>(null);
  const ui = useUI();
  const router = useRouter();

  // ── FCM push token registration ────────────────────────────────────────
  useFcmToken(user);

  // ── Auth guard ──────────────────────────────────────────────────────────
  React.useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
  }, [user, authLoading, router]);

  // ── Fetch responder_id from /users/{uid} ───────────────────────────────
  // This is the bridge: Firestore rules check /users/{uid}.responder_id == dispatch.responder_id
  React.useEffect(() => {
    if (!user) { setResponderId(null); return; }
    const db = getDb();
    getDoc(doc(db, "users", user.uid))
      .then((snap) => {
        const rid = snap.exists() ? (snap.data().responder_id as string | undefined) ?? null : null;
        setResponderId(rid);
      })
      .catch(() => setResponderId(null));
  }, [user]);

  const me = responderById(responderId ?? "");

  React.useEffect(() => {
    if (!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID) {
      setError("Firebase not configured. Set NEXT_PUBLIC_FIREBASE_* in apps/staff/.env.local.");
      return;
    }
    if (!responderId) return; // wait until we know who this user is
    try {
      const db = getDb();
      const cs: QueryConstraint[] = [where("venue_id", "==", venueId), orderBy("detected_at", "desc")];
      const qq = query(collection(db, "incidents"), ...cs);
      const unsubI = onSnapshot(
        qq,
        (snap) => setIncidents(snap.docs.map((d) => d.data() as Incident)),
        (err) => setError(err.message),
      );
      const dq = query(
        collectionGroup(db, "dispatches"),
        where("venue_id", "==", venueId),
        where("responder_id", "==", responderId),
        orderBy("paged_at", "desc"),
      );
      const unsubD = onSnapshot(
        dq,
        (snap) => setDispatches(snap.docs.map((d) => d.data() as Dispatch)),
        (err) => setError(err.message),
      );
      return () => {
        unsubI();
        unsubD();
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [venueId, responderId]);

  const myActive = React.useMemo(
    () =>
      dispatches
        .filter((d) => isActiveDispatch(d.status))
        .sort((a, b) => {
          const ai = incidents.find((x) => x.incident_id === a.incident_id);
          const bi = incidents.find((x) => x.incident_id === b.incident_id);
          const sa = SEV_RANK[ai?.classification?.severity ?? "S4"];
          const sb = SEV_RANK[bi?.classification?.severity ?? "S4"];
          if (sa !== sb) return sa - sb;
          return toEpoch(b.paged_at) - toEpoch(a.paged_at);
        }),
    [dispatches, incidents],
  );

  const topDispatch = myActive[0];
  const topIncident = topDispatch
    ? incidents.find((i) => i.incident_id === topDispatch.incident_id) ?? null
    : null;
  const pagedCount = myActive.filter((d) => d.status === "PAGED").length;

  // ── Auth / profile loading screen ───────────────────────────────────────────
  if (authLoading || !user) {
    return <div style={{ minHeight: "100vh", background: "var(--c-bg-primary)" }} />;
  }

  if (!me) {
    return (
      <main style={{ padding: 24, textAlign: "center" }}>
        <div style={{ fontFamily: "var(--font-mono)", color: "var(--c-ink-muted)", fontSize: 12 }}>
          {responderId ? `Responder ${responderId} not on roster.` : "Loading profile…"}
        </div>
      </main>
    );
  }

  return (
    <div
      className={topIncident?.classification?.severity === "S1" ? "app-bg-critical" : "app-bg"}
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        position: "relative",
      }}
    >
      {tab === "home" ? (
        <HomeView
          me={me}
          venueId={venueId}
          setVenueId={setVenueId}
          dispatches={myActive}
          incidents={incidents}
          topDispatch={topDispatch}
          topIncident={topIncident}
          openIncident={(id) => router.push(`/incident/${id}`)}
          error={error}
        />
      ) : null}
      {tab === "history" ? (
        <HistoryView
          me={me}
          dispatches={dispatches}
          incidents={incidents}
          openIncident={(id) => router.push(`/incident/${id}`)}
        />
      ) : null}
      {tab === "profile" ? <ProfileTab me={me} dispatches={dispatches} /> : null}

      <BottomNav tab={tab} setTab={setTab} alertCount={pagedCount} />
      {/* spacer for bottom nav */}
      <div style={{ height: 80 }} />

      {/* Subtle FAB hint to open drill console */}
      {tab === "home" ? (
        <button
          onClick={() => {
            ui.toast("Drill console opens in dashboard surface", { tone: "info" });
            router.push("/drill");
          }}
          style={{
            position: "fixed",
            right: 18,
            bottom: 90,
            padding: "10px 14px",
            background: "rgba(20,184,166,0.18)",
            color: "#14b8a6",
            border: "1px solid rgba(20,184,166,0.4)",
            borderRadius: 999,
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            cursor: "pointer",
          }}
        >
          Drill
        </button>
      ) : null}
    </div>
  );
}

// ── Home View ─────────────────────────────────────────────────────────────
function HomeView({
  me,
  venueId,
  setVenueId,
  dispatches,
  incidents,
  topDispatch,
  topIncident,
  openIncident,
  error,
}: {
  me: NonNullable<ReturnType<typeof responderById>>;
  venueId: string;
  setVenueId: (id: string) => void;
  dispatches: Dispatch[];
  incidents: Incident[];
  topDispatch?: Dispatch;
  topIncident: Incident | null;
  openIncident: (id: string) => void;
  error: string | null;
}) {
  const ui = useUI();
  return (
    <>
      <div
        style={{
          padding: "14px 18px 10px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexShrink: 0,
        }}
      >
        <div>
          <Eyebrow>Logged in</Eyebrow>
          <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>{me.display_name}</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select
            value={venueId}
            onChange={(e) => setVenueId(e.target.value)}
            style={{
              width: "auto",
              padding: "6px 10px",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
            }}
          >
            <option value="taj-ahmedabad">taj-ahmedabad</option>
            <option value="house-of-mg">house-of-mg</option>
            <option value="demo-venue">demo-venue</option>
          </select>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 10px",
              background: "rgba(16,185,129,0.12)",
              borderRadius: 999,
              border: "1px solid rgba(16,185,129,0.3)",
            }}
          >
            <span style={{ width: 6, height: 6, background: "#10b981", borderRadius: "50%" }} />
            <span style={{ fontSize: 10, color: "#10b981", fontFamily: "var(--font-mono)" }}>ON SHIFT</span>
          </div>
        </div>
      </div>

      <div className="scroll" style={{ flex: 1, padding: "4px 18px 80px" }}>
        {error ? (
          <div
            style={{
              padding: 14,
              background: "rgba(220,38,38,0.06)",
              border: "1px solid rgba(220,38,38,0.4)",
              borderRadius: 12,
              fontSize: 12,
              color: "var(--c-ink-secondary)",
              marginBottom: 12,
            }}
          >
            {error}
          </div>
        ) : null}

        {topIncident && topDispatch ? (
          <CriticalAlert
            incident={topIncident}
            dispatch={topDispatch}
            onOpen={() => openIncident(topIncident.incident_id)}
          />
        ) : null}

        {dispatches.length > 1 ? (
          <>
            <Eyebrow style={{ marginTop: 18, marginBottom: 8 }}>Other dispatches ({dispatches.length - 1})</Eyebrow>
            {dispatches.slice(1).map((d) => {
              const inc = incidents.find((i) => i.incident_id === d.incident_id);
              if (!inc) return null;
              return (
                <DispatchRow
                  key={d.dispatch_id}
                  dispatch={d}
                  incident={inc}
                  onClick={() => openIncident(inc.incident_id)}
                />
              );
            })}
          </>
        ) : null}

        {dispatches.length === 0 ? (
          <div style={{ padding: "40px 24px", textAlign: "center", marginTop: 40 }}>
            <div
              style={{
                width: 60,
                height: 60,
                margin: "0 auto 16px",
                borderRadius: "50%",
                background: "rgba(16,185,129,0.1)",
                border: "1px solid rgba(16,185,129,0.3)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth={2}>
                <path d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>All clear</div>
            <div style={{ fontSize: 13, color: "var(--c-ink-muted)", marginBottom: 16 }}>
              No active dispatches. You&apos;re on standby.
            </div>
            <button
              onClick={() => ui.toast("Standby mode confirmed", { tone: "info" })}
              style={btnGhostStyle({ padding: "10px 18px", fontSize: 13 })}
            >
              I&apos;m ready
            </button>
          </div>
        ) : null}

        <Eyebrow style={{ marginTop: 18, marginBottom: 8 }}>Your role</Eyebrow>
        <div
          style={{
            padding: 14,
            background: "rgba(255,255,255,0.03)",
            borderRadius: 14,
            border: "1px solid var(--c-border)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
            <div
              style={{
                width: 42,
                height: 42,
                borderRadius: 12,
                background: "linear-gradient(135deg, rgba(20,184,166,0.25), rgba(20,184,166,0.05))",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 600,
                color: "#14b8a6",
                fontSize: 14,
              }}
            >
              {me.display_name.split(" ").map((s) => s[0]).join("").slice(0, 2)}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{me.role}</div>
              <div style={{ fontSize: 11, color: "var(--c-ink-muted)" }}>{VENUE.name}</div>
            </div>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {me.skills.map((s) => (
              <span
                key={s}
                style={{
                  fontSize: 10,
                  padding: "3px 8px",
                  background: "rgba(20,184,166,0.08)",
                  border: "1px solid rgba(20,184,166,0.25)",
                  borderRadius: 6,
                  color: "#14b8a6",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {s}
              </span>
            ))}
          </div>
        </div>

        <Eyebrow style={{ marginTop: 18, marginBottom: 8 }}>Emergency contacts</Eyebrow>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {[
            { ...VENUE.nearby_services.ambulance[0], icon: "🚑" },
            { ...VENUE.nearby_services.fire[0], icon: "🔥" },
            { ...VENUE.nearby_services.police[0], icon: "🚓" },
          ].map((s, i) => (
            <button
              key={i}
              onClick={() => ui.toast(`Calling ${s.name}`, { tone: "info", title: s.phone })}
              style={btnGhostStyle({
                justifyContent: "space-between",
                padding: "12px 14px",
                width: "100%",
                fontSize: 13,
              })}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 18 }}>{s.icon}</span>
                <span style={{ textAlign: "left" }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{s.name}</div>
                  <div style={{ fontSize: 11, color: "var(--c-ink-muted)", fontFamily: "var(--font-mono)", fontWeight: 400 }}>
                    {s.distance_km}km
                  </div>
                </span>
              </span>
              <span style={{ fontFamily: "var(--font-mono)", color: "#14b8a6", fontSize: 13 }}>{s.phone}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

// ── Critical Alert ────────────────────────────────────────────────────────
function CriticalAlert({
  incident,
  dispatch,
  onOpen,
}: {
  incident: Incident;
  dispatch: Dispatch;
  onOpen: () => void;
}) {
  const ui = useUI();
  const sev = incident.classification?.severity ?? "S4";
  const color = SEVERITY_COLOR[sev];
  const isS1 = sev === "S1";
  const zone = zoneById(incident.zone_id);

  async function handleAck() {
    try {
      await callDispatch(dispatch.dispatch_id, "ack");
      ui.toast("Acknowledged", { tone: "success" });
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err), { tone: "danger", title: "Ack failed" });
    }
  }
  async function handleDecline() {
    const ok = await ui.confirm({
      title: "Decline this dispatch?",
      message: "Your duty manager will be notified and another responder will be paged.",
      tone: "danger",
      confirmLabel: "Decline",
    });
    if (!ok) return;
    try {
      await callDispatch(dispatch.dispatch_id, "decline");
      ui.toast("Dispatch declined", { tone: "warn" });
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err), { tone: "danger" });
    }
  }

  return (
    <div
      style={{
        animation: "aegis-slide-up 0.3s ease-out",
        borderRadius: 18,
        padding: 16,
        marginTop: 6,
        background: `linear-gradient(180deg, ${color}22 0%, ${color}08 100%)`,
        border: `1.5px solid ${color}${isS1 ? "88" : "55"}`,
        boxShadow: isS1 ? `0 0 30px ${color}33` : "none",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: color,
            animation: "aegis-dot-pulse 1.2s infinite",
            boxShadow: `0 0 10px ${color}`,
          }}
        />
        <Eyebrow style={{ color, fontSize: 10 }}>Active dispatch · {incident.incident_id}</Eyebrow>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
        <SevBadge sev={sev} />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--c-ink-muted)",
            padding: "2px 7px",
            background: "rgba(255,255,255,0.04)",
            borderRadius: 999,
          }}
        >
          {dispatch.status.replace("_", " ")}
        </span>
      </div>
      <h2 style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.15, marginBottom: 8 }}>
        {incident.classification?.category ?? "OTHER"}
        {incident.classification?.sub_type ? (
          <span style={{ color: "var(--c-ink-secondary)", fontWeight: 400 }}> · {incident.classification.sub_type}</span>
        ) : null}
      </h2>
      <p style={{ fontSize: 12, color: "var(--c-ink-secondary)", lineHeight: 1.5, marginBottom: 10 }}>
        {incident.summary}
      </p>
      <div style={{ display: "flex", gap: 12, fontSize: 11, marginBottom: 12, flexWrap: "wrap" }}>
        <span style={{ color: "var(--c-ink-muted)", fontFamily: "var(--font-mono)" }}>📍 {zone.name}</span>
        <span style={{ color: "var(--c-ink-muted)", fontFamily: "var(--font-mono)" }}>
          ⏱ {elapsed(dispatch.paged_at)} ago
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {dispatch.status === "PAGED" ? (
          <>
            <button
              onClick={handleAck}
              style={btnTealStyle({ padding: 14, fontSize: 14, fontWeight: 600, width: "100%" })}
            >
              ✓ Acknowledge & take this dispatch
            </button>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={onOpen} style={btnGhostStyle({ flex: 1, padding: 11, fontSize: 13 })}>
                Details
              </button>
              <button onClick={handleDecline} style={btnDangerStyle({ flex: 1, padding: 11, fontSize: 13 })}>
                Decline
              </button>
            </div>
          </>
        ) : (
          <button onClick={onOpen} style={btnTealStyle({ padding: 13, fontSize: 14, fontWeight: 600, width: "100%" })}>
            Open dispatch →
          </button>
        )}
      </div>
    </div>
  );
}

// ── Dispatch Row ──────────────────────────────────────────────────────────
function DispatchRow({
  dispatch,
  incident,
  onClick,
}: {
  dispatch: Dispatch;
  incident: Incident;
  onClick: () => void;
}) {
  const sev = incident.classification?.severity ?? "S4";
  const color = SEVERITY_COLOR[sev];
  const sColor = DISPATCH_STATUS_COLOR[dispatch.status];
  const zone = zoneById(incident.zone_id);
  return (
    <button
      onClick={onClick}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "11px 12px",
        borderRadius: 12,
        marginBottom: 6,
        background: "rgba(255,255,255,0.03)",
        border: `1px solid ${color}33`,
        color: "inherit",
        cursor: "pointer",
        textAlign: "left",
        fontFamily: "inherit",
      }}
    >
      <div style={{ width: 3, alignSelf: "stretch", borderRadius: 2, background: color }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{incident.classification?.category ?? "OTHER"}</span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "1px 6px",
              borderRadius: 999,
              fontFamily: "var(--font-mono)",
              fontSize: 8,
              fontWeight: 600,
              letterSpacing: "0.05em",
              background: color,
              color: sev === "S3" ? "#0a0e14" : "#fff",
            }}
          >
            {sev}
          </span>
        </div>
        <div style={{ fontSize: 11, color: "var(--c-ink-muted)" }}>
          {zone.name} · {elapsed(dispatch.paged_at)}
        </div>
      </div>
      <span
        style={{
          fontSize: 9,
          color: sColor,
          fontFamily: "var(--font-mono)",
          padding: "2px 7px",
          background: `${sColor}15`,
          borderRadius: 999,
          border: `1px solid ${sColor}40`,
        }}
      >
        {dispatch.status.replace("_", " ")}
      </span>
    </button>
  );
}

// ── History ───────────────────────────────────────────────────────────────
function HistoryView({
  dispatches,
  incidents,
  openIncident,
}: {
  me: NonNullable<ReturnType<typeof responderById>>;
  dispatches: Dispatch[];
  incidents: Incident[];
  openIncident: (id: string) => void;
}) {
  return (
    <>
      <div style={{ padding: "14px 18px 8px" }}>
        <Eyebrow>My history</Eyebrow>
        <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>{dispatches.length} dispatches</h2>
      </div>
      <div className="scroll" style={{ flex: 1, padding: "4px 18px 80px" }}>
        {dispatches.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--c-ink-muted)", fontSize: 13 }}>
            No dispatches yet.
          </div>
        ) : null}
        {dispatches.map((d) => {
          const inc = incidents.find((i) => i.incident_id === d.incident_id);
          return inc ? (
            <DispatchRow
              key={d.dispatch_id}
              dispatch={d}
              incident={inc}
              onClick={() => openIncident(inc.incident_id)}
            />
          ) : null;
        })}
      </div>
    </>
  );
}

// ── Profile (inline tab) ──────────────────────────────────────────────────
function ProfileTab({
  me,
  dispatches,
}: {
  me: NonNullable<ReturnType<typeof responderById>>;
  dispatches: Dispatch[];
}) {
  const [onShift, setOnShift] = React.useState(true);
  const ui = useUI();
  return (
    <>
      <div style={{ padding: "14px 18px 8px" }}>
        <Eyebrow>Profile</Eyebrow>
        <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>{me.display_name}</h2>
      </div>
      <div className="scroll" style={{ flex: 1, padding: "4px 18px 80px" }}>
        <div
          style={{
            padding: 18,
            borderRadius: 16,
            background: "linear-gradient(135deg, rgba(20,184,166,0.18), rgba(20,184,166,0.04))",
            border: "1px solid rgba(20,184,166,0.3)",
            marginBottom: 14,
          }}
        >
          <div
            style={{
              width: 60,
              height: 60,
              borderRadius: 18,
              background: "rgba(20,184,166,0.2)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 22,
              fontWeight: 600,
              color: "#14b8a6",
              marginBottom: 10,
            }}
          >
            {me.display_name.split(" ").map((s) => s[0]).join("").slice(0, 2)}
          </div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{me.display_name}</div>
          <div style={{ fontSize: 13, color: "var(--c-ink-secondary)", marginTop: 2 }}>
            {me.role} · {VENUE.name}
          </div>
        </div>

        <div
          style={{
            padding: 14,
            background: "rgba(255,255,255,0.03)",
            borderRadius: 12,
            marginBottom: 10,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>On-shift</div>
            <div style={{ fontSize: 11, color: "var(--c-ink-muted)" }}>
              {onShift ? "Available for dispatch" : "Off-duty"}
            </div>
          </div>
          <button
            onClick={() => {
              setOnShift((s) => !s);
              ui.toast(onShift ? "Off duty" : "On shift", { tone: onShift ? "info" : "success" });
            }}
            style={{
              width: 44,
              height: 24,
              borderRadius: 999,
              background: onShift ? "#10b981" : "var(--c-border-strong)",
              border: "none",
              position: "relative",
              cursor: "pointer",
              transition: "all 200ms ease",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 2,
                left: onShift ? 22 : 2,
                width: 20,
                height: 20,
                borderRadius: "50%",
                background: "#fff",
                transition: "all 200ms ease",
              }}
            />
          </button>
        </div>

        <Eyebrow style={{ marginTop: 14, marginBottom: 8 }}>Skills & languages</Eyebrow>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 12 }}>
          {me.skills.map((s) => (
            <span
              key={s}
              style={{
                fontSize: 10,
                padding: "3px 9px",
                background: "rgba(20,184,166,0.08)",
                border: "1px solid rgba(20,184,166,0.25)",
                borderRadius: 6,
                color: "#14b8a6",
                fontFamily: "var(--font-mono)",
              }}
            >
              {s}
            </span>
          ))}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 14 }}>
          {me.languages.map((l) => (
            <span
              key={l}
              style={{
                fontSize: 10,
                padding: "3px 9px",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid var(--c-border-strong)",
                borderRadius: 6,
                color: "var(--c-ink-secondary)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {l.toUpperCase()}
            </span>
          ))}
        </div>

        <Eyebrow style={{ marginTop: 14, marginBottom: 8 }}>Stats</Eyebrow>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Stat label="Total dispatches" v={String(dispatches.length)} />
          <Stat
            label="Credential"
            v={me.credential_valid ? "Valid" : "Expired"}
            c={me.credential_valid ? "#10b981" : "#dc2626"}
          />
        </div>

        <button
          onClick={() => ui.toast("Logged out", { tone: "info" })}
          style={btnGhostStyle({ width: "100%", padding: 12, fontSize: 13, marginTop: 18 })}
        >
          Log out
        </button>
      </div>
    </>
  );
}

// ── Bottom Nav ────────────────────────────────────────────────────────────
function BottomNav({
  tab,
  setTab,
  alertCount,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  alertCount: number;
}) {
  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "home", label: "Alerts", icon: "M5 12l-1.5 9h17L19 12M5 12V8a7 7 0 0114 0v4M5 12h14" },
    { id: "history", label: "History", icon: "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" },
    { id: "profile", label: "Me", icon: "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" },
  ];
  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        padding: "8px 16px 24px",
        background: "rgba(10,14,20,0.92)",
        backdropFilter: "blur(16px)",
        borderTop: "1px solid var(--c-border)",
        display: "flex",
        justifyContent: "space-around",
        zIndex: 50,
      }}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => setTab(t.id)}
          style={{
            background: "transparent",
            border: "none",
            padding: "6px 16px",
            cursor: "pointer",
            position: "relative",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 3,
          }}
        >
          <svg
            width={22}
            height={22}
            viewBox="0 0 24 24"
            fill="none"
            stroke={tab === t.id ? "#14b8a6" : "var(--c-ink-muted)"}
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d={t.icon} />
          </svg>
          <span
            style={{
              fontSize: 10,
              color: tab === t.id ? "#14b8a6" : "var(--c-ink-muted)",
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.05em",
            }}
          >
            {t.label}
          </span>
          {t.id === "home" && alertCount > 0 ? (
            <span
              style={{
                position: "absolute",
                top: 2,
                right: 8,
                minWidth: 14,
                height: 14,
                padding: "0 4px",
                borderRadius: 999,
                background: "#dc2626",
                fontSize: 9,
                fontWeight: 600,
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: "var(--font-mono)",
              }}
            >
              {alertCount}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

// ── Bits ──────────────────────────────────────────────────────────────────
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

function Stat({ label, v, c }: { label: string; v: string; c?: string }) {
  return (
    <div style={{ padding: "9px 12px", background: "rgba(255,255,255,0.02)", borderRadius: 10 }}>
      <Eyebrow style={{ marginBottom: 2 }}>{label}</Eyebrow>
      <div style={{ fontSize: 13, fontWeight: 500, color: c ?? "var(--c-ink-primary)" }}>{v}</div>
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

function btnDangerStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 12,
    fontFamily: "inherit",
    fontWeight: 500,
    cursor: "pointer",
    background: "rgba(220,38,38,0.18)",
    color: "#dc2626",
    border: "1px solid rgba(220,38,38,0.4)",
    ...extra,
  };
}

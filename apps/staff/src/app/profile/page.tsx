"use client";

import * as React from "react";
import Link from "next/link";
import { VENUE, responderById } from "@/lib/venue";
import { useUI } from "@/lib/ui";

const ME_ID = process.env.NEXT_PUBLIC_RESPONDER_ID || "RSP-meera";

export default function ProfilePage() {
  const ui = useUI();
  const me = responderById(ME_ID);
  const [onShift, setOnShift] = React.useState(true);

  if (!me) {
    return (
      <main className="app-bg" style={{ minHeight: "100vh", padding: 18 }}>
        <Link
          href="/"
          style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--c-ink-muted)" }}
        >
          ← INCIDENTS
        </Link>
        <div style={{ marginTop: 24, color: "var(--c-ink-muted)", fontSize: 13 }}>
          Responder {ME_ID} not on roster.
        </div>
      </main>
    );
  }

  const initials = me.display_name.split(" ").map((s) => s[0]).join("").slice(0, 2);

  return (
    <main className="app-bg" style={{ minHeight: "100vh", padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Link href="/" style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--c-ink-muted)" }}>
          ← INCIDENTS
        </Link>
        <Eyebrow>Profile</Eyebrow>
      </div>

      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "8px 0 14px" }}>{me.display_name}</h1>

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
          {initials}
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

      <Eyebrow style={{ marginTop: 14, marginBottom: 8 }}>Skills</Eyebrow>
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

      <Eyebrow style={{ marginBottom: 8 }}>Languages</Eyebrow>
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

      <Eyebrow style={{ marginBottom: 8 }}>Identity</Eyebrow>
      <div
        style={{
          padding: 14,
          background: "rgba(255,255,255,0.02)",
          borderRadius: 12,
          fontSize: 13,
          color: "var(--c-ink-secondary)",
          lineHeight: 1.55,
        }}
      >
        Phone-OTP auth lands in Phase 2. For the Phase 1 judge demo, this app
        runs in read-only mode anchored to the demo venue.
        <div style={{ marginTop: 10, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--c-ink-muted)" }}>
          venue_id · {process.env.NEXT_PUBLIC_DEMO_VENUE_ID || "taj-ahmedabad"}
        </div>
      </div>
    </main>
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

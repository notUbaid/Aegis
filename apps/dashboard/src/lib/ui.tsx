"use client";

import * as React from "react";
import { createPortal } from "react-dom";

export type Tone = "success" | "info" | "warn" | "danger";

interface ToastSpec {
  id: number;
  msg: string;
  title?: string;
  tone: Tone;
}

interface ConfirmSpec {
  id: number;
  title: string;
  message?: string;
  tone?: Tone;
  eyebrow?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  resolve: (val: boolean) => void;
}

interface UICtx {
  toast: (msg: string, opts?: { title?: string; tone?: Tone; duration?: number }) => void;
  error: (msg: string, opts?: { title?: string }) => void;
  confirm: (opts: Omit<ConfirmSpec, "id" | "resolve">) => Promise<boolean>;
}

const Ctx = React.createContext<UICtx | null>(null);

const TONE_COLOR: Record<Tone, { bg: string; border: string; fg: string; icon: string }> = {
  success: { bg: "rgba(16,185,129,0.12)", border: "rgba(16,185,129,0.4)", fg: "#10b981", icon: "✓" },
  info: { bg: "rgba(20,184,166,0.10)", border: "rgba(20,184,166,0.35)", fg: "#14b8a6", icon: "●" },
  warn: { bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.4)", fg: "#f59e0b", icon: "!" },
  danger: { bg: "rgba(220,38,38,0.14)", border: "rgba(220,38,38,0.45)", fg: "#dc2626", icon: "⚠" },
};

const ACCENT: Record<Tone, string> = {
  success: "#10b981",
  info: "#14b8a6",
  warn: "#f59e0b",
  danger: "#dc2626",
};

export function UIProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastSpec[]>([]);
  const [confirms, setConfirms] = React.useState<ConfirmSpec[]>([]);
  const [mounted, setMounted] = React.useState(false);
  const idRef = React.useRef(0);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const dismiss = React.useCallback((id: number) => {
    setToasts((t) => t.filter((tt) => tt.id !== id));
  }, []);

  const toast = React.useCallback<UICtx["toast"]>((msg, opts) => {
    const id = ++idRef.current;
    const tone = opts?.tone ?? "info";
    const duration = opts?.duration ?? 4200;
    setToasts((t) => [...t, { id, msg, title: opts?.title, tone }]);
    setTimeout(() => dismiss(id), duration);
  }, [dismiss]);

  const error = React.useCallback<UICtx["error"]>((msg, opts) => {
    toast(msg, { tone: "danger", title: opts?.title ?? "Error", duration: 8000 });
  }, [toast]);

  const confirm = React.useCallback<UICtx["confirm"]>((opts) => {
    return new Promise<boolean>((resolve) => {
      const id = ++idRef.current;
      setConfirms((c) => [...c, { ...opts, id, resolve }]);
    });
  }, []);

  const closeConfirm = React.useCallback((id: number, val: boolean) => {
    setConfirms((c) => {
      const target = c.find((cc) => cc.id === id);
      target?.resolve(val);
      return c.filter((cc) => cc.id !== id);
    });
  }, []);

   return (
     <Ctx.Provider value={{ toast, error, confirm }}>
       {children}
      {mounted ? createPortal(
        <>
          <div
            style={{
              position: "fixed",
              top: 70,
              right: 18,
              zIndex: 9999,
              display: "flex",
              flexDirection: "column",
              gap: 8,
              pointerEvents: "none",
              maxWidth: 340,
            }}
          >
            {toasts.map((t) => {
              const c = TONE_COLOR[t.tone];
              return (
                <div
                  key={t.id}
                  style={{
                    background: "rgba(10,14,20,0.96)",
                    backdropFilter: "blur(16px)",
                    border: `1px solid ${c.border}`,
                    borderRadius: 12,
                    padding: "12px 14px",
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    pointerEvents: "auto",
                    boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
                    animation: "aegis-toast-in 0.22s ease-out",
                    fontSize: 13,
                    color: "#f1f5f9",
                  }}
                >
                  <span
                    style={{
                      background: c.bg,
                      color: c.fg,
                      width: 22,
                      height: 22,
                      borderRadius: 6,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 12,
                      fontWeight: 700,
                      flexShrink: 0,
                    }}
                  >
                    {c.icon}
                  </span>
                  <div style={{ flex: 1, lineHeight: 1.45 }}>
                    {t.title ? (
                      <div style={{ fontWeight: 600, marginBottom: 2 }}>{t.title}</div>
                    ) : null}
                    <div style={{ color: "#94a3b8", fontSize: 12 }}>{t.msg}</div>
                  </div>
                  <button
                    onClick={() => dismiss(t.id)}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "#64748b",
                      cursor: "pointer",
                      padding: "0 4px",
                      fontSize: 14,
                    }}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>

          {confirms.map((cf) => {
            const tone = cf.tone ?? "info";
            const accent = ACCENT[tone];
            return (
              <div
                key={cf.id}
                onClick={(e) => {
                  if (e.target === e.currentTarget) closeConfirm(cf.id, false);
                }}
                style={{
                  position: "fixed",
                  inset: 0,
                  background: "rgba(2,6,23,0.7)",
                  backdropFilter: "blur(4px)",
                  zIndex: 10000,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  animation: "aegis-fade-in 0.15s ease-out",
                }}
              >
                <div
                  style={{
                    background: "rgba(18,24,33,0.98)",
                    border: `1px solid ${accent}55`,
                    borderRadius: 18,
                    padding: "22px 24px",
                    maxWidth: 420,
                    width: "90%",
                    boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
                    animation: "aegis-modal-in 0.18s ease-out",
                  }}
                >
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      color: accent,
                      letterSpacing: "0.14em",
                      textTransform: "uppercase",
                      marginBottom: 8,
                    }}
                  >
                    {cf.eyebrow ?? "Confirm action"}
                  </div>
                  <h3
                    style={{
                      fontSize: 18,
                      fontWeight: 600,
                      margin: "0 0 8px",
                      color: "#f1f5f9",
                    }}
                  >
                    {cf.title}
                  </h3>
                  {cf.message ? (
                    <p style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.55, margin: "0 0 18px" }}>
                      {cf.message}
                    </p>
                  ) : null}
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button
                      onClick={() => closeConfirm(cf.id, false)}
                      style={{
                        background: "rgba(255,255,255,0.04)",
                        color: "#94a3b8",
                        border: "1px solid #334155",
                        borderRadius: 10,
                        padding: "8px 16px",
                        fontSize: 13,
                        cursor: "pointer",
                      }}
                    >
                      {cf.cancelLabel ?? "Cancel"}
                    </button>
                    <button
                      onClick={() => closeConfirm(cf.id, true)}
                      style={{
                        background: accent,
                        color: "#0a0e14",
                        border: "none",
                        borderRadius: 10,
                        padding: "8px 18px",
                        fontSize: 13,
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      {cf.confirmLabel ?? "Confirm"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}

          <style>{`
            @keyframes aegis-toast-in { from { opacity:0; transform:translateX(20px); } to { opacity:1; transform:translateX(0); } }
            @keyframes aegis-fade-in { from { opacity:0; } to { opacity:1; } }
            @keyframes aegis-modal-in { from { opacity:0; transform:translateY(8px) scale(0.98); } to { opacity:1; transform:translateY(0) scale(1); } }
            @keyframes aegis-dot-pulse { 0%,100%{ opacity:1; } 50%{ opacity:0.35; } }
            @keyframes aegis-glow-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(220,38,38,0.5); } 50% { box-shadow: 0 0 0 3px rgba(220,38,38,0.15); } }
            @keyframes aegis-fade-up { from { opacity:0; transform: translateY(6px); } to { opacity:1; transform: translateY(0); } }
            @keyframes aegis-slide-in { from { opacity:0; transform: translateX(16px); } to { opacity:1; transform: translateX(0); } }
            @keyframes aegis-slide-up { from { opacity:0; transform: translateY(20px); } to { opacity:1; transform: translateY(0); } }
          `}</style>
        </>,
        document.body,
      ) : null}
    </Ctx.Provider>
  );
}

export function useUI(): UICtx {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error("useUI must be used within UIProvider");
  return ctx;
}

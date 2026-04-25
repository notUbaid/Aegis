/* eslint-disable */
"use client";

/**
 * Global loading UI for the Dashboard app.
 * Shown during initial page load and route transitions.
 */
export default function Loading() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        padding: "2rem",
        fontFamily: "var(--font-body)",
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          border: "4px solid var(--color-border)",
          borderTopColor: "var(--color-accent)",
          borderRadius: "50%",
          animation: "spin 1s linear infinite",
        }}
      />
      <style jsx>{`
        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
      <p style={{ marginTop: "1rem", color: "var(--color-muted)" }}>
        Loading Aegis Dashboard…
      </p>
    </div>
  );
}

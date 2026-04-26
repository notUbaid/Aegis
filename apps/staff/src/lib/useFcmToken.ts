"use client";
import React from "react";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import {
  getDb,
  readFirebaseConfig,
  requestNotificationToken,
  onForegroundMessage,
} from "@aegis/ui-web";
import type { User } from "firebase/auth";

const VAPID_KEY = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY ?? "";

async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
  const config = readFirebaseConfig();
  // SW may still be installing — try active first, fall through to others
  const sw = reg.active ?? reg.installing ?? reg.waiting;
  sw?.postMessage({ type: "AEGIS_FCM_INIT", config });
}

export function useFcmToken(user: User | null): void {
  React.useEffect(() => {
    if (!user || !VAPID_KEY) return;
    let cancelled = false;

    (async () => {
      try {
        await registerServiceWorker();
        const token = await requestNotificationToken(VAPID_KEY);
        if (!token || cancelled) return;
        const db = getDb();
        const deviceId = token.slice(0, 16);
        await setDoc(
          doc(db, "users", user.uid, "devices", deviceId),
          { token, platform: "web", updated_at: serverTimestamp() },
          { merge: true },
        );
      } catch {
        // Non-fatal — push notifications are best-effort
      }
    })();

    const unsub = onForegroundMessage((payload) => {
      const { title = "Aegis Alert", body = "" } = payload.notification ?? {};
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification(title, { body, icon: "/icon.svg" });
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [user]);
}

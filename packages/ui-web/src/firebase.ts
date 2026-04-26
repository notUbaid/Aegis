/**
 * Shared Firebase web SDK bootstrap.
 *
 * Reads configuration from ``NEXT_PUBLIC_FIREBASE_*`` env vars so the same
 * module works in both ``apps/staff`` (PWA) and ``apps/dashboard`` (desktop).
 * Auto-connects to the Firestore emulator when ``NEXT_PUBLIC_USE_EMULATOR=1``.
 */

import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  getFirestore,
  connectFirestoreEmulator,
  type Firestore,
} from "firebase/firestore";
import {
  getAuth,
  connectAuthEmulator,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";
import {
  getMessaging,
  getToken,
  onMessage,
  type Messaging,
  type MessagePayload,
} from "firebase/messaging";

export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

export function readFirebaseConfig(): FirebaseConfig {
  return {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "",
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "",
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "",
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? "",
    messagingSenderId:
      process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "",
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? "",
  };
}

let _app: FirebaseApp | null = null;
let _db: Firestore | null = null;
let _auth: Auth | null = null;

export function getFirebaseApp(): FirebaseApp {
  if (_app) return _app;
  const config = readFirebaseConfig();
  _app = getApps().length ? getApps()[0]! : initializeApp(config);
  return _app;
}

function isAlreadyConnectedError(err: unknown): boolean {
  const msg =
    err && typeof err === "object" && "message" in err
      ? String((err as { message: unknown }).message)
      : "";
  return /already.*(connected|started|been called)/i.test(msg);
}

export function getDb(): Firestore {
  if (_db) return _db;
  const db = getFirestore(getFirebaseApp());
  if (
    typeof window !== "undefined" &&
    process.env.NEXT_PUBLIC_USE_EMULATOR === "1"
  ) {
    try {
      connectFirestoreEmulator(db, "127.0.0.1", 8080);
    } catch (err) {
      if (!isAlreadyConnectedError(err)) {
        // eslint-disable-next-line no-console
        console.error("connectFirestoreEmulator failed", err);
        throw err;
      }
    }
  }
  _db = db;
  return _db;
}

export function getFirebaseAuth(): Auth {
  if (_auth) return _auth;
  const auth = getAuth(getFirebaseApp());
  if (
    typeof window !== "undefined" &&
    process.env.NEXT_PUBLIC_USE_EMULATOR === "1"
  ) {
    try {
      connectAuthEmulator(auth, "http://127.0.0.1:9099", {
        disableWarnings: true,
      });
    } catch (err) {
      if (!isAlreadyConnectedError(err)) {
        // eslint-disable-next-line no-console
        console.error("connectAuthEmulator failed", err);
        throw err;
      }
    }
  }
  _auth = auth;
  return _auth;
}

export function getCurrentUser(): User | null {
  return getFirebaseAuth().currentUser;
}

/** Sign in with Google — popup flow. */
export async function signInWithGoogle(): Promise<User> {
  const auth = getFirebaseAuth();
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(auth, provider);
  return result.user;
}

/** Sign in with email + password. */
export async function signInWithEmail(
  email: string,
  password: string,
): Promise<User> {
  const auth = getFirebaseAuth();
  const result = await signInWithEmailAndPassword(auth, email, password);
  return result.user;
}

/** Sign out current user. */
export async function doSignOut(): Promise<void> {
  const auth = getFirebaseAuth();
  await signOut(auth);
}

/** Return `{ Authorization: "Bearer <token>" }` for the signed-in user, or `{}`. */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const user = getFirebaseAuth().currentUser;
  if (!user) return {};
  try {
    const token = await user.getIdToken();
    return { Authorization: `Bearer ${token}` };
  } catch {
    return {};
  }
}

// ── Firebase Messaging ────────────────────────────────────────────────────

let _messaging: Messaging | null = null;

export function getFirebaseMessaging(): Messaging | null {
  if (typeof window === "undefined") return null;
  if (_messaging) return _messaging;
  try {
    _messaging = getMessaging(getFirebaseApp());
    return _messaging;
  } catch {
    return null;
  }
}

/**
 * Request push permission and return the FCM registration token.
 * Returns null if permission denied, messaging unavailable, or no service worker.
 */
export async function requestNotificationToken(vapidKey: string): Promise<string | null> {
  if (typeof window === "undefined" || !("Notification" in window)) return null;
  const messaging = getFirebaseMessaging();
  if (!messaging) return null;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return null;
    const registration = await navigator.serviceWorker.ready;
    return await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
  } catch {
    return null;
  }
}

/**
 * Subscribe to foreground FCM messages (app in focus).
 * Returns an unsubscribe function.
 */
export function onForegroundMessage(
  handler: (payload: MessagePayload) => void,
): () => void {
  const messaging = getFirebaseMessaging();
  if (!messaging) return () => {};
  return onMessage(messaging, handler);
}

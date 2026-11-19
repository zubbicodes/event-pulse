export type PushSetupResult =
  | { status: "unsupported"; message: string }
  | { status: "denied"; message: string }
  | { status: "misconfigured"; message: string }
  | { status: "ready"; message: string; subscription?: PushSubscription };

const SERVICE_WORKER_URL = "/sw.js";
const VAPID_PUBLIC_KEY = import.meta.env["VITE_VAPID_PUBLIC_KEY"] as string | undefined;

export function canUsePwaFeatures() {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "Notification" in window;
}

export async function registerAppServiceWorker() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return undefined;
  const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL);
  await navigator.serviceWorker.ready;
  return registration;
}

export async function setupPushNotifications(): Promise<PushSetupResult> {
  if (!canUsePwaFeatures()) {
    return {
      status: "unsupported",
      message: "This browser does not support service workers and notifications.",
    };
  }

  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission()
      : Notification.permission;

  if (permission !== "granted") {
    return {
      status: "denied",
      message: "Notification permission is not granted.",
    };
  }

  const registration = await registerAppServiceWorker();
  if (!registration) {
    return {
      status: "unsupported",
      message: "Service worker registration failed.",
    };
  }

  if (!("PushManager" in window)) {
    return {
      status: "ready",
      message: "Notifications are enabled. PushManager is unavailable in this browser.",
    };
  }

  if (!VAPID_PUBLIC_KEY) {
    return {
      status: "misconfigured",
      message: "Push is not configured. Add VITE_VAPID_PUBLIC_KEY and rebuild the app.",
    };
  }

  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    }));

  return {
    status: "ready",
    message: "Push subscription created. Backend can store this subscription.",
    subscription,
  };
}

export async function showTestNotification() {
  const result = await setupPushNotifications();
  if (result.status !== "ready") return result;

  const registration = await navigator.serviceWorker.ready;
  registration.active?.postMessage({ type: "EVENTPULSE_TEST_NOTIFICATION" });

  return {
    ...result,
    message: "Test notification sent through the service worker.",
  };
}

function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

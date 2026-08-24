const CACHE_NAME = "eventpulse-shell-v1";
const APP_SHELL = ["/", "/manifest.webmanifest", "/favicon.ico", "/icon.svg"];
const ALERT_VIBRATION_PATTERN = [200, 80, 200, 80, 350];

function buildAlertOptions({ body, tag, url }) {
  return {
    body,
    icon: "/icon.svg",
    badge: "/favicon.ico",
    tag,
    renotify: true,
    requireInteraction: true,
    silent: false,
    timestamp: Date.now(),
    vibrate: ALERT_VIBRATION_PATTERN,
    actions: [{ action: "open", title: "Open HD-1" }],
    data: { url: url || "/" },
  };
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match("/"))),
  );
});

self.addEventListener("push", (event) => {
  let payload = {
    title: "HD-1 Drop Monitor Alert",
    body: "New ticket activity detected.",
    url: "/",
  };

  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      payload.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(
      payload.title,
      buildAlertOptions({
        body: payload.body,
        tag: "eventpulse-alert",
        url: payload.url,
      }),
    ),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "EVENTPULSE_TEST_NOTIFICATION") return;

  event.waitUntil(
    self.registration.showNotification(
      "HD-1 Drop Monitor test alert",
      buildAlertOptions({
        body: "Push notification path is ready for backend wiring.",
        tag: `eventpulse-test-${Date.now()}`,
        url: "/",
      }),
    ),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => "focus" in client);
      if (!existing) return self.clients.openWindow(url);

      if ("navigate" in existing && existing.url !== url) {
        return existing.navigate(url).then(() => existing.focus());
      }
      return existing.focus();
    }),
  );
});

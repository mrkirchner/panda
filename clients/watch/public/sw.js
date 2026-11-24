// Panda's web app: "Dune is ready to watch" while the browser isn't on Panda (Web Push from the
// server, services/web_push.rs). Shows the message; a click opens (or focuses) the app on it.
self.addEventListener("push", (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {
    msg = {};
  }
  const base = self.registration.scope;
  event.waitUntil(
    self.registration.showNotification(msg.title || "Panda", {
      body: msg.body || "",
      icon: `${base}favicon.svg`,
      tag: msg.open || "panda",
      data: { url: msg.open ? base + msg.open.replace(/^\//, "") : base },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || self.registration.scope;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => w.url.startsWith(self.registration.scope));
      if (open) return open.focus().then(() => open.navigate(url));
      return self.clients.openWindow(url);
    }),
  );
});

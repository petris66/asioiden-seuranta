self.addEventListener("push", event => {
  const message = event.data?.json() || {};
  event.waitUntil(self.registration.showNotification("Asioiden seuranta", {
    body: message.body || "Ajastettu muistutus",
    tag: message.tag || "seuranta"
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(new URL("asianseuranta.html", self.registration.scope).href));
});

/* Push notifications. Imported into the generated service worker (vite.config.js → workbox.importScripts), so it
   runs even when the app is closed. The message comes from the oe-push edge function:
   { title, body, url, tag, badge } — badge is the number of requests waiting for approval, shown on the app icon. */

self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch (e) {
    d = { body: event.data ? event.data.text() : "" };
  }
  const title = d.title || "Project Expense Monitoring";
  const options = {
    body: d.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    tag: d.tag || "oe",
    renotify: !!d.tag,
    data: { url: d.url || "/" },
  };
  const jobs = [self.registration.showNotification(title, options)];
  if (typeof d.badge === "number" && self.navigator.setAppBadge)
    jobs.push((d.badge > 0 ? self.navigator.setAppBadge(d.badge) : self.navigator.clearAppBadge()).catch(() => {}));
  event.waitUntil(Promise.all(jobs));
});

// Tapping the notification opens the app on the page it names, reusing an open tab when there is one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data && event.notification.data.url; // none = just bring the app to the front
  const url = new URL(target || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => c.url.startsWith(self.location.origin));
      if (open) return open.focus().then((c) => (target && c && c.navigate ? c.navigate(url) : c));
      return self.clients.openWindow(url);
    })
  );
});

// The push service may replace a subscription; renew it so the next app launch can save the new address.
self.addEventListener("pushsubscriptionchange", (event) => {
  const old = event.oldSubscription;
  if (!old || !old.options) return;
  event.waitUntil(self.registration.pushManager.subscribe(old.options).catch(() => {}));
});

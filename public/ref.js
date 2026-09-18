(function () {
  try {
    var ref = new URLSearchParams(location.search).get("ref") || "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(ref)) return;
    var body = JSON.stringify({ ref: ref, path: location.pathname || "/" });
    var url = "/.netlify/functions/outreach-stats";
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      return;
    }
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body,
      keepalive: true,
    }).catch(function () {});
  } catch (e) {}
})();

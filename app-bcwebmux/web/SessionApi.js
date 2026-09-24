// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const MAX_RESPONSE_BYTES = 64 * 1024;

export class SessionApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "SessionApiError";
    this.status = options.status ?? 0;
    this.code = options.code ?? "request_failed";
    this.details = options.details ?? null;
  }
}

async function readBoundedText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new SessionApiError("session API response is too large", {
        status: response.status,
        code: "response_too_large",
      });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export class SessionApi {
  #baseUrl;
  #fetch;

  constructor(options = {}) {
    this.#baseUrl = String(options.baseUrl ?? "").replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (typeof this.#fetch !== "function") throw new TypeError("SessionApi requires fetch");
  }

  info() { return this.#request("GET", "/api/server"); }
  list() { return this.#request("GET", "/api/sessions"); }
  get(id) { return this.#request("GET", `/api/sessions/${encodeURIComponent(id)}`); }

  create(options, idempotencyKey = randomRequestId()) {
    return this.#request("POST", "/api/sessions", { body: options, idempotencyKey });
  }

  rename(id, name, idempotencyKey = randomRequestId()) {
    return this.#request("PATCH", `/api/sessions/${encodeURIComponent(id)}`, {
      body: { name },
      idempotencyKey,
    });
  }

  terminate(id, idempotencyKey = randomRequestId()) {
    return this.#request("POST", `/api/sessions/${encodeURIComponent(id)}/terminate`, { idempotencyKey });
  }

  delete(id, idempotencyKey = randomRequestId()) {
    return this.#request("DELETE", `/api/sessions/${encodeURIComponent(id)}`, { idempotencyKey });
  }

  async #request(method, path, options = {}) {
    const headers = { Accept: "application/json" };
    let body;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    let response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        body,
        credentials: "same-origin",
        mode: "same-origin",
        cache: "no-store",
      });
    } catch (error) {
      throw new SessionApiError(error?.message || "session API request failed", { details: error });
    }
    if (response.status === 204) return null;
    const contentLength = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new SessionApiError("session API response is too large", { status: response.status, code: "response_too_large" });
    }
    const text = await readBoundedText(response);
    let value = null;
    if (text) {
      try { value = JSON.parse(text); }
      catch { throw new SessionApiError("session API returned invalid JSON", { status: response.status, code: "invalid_response" }); }
    }
    if (!response.ok) {
      const message = typeof value?.error === "string"
        ? value.error
        : typeof value?.error?.message === "string"
          ? value.error.message
          : `session API request failed (${response.status})`;
      const code = typeof value?.error?.code === "string"
        ? value.error.code
        : value?.code || "request_failed";
      throw new SessionApiError(message, {
        status: response.status,
        code,
        details: value,
      });
    }
    return value;
  }
}

export function randomRequestId() {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

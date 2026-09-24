// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

export class AuthError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "AuthError";
    this.code = options.code ?? "request_failed";
    this.status = options.status ?? 0;
  }
}

// The server speaks unpadded base64url, which atob does not.
function decodeBase64url(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64url(value) {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function readError(response) {
  try {
    const payload = await response.json();
    const error = payload?.error;
    if (typeof error === "string") return { code: "request_failed", message: error };
    if (error && typeof error === "object") {
      return {
        code: typeof error.code === "string" ? error.code : "request_failed",
        message: typeof error.message === "string" ? error.message : `request failed (${response.status})`,
      };
    }
  } catch {}
  return { code: "request_failed", message: `request failed (${response.status})` };
}

export async function requestJSON(path, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers ?? {}) };
  let body;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  let response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      headers,
      body,
      credentials: "same-origin",
      mode: "same-origin",
      cache: "no-store",
    });
  } catch (error) {
    throw new AuthError(error?.message || "the server could not be reached", { code: "network_error" });
  }
  if (response.status === 204) return null;
  if (!response.ok) {
    const { code, message } = await readError(response);
    throw new AuthError(message, { code, status: response.status });
  }
  try {
    return await response.json();
  } catch {
    throw new AuthError("the server returned an invalid response", { code: "invalid_response", status: response.status });
  }
}

export function creationOptions(publicKey) {
  return {
    ...publicKey,
    challenge: decodeBase64url(publicKey.challenge),
    user: { ...publicKey.user, id: decodeBase64url(publicKey.user.id) },
    excludeCredentials: (publicKey.excludeCredentials ?? []).map(descriptor => ({
      ...descriptor,
      id: decodeBase64url(descriptor.id),
    })),
  };
}

export function requestOptions(publicKey) {
  return {
    ...publicKey,
    challenge: decodeBase64url(publicKey.challenge),
    allowCredentials: (publicKey.allowCredentials ?? []).map(descriptor => ({
      ...descriptor,
      id: decodeBase64url(descriptor.id),
    })),
  };
}

export function serializeCredential(credential) {
  const response = credential.response;
  const serialized = {
    id: credential.id,
    rawId: encodeBase64url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
  };
  if (typeof response.attestationObject !== "undefined") {
    serialized.response = {
      clientDataJSON: encodeBase64url(response.clientDataJSON),
      attestationObject: encodeBase64url(response.attestationObject),
      transports: response.getTransports?.() ?? [],
    };
  } else {
    serialized.response = {
      clientDataJSON: encodeBase64url(response.clientDataJSON),
      authenticatorData: encodeBase64url(response.authenticatorData),
      signature: encodeBase64url(response.signature),
    };
    if (response.userHandle) serialized.response.userHandle = encodeBase64url(response.userHandle);
  }
  return serialized;
}

// A ceremony needs a secure context, so plain http origins other than
// localhost can never sign in with a key.
export function supported() {
  return typeof window.PublicKeyCredential === "function" && window.isSecureContext;
}

export function unsupportedReason() {
  if (typeof window.PublicKeyCredential !== "function") return "this browser does not support security keys (WebAuthn)";
  if (!window.isSecureContext) return "security keys need a secure context; open this page over HTTPS or on localhost";
  return "";
}

// The WebAuthn API reports failures as DOMExceptions whose name is the only
// machine-readable part. These are the ones an operator can act on; the
// browser's own text is appended where it names something more specific than
// this mapping can, because it is the only place the reason appears.
export function describeError(error) {
  if (error instanceof AuthError) return error.message;
  const detail = typeof error?.message === "string" ? error.message.trim() : "";
  switch (error?.name) {
    case "NotAllowedError":
      return "the security key prompt was dismissed or timed out; touch the key and try again";
    case "InvalidStateError":
      return "this security key cannot be enrolled: it already holds a credential for this page";
    case "NotSupportedError":
      return "this security key does not offer what this server requires (a PIN or biometric and a discoverable credential)";
    case "SecurityError":
      return `the browser refused to use a security key on this page: ${detail || "the address may not be usable for security keys"}`;
    case "AbortError":
      return "the security key prompt was aborted before it finished";
    default:
      return detail || error?.name || "the security key step failed";
  }
}

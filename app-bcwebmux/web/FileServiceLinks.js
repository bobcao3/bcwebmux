// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

// Terminal applications print `file://` links, or a bare absolute path, and a
// browser cannot open either; the two name the same local destination. When a
// local file service (webdav, nginx, Copyparty, tmf, ...) serves part of
// this machine over HTTP, these helpers answer which file destinations that
// service can serve, and at which address.
//
// The configured service URL is a small template: `{host}` is the hostname the
// application itself is being used on, and `{path}` is the served path. A URL
// with no tokens has the served path appended, so `https://box:7443/dav` keeps
// working, while `https://{host}:7443{path}?v` follows the hostname in the
// address bar and hands the service its own query — one configuration that
// answers on every name this machine is reached by.
//
// The template is configuration, so it is validated when it is read: absolute
// http(s), at most one of each token, no other braces, no control characters or
// backslashes, and `{path}` must be unable to move the host (checked by
// resolving the same template with different path values and comparing
// origins). The link is untrusted, so its path is decoded, made traversal-free,
// checked against the configured prefix, and re-encoded segment by segment, and
// the resolved address must keep the origin the template produces on its own.
// A link therefore cannot retarget the host, add query parameters, escape the
// served tree, or reach anything but the configured service.

const HOST_TOKEN = "{host}";
const PATH_TOKEN = "{path}";
const MAX_SERVICE_URL = 2048;
// A path value that names no real destination, used only to prove that the
// token cannot reach the authority: if the host moves between two path values,
// the template is rejected.
const HOSTILE_PATH = "/evil.invalid/";

// `file://`, `file:///`, and `file://localhost/` all address this machine.
const FILE_SCHEME = /^file:\/\/(?:localhost)?/i;

function decodePath(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    // Malformed escapes cannot name a served file; leaving them literal only
    // makes the prefix check fail.
    return pathname;
  }
}

// Collapses duplicate slashes and resolves "." / ".." segments. Returns null
// when a traversal would escape the root, so callers reject instead of guessing.
function normalizeAbsolutePath(value) {
  const segments = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

function encodePathSegments(path) {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function parseAbsoluteUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function substitute(url, host, path) {
  const pathIndex = url.indexOf(PATH_TOKEN);
  const pathValue =
    pathIndex > 0 && url[pathIndex - 1] === "/" && path.startsWith("/") ? path.slice(1) : path;
  return url.split(HOST_TOKEN).join(host).split(PATH_TOKEN).join(pathValue);
}

function originOf(service, host, path) {
  const url = parseAbsoluteUrl(substitute(service, host, path));
  if (!url) return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.origin;
}

// One configured service URL, plain or templated. The checks that need a host
// run against a neutral one; resolution runs them again with the real hostname.
function normalizeServiceUrl(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_SERVICE_URL) return "";
  if (/[\u0000-\u001f\u007f-\u009f\\]/.test(trimmed)) return "";
  if (trimmed.split(HOST_TOKEN).length > 2 || trimmed.split(PATH_TOKEN).length > 2) return "";
  const tokens = trimmed.split(HOST_TOKEN).join("").split(PATH_TOKEN).join("");
  if (/[{}]/.test(tokens)) return "";
  const fragment = trimmed.indexOf("#");
  if (fragment !== -1) {
    for (const token of [HOST_TOKEN, PATH_TOKEN]) {
      const index = trimmed.indexOf(token);
      if (index !== -1 && index > fragment) return "";
    }
  }
  // A literal host or an authority terminator must precede the path token.
  const pathIndex = trimmed.indexOf(PATH_TOKEN);
  if (pathIndex !== -1) {
    const head = substitute(trimmed.slice(0, pathIndex), "terminal.invalid", "");
    const headUrl = parseAbsoluteUrl(head);
    if (!headUrl || !headUrl.hostname) return "";
  }
  if (!trimmed.includes(PATH_TOKEN) && !trimmed.includes(HOST_TOKEN)) {
    // No tokens: a plain URL, keeping the earlier behaviour of dropping a query
    // or fragment that the appended path would land behind, and of dropping a
    // trailing slash that would double up with it.
    const url = parseAbsoluteUrl(trimmed);
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return "";
    url.hash = "";
    url.search = "";
    return url.href.replace(/\/+$/, "");
  }
  const origin = originOf(trimmed, "terminal.invalid", "/");
  if (!origin || originOf(trimmed, "terminal.invalid", HOSTILE_PATH) !== origin) return "";
  return trimmed;
}

// "" (unset) or an absolute path; "/" means every file on the machine.
function normalizeLocalPrefix(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const stripped = trimmed.replace(FILE_SCHEME, "/");
  return normalizeAbsolutePath(stripped.startsWith("/") ? stripped : `/${stripped}`) ?? "";
}

// "" (the service root) or the path the local prefix is served under, like
// "/dav" or "/share". Left as typed: the URL parser escapes it once at the end.
function normalizeServedPrefix(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const path = normalizeAbsolutePath(trimmed.startsWith("/") ? trimmed : `/${trimmed}`);
  return path === null || path === "/" ? "" : path;
}

export function normalizeFileServiceConfig(raw) {
  return {
    enabled: raw?.enabled === true,
    // `baseUrl` is the earlier, untemplated name of this field.
    url: normalizeServiceUrl(raw?.url ?? raw?.baseUrl),
    localPrefix: normalizeLocalPrefix(raw?.localPrefix),
    servedPrefix: normalizeServedPrefix(raw?.servedPrefix),
  };
}

export function fileServiceReady(config) {
  return Boolean(config?.enabled && config.url && config.localPrefix);
}

// Resolves a file:// destination, or a bare absolute path naming the same file,
// to the address the configured service serves it at, or null when this link
// stays outside the service's tree. `pageHost` is the hostname the application
// is being used on, which `{host}` stands for; the normalized local path comes
// back alongside the address for display.
export function resolveFileServiceLink(uri, config, context = {}) {
  if (!fileServiceReady(config) || typeof uri !== "string") return null;
  // A bare absolute path and a file:// URL name the same destination.
  const parsed = parseAbsoluteUrl(uri.startsWith("/") ? `file://${uri}` : uri);
  if (!parsed || parsed.protocol !== "file:") return null;
  // A remote host in a file:// URI names another machine, which this service
  // speaks for only when it is this one.
  if (parsed.hostname && parsed.hostname !== "localhost") return null;
  const path = normalizeAbsolutePath(decodePath(parsed.pathname));
  if (path === null) return null;
  const prefix = config.localPrefix;
  if (prefix !== "/" && path !== prefix && !path.startsWith(`${prefix}/`)) return null;
  const relative = prefix === "/" ? path : path.slice(prefix.length);
  const served =
    relative === ""
      ? `${config.servedPrefix}/`
      : `${config.servedPrefix}${encodePathSegments(relative)}`;

  let host = "";
  if (config.url.includes(HOST_TOKEN)) {
    if (typeof context.pageHost !== "string" || !context.pageHost) return null;
    // Canonicalize through the URL parser, so nothing but a host can survive.
    host = parseAbsoluteUrl(`https://${context.pageHost}`)?.hostname ?? "";
    if (!host) return null;
  }
  const expected = originOf(config.url, host, "/");
  if (!expected) return null;
  const resolved = parseAbsoluteUrl(
    config.url.includes(PATH_TOKEN)
      ? substitute(config.url, host, served)
      : `${substitute(config.url, host, "")}${served}`,
  );
  // The link only ever supplies the path, so it must not have been able to
  // reach the authority, the port, or the scheme.
  if (!resolved || resolved.origin !== expected) return null;
  return { url: resolved.href, path };
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fileServiceReady,
  normalizeFileServiceConfig,
  resolveFileServiceLink,
} from "../web/FileServiceLinks.js";

const config = (overrides = {}) =>
  normalizeFileServiceConfig({
    enabled: true,
    url: "http://127.0.0.1:3923",
    localPrefix: "/home/bob/share",
    servedPrefix: "",
    ...overrides,
  });

const resolve = (uri, overrides, context) =>
  resolveFileServiceLink(uri, config(overrides), { pageHost: "box.local", ...context });

test("configuration normalization accepts a prefix typed as a file URI or a path", () => {
  assert.deepEqual(normalizeFileServiceConfig(), {
    enabled: false,
    url: "",
    localPrefix: "",
    servedPrefix: "",
  });
  assert.deepEqual(
    normalizeFileServiceConfig({
      enabled: true,
      url: "  https://files.example.com:8443/dav/  ",
      localPrefix: "file://localhost//home/bob//share/",
      servedPrefix: "dav//",
    }),
    {
      enabled: true,
      url: "https://files.example.com:8443/dav",
      localPrefix: "/home/bob/share",
      servedPrefix: "/dav",
    },
  );
  // The earlier field name of the service URL still loads.
  assert.equal(
    normalizeFileServiceConfig({ baseUrl: "https://files.example.com/" }).url,
    "https://files.example.com",
  );
  assert.equal(
    config({ localPrefix: "/home/bob/./share/../share" }).localPrefix,
    "/home/bob/share",
  );
  assert.equal(config({ localPrefix: "/" }).localPrefix, "/");
  assert.equal(config({ servedPrefix: "/" }).servedPrefix, "");
});

test("configuration normalization rejects what cannot produce a served address", () => {
  assert.equal(normalizeFileServiceConfig({ url: "ftp://host/files" }).url, "");
  assert.equal(normalizeFileServiceConfig({ url: "127.0.0.1:3923" }).url, "");
  assert.equal(normalizeFileServiceConfig({ localPrefix: "   " }).localPrefix, "");
  assert.equal(normalizeFileServiceConfig({ localPrefix: "/home/../../../etc" }).localPrefix, "");
  assert.equal(normalizeFileServiceConfig({ servedPrefix: "/../.." }).servedPrefix, "");
});

test("readiness needs the switch, an address, and a prefix", () => {
  assert.equal(fileServiceReady(config()), true);
  assert.equal(fileServiceReady(config({ enabled: false })), false);
  assert.equal(fileServiceReady(config({ url: "" })), false);
  assert.equal(fileServiceReady(config({ localPrefix: "" })), false);
  assert.equal(fileServiceReady(normalizeFileServiceConfig()), false);
  assert.equal(fileServiceReady(null), false);
});

test("a destination under the prefix resolves to the served address", () => {
  assert.deepEqual(resolve("file:///home/bob/share/reports/q3.pdf"), {
    url: "http://127.0.0.1:3923/reports/q3.pdf",
    path: "/home/bob/share/reports/q3.pdf",
  });
  assert.equal(
    resolve("file:///home/bob/share/reports/q3.pdf", { servedPrefix: "/dav" }).url,
    "http://127.0.0.1:3923/dav/reports/q3.pdf",
  );
  assert.equal(
    resolve("file:///home/bob/share/reports/q3.pdf", { url: "https://files.example.com/files" })
      .url,
    "https://files.example.com/files/reports/q3.pdf",
  );
  assert.equal(resolve("file://localhost/home/bob/share/x.txt").url, "http://127.0.0.1:3923/x.txt");
});

test("a bare absolute path resolves like the file:// URL for the same file", () => {
  for (const uri of [
    "/home/bob/share/reports/q3.pdf",
    "/home/bob/share/2026%20plan%20%C3%A9.md",
    "/home/bob/share/a%23b%3Fc.txt",
    "/home/bob/share/q3.pdf?v=2#page=4",
    "/home/bob/share/../../etc/passwd",
    "/etc/passwd",
    "/home/bob/share2/x.txt",
    "/home/bob/share",
    "/home/bob/share/",
    "/",
  ]) {
    assert.deepEqual(resolve(uri), resolve(`file://${uri}`), uri);
  }
  assert.equal(
    resolve("/home/bob/share/reports/q3.pdf", { servedPrefix: "/dav" }).url,
    "http://127.0.0.1:3923/dav/reports/q3.pdf",
  );
  assert.equal(resolve("/etc/hosts", { localPrefix: "/" }).url, "http://127.0.0.1:3923/etc/hosts");
  for (const uri of ["/etc/passwd", "/home/bob/share/../../etc/passwd", "/"]) {
    assert.equal(resolve(uri), null, uri);
  }
});

test("the prefix itself is a directory, and a root prefix serves every path", () => {
  assert.equal(resolve("file:///home/bob/share").url, "http://127.0.0.1:3923/");
  assert.equal(
    resolve("file:///home/bob/share", { servedPrefix: "/dav" }).url,
    "http://127.0.0.1:3923/dav/",
  );
  assert.equal(resolve("file:///home/bob/share/").url, "http://127.0.0.1:3923/");
  assert.deepEqual(resolve("file:///etc/hosts", { localPrefix: "/" }), {
    url: "http://127.0.0.1:3923/etc/hosts",
    path: "/etc/hosts",
  });
});

test("a served prefix is joined as a URL path", () => {
  const uri = "file:///home/bob/share/q3.pdf";
  assert.equal(
    resolve(uri, { servedPrefix: "/my files" }).url,
    "http://127.0.0.1:3923/my%20files/q3.pdf",
  );
  assert.equal(
    resolve(uri, { servedPrefix: "/my%20files" }).url,
    "http://127.0.0.1:3923/my%20files/q3.pdf",
  );
  assert.equal(resolve(uri, { servedPrefix: "//dav//" }).url, "http://127.0.0.1:3923/dav/q3.pdf");
});

test("escapes are rebuilt per segment, so reserved characters cannot retarget a URL", () => {
  const url = (uri) => resolve(uri).url;
  assert.equal(
    url("file:///home/bob/share/2026%20plan%20%C3%A9.md"),
    "http://127.0.0.1:3923/2026%20plan%20%C3%A9.md",
  );
  assert.equal(url("file:///home/bob/share/a%23b%3Fc.txt"), "http://127.0.0.1:3923/a%23b%3Fc.txt");
  assert.equal(
    url("file:///home/bob/share/%25literal.txt"),
    "http://127.0.0.1:3923/%25literal.txt",
  );
  assert.equal(url("file:///home/bob/share/q3.pdf?v=2#page=4"), "http://127.0.0.1:3923/q3.pdf");
});

test("destinations outside the prefix resolve to nothing", () => {
  for (const uri of [
    "file:///etc/passwd",
    "file:///home/bob/share2/x.txt",
    "file:///home/bob/shar",
    "file:///home/bob",
    "file:///",
    "file://server/home/bob/share/x.txt",
  ]) {
    assert.equal(resolve(uri), null, uri);
  }
});

test("traversal cannot step outside the served tree", () => {
  for (const uri of [
    "file:///home/bob/share/../../etc/passwd",
    "file:///home/bob/share/%2e%2e/%2e%2e/etc/passwd",
    "file:///home/bob/share/%2E%2E/%2E%2E/etc/passwd",
    "file:///home/bob/share/./../../etc/passwd",
  ]) {
    assert.equal(resolve(uri), null, uri);
  }
  assert.equal(resolve("file:///home/bob/share/a/../b.txt").url, "http://127.0.0.1:3923/b.txt");
  for (const uri of ["file:///home/bob/share/a%2FB.txt", "file:///home/bob/share/a/b.txt"]) {
    const resolved = resolve(uri);
    assert.ok(resolved.url.startsWith("http://127.0.0.1:3923/"));
    assert.ok(!resolved.url.includes(".."));
  }
});

test("other schemes, malformed input, and unconfigured services resolve to nothing", () => {
  assert.equal(resolve("https://example.com/x"), null);
  assert.equal(resolve("not a url"), null);
  assert.equal(
    resolve("file:///home/bob/share/%%zz.txt").url,
    "http://127.0.0.1:3923/%25%25zz.txt",
  );
  assert.equal(resolve(null), null);
  assert.equal(resolve("file:///home/bob/share/x.txt", { enabled: false }), null);
  assert.equal(resolveFileServiceLink("file:///home/bob/share/x.txt", null), null);
});

test("the host token follows the hostname the application is used on", () => {
  const tmf = { url: "https://{host}:7443{path}?v", localPrefix: "/" };
  assert.equal(config(tmf).url, "https://{host}:7443{path}?v");
  for (const [pageHost, host] of [
    ["bobcao3arch.local:3443", "bobcao3arch.local"],
    ["bobcao3arch.tailf4bb07.ts.net", "bobcao3arch.tailf4bb07.ts.net"],
    ["[::1]:3443", "[::1]"],
  ]) {
    assert.deepEqual(
      resolveFileServiceLink("file:///home/bob/report.pdf", config(tmf), { pageHost }),
      { url: `https://${host}:7443/home/bob/report.pdf?v`, path: "/home/bob/report.pdf" },
      pageHost,
    );
  }
  // Without a page hostname there is nothing to put in its place.
  assert.equal(resolveFileServiceLink("file:///x.pdf", config(tmf), {}), null);
  assert.equal(resolveFileServiceLink("file:///x.pdf", config(tmf), { pageHost: "" }), null);
});

test("the path token goes where it is written and keeps the service's query", () => {
  assert.equal(
    resolve("file:///home/bob/share/q3.pdf", { url: "https://box:7443/dav{path}?v" }).url,
    "https://box:7443/dav/q3.pdf?v",
  );
  assert.equal(
    resolve("file:///home/bob/share/q3.pdf", { url: "https://box:7443/?file={path}&v=1" }).url,
    "https://box:7443/?file=/q3.pdf&v=1",
  );
  // The served prefix and the tokens compose: {path} stands for what a plain
  // URL would have had appended.
  assert.equal(
    resolve("file:///home/bob/share/q3.pdf", {
      url: "https://box/dav{path}?v",
      servedPrefix: "/share",
    }).url,
    "https://box/dav/share/q3.pdf?v",
  );
  assert.equal(
    resolve("file:///home/bob/share", { url: "https://box{path}", servedPrefix: "/dav" }).url,
    "https://box/dav/",
  );
});

test("a link cannot smuggle characters into the template's query or host", () => {
  const template = { url: "https://{host}:7443{path}?v", localPrefix: "/" };
  for (const [uri, expected] of [
    ["file:///a&b.txt", "https://box.local:7443/a%26b.txt?v"],
    ["file:///a=b.txt", "https://box.local:7443/a%3Db.txt?v"],
    ["file:///a%26v=9", "https://box.local:7443/a%26v%3D9?v"],
    ["file:///a#b", "https://box.local:7443/a?v"],
    ["file:///a%3Fb", "https://box.local:7443/a%3Fb?v"],
    ["file:///a b.txt", "https://box.local:7443/a%20b.txt?v"],
    ["file:////evil.invalid/x", "https://box.local:7443/evil.invalid/x?v"],
    ["file:///a@evil.invalid/x", "https://box.local:7443/a%40evil.invalid/x?v"],
  ]) {
    assert.deepEqual(resolve(uri, template).url, expected, uri);
  }
  assert.equal(resolve("file:///a?b", template).url, "https://box.local:7443/a?v");
  assert.equal(
    resolve("file:///a&v=9", { url: "https://box:7443/?file={path}&v=1", localPrefix: "/" }).url,
    "https://box:7443/?file=/a%26v%3D9&v=1",
  );
});

test("a template that lets the path reach the authority is rejected", () => {
  for (const url of [
    "https://{path}evil.invalid/",
    "https://{path}.evil.invalid/",
    "http://{path}",
    "https://{path}@evil.invalid/",
  ]) {
    assert.equal(normalizeFileServiceConfig({ url }).url, "", url);
    assert.equal(config({ url }).url, "", url);
  }
});

test("path tokens in userinfo or port resolve deterministically", () => {
  assert.equal(
    resolve("file:///home/bob/share/q3.pdf", { url: "https://user{path}@box/" }).url,
    "https://user/q3.pdf@box/",
  );
  assert.equal(
    resolve("file:///home/bob/share/q3.pdf", { url: "https://box:{path}/" }).url,
    "https://box/q3.pdf/",
  );
});

test("a malformed template is rejected when it is configured", () => {
  for (const url of [
    "https://box{path}{path}?v",
    "https://{host}{host}{path}",
    "https://box/{path}/{unknown}",
    "https://box/{pathname}",
    "https://box/{path}\n?v",
    "https://box\\evil/{path}",
    "https://box/#{path}",
    `https://box/{path}?v=${"x".repeat(2100)}`,
  ]) {
    assert.equal(normalizeFileServiceConfig({ url }).url, "", JSON.stringify(url));
  }
  assert.equal(
    normalizeFileServiceConfig({ url: "https://box/{path}#page=2" }).url,
    "https://box/{path}#page=2",
  );
  assert.equal(
    resolve("file:///home/bob/share/q3.pdf", { url: "https://box/{path}#page=2" }).url,
    "https://box/q3.pdf#page=2",
  );
  // Without tokens a URL is a plain service address; a query or fragment the
  // appended path would land behind is dropped, as before.
  assert.equal(normalizeFileServiceConfig({ url: "https://box/#frag" }).url, "https://box");
  assert.equal(normalizeFileServiceConfig({ url: "https://box/?v" }).url, "https://box");
});

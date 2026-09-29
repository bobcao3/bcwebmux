// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

// The link dialog, the Settings → LINKS panel, and the server's published file
// service are one feature split across index.html, settings.js, client.js, and
// the Go config. Only a real browser run proves the parts still line up, so this
// drives the panel through the UI, activates a real OSC 8 file:// link through
// the shell, and follows the resolved address to the file a local service
// serves. The service URL is templated, so the test also proves the {host} token
// follows the page and that a browser's own configuration outlives the server's.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { Cdp, freePort, terminateProcess, waitFor } from "./test-support.mjs";

const [serverPath, webRoot] = process.argv.slice(2);
assert.ok(serverPath && webRoot, "usage: file-service-e2e.mjs SERVER WEB_ROOT");
const serverPort = await freePort();
const debugPort = await freePort();
const base = `http://127.0.0.1:${serverPort}`;
const reportPath = "report.txt";
const reportBody = "served report\n";
const shareDir = await mkdtemp(path.join(os.tmpdir(), "bcwebmux-share-"));
const profile = await mkdtemp(path.join(os.tmpdir(), "bcwebmux-file-service-"));
let server;
let serverError;
let serverLog = "";
let chromium;
let chromiumError;
let fileServer;
let page;
let browser;
let cleanupPromise = null;

process.once("SIGTERM", () => void cleanup().finally(() => process.exit(124)));
process.once("SIGINT", () => void cleanup().finally(() => process.exit(130)));

try {
  await writeFile(path.join(shareDir, reportPath), reportBody);
  // A stand-in for webdav/nginx/Copyparty/tmf: the address the dialog opens
  // must come back as the bytes that were linked. Query parameters are ignored
  // here, exactly as a viewer's own query would be. Both path shapes resolve:
  // one service serves the share directory at its root, the other serves the
  // whole filesystem like tmf with TOO_MANY_FILES_ROOT=/, and only the share
  // directory answers either way.
  fileServer = createServer(async (request, response) => {
    const urlPath = new URL(request.url, base).pathname;
    let body = null;
    for (const root of [shareDir, "/"]) {
      const candidate = path.resolve(root, `.${urlPath}`);
      if (!candidate.startsWith(`${shareDir}${path.sep}`)) continue;
      try {
        body = await readFile(candidate);
        break;
      } catch {}
    }
    if (body === null) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(body);
  });
  await new Promise((resolve) => fileServer.listen(0, "127.0.0.1", resolve));
  const filePort = fileServer.address().port;
  const servedPrefix = `http://127.0.0.1:${filePort}`;
  // The server configures the machine's file service the way this machine does:
  // the hostname in the address bar, its own query, and every path on the box.
  const serverServiceURL = `http://{host}:${filePort}{path}?v`;
  const reportUri = `file://${shareDir}/${reportPath}`;

  server = spawn(
    serverPath,
    [
      "--config",
      "/dev/null",
      "--auth=false",
      "--web-root",
      webRoot,
      "--listen",
      `127.0.0.1:${serverPort}`,
      "--origin",
      base,
      "--shell",
      "/bin/sh",
      "--file-service-url",
      serverServiceURL,
      "--file-service-prefix",
      "/",
    ],
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  server.detachedGroup = true;
  server.stdout.on("data", (data) => {
    serverLog += data;
  });
  server.stderr.on("data", (data) => {
    serverLog += data;
  });
  server.on("error", (error) => {
    serverError = error;
  });
  await waitFor(
    async () => {
      if (serverError) throw serverError;
      return (await fetch(`${base}/api/server`).catch(() => null))?.ok;
    },
    10000,
    "server failed to start",
  );
  const published = await (await fetch(`${base}/api/client-config`)).json();
  assert.deepEqual(published, {
    fileService: { url: serverServiceURL, localPrefix: "/" },
  });

  chromium = spawn(
    process.env.CHROMIUM || "chromium",
    [
      "--headless=new",
      "--window-size=1024,720",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--enable-unsafe-webgpu",
      "--use-angle=vulkan",
      "--ignore-gpu-blocklist",
      "--enable-features=Vulkan",
      "--disable-background-networking",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      `${base}/?session-test=1`,
    ],
    { stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  chromium.detachedGroup = true;
  chromium.on("error", (error) => {
    chromiumError = error;
  });

  const target = await waitFor(
    async () => {
      if (chromiumError) throw chromiumError;
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`).catch(() => null);
      if (!response?.ok) return null;
      return (await response.json()).find(
        (item) => item.type === "page" && item.url.includes("session-test=1"),
      );
    },
    15000,
    "Chromium did not expose the session page",
  );
  const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  browser = await Cdp.connect(version.webSocketDebuggerUrl);
  page = await Cdp.connect(target.webSocketDebuggerUrl);
  await page.call("Runtime.enable");
  await page.call("Page.enable");
  const settle = async () => {
    await waitBrowser(
      "window.bcwebmux?.connected === true",
      12000,
      "initial UI attachment did not become live",
    );
    await evaluate(
      "document.querySelector('#notification-dialog')?.open && document.querySelector('#notification-dialog-later').click()",
    );
  };
  await settle();

  const openLinksPanel = async () => {
    if (!(await evaluate("document.querySelector('#settings-dialog')?.open === true"))) {
      await evaluate("document.querySelector('#settings-button').click()");
    }
    await waitBrowser(
      "document.querySelector('#settings-dialog')?.open === true",
      3000,
      "settings dialog did not open",
    );
    if (await evaluate("document.querySelector('#settings-panel-links')?.hidden !== false")) {
      await evaluate("document.querySelector('#settings-tab-links').click()");
    }
    await waitBrowser(
      "document.querySelector('#settings-panel-links')?.hidden === false",
      3000,
      "LINKS panel did not activate",
    );
    return evaluate(`(() => {
      const form = document.querySelector("#file-service-form");
      return {
        enabled: form.elements.enabled.checked,
        url: form.elements.url.value,
        localPrefix: form.elements.localPrefix.value,
        servedPrefix: form.elements.servedPrefix.value,
        preview: document.querySelector("#file-service-preview").textContent,
        tone: document.querySelector("#file-service-preview").dataset.tone ?? null,
      };
    })()`);
  };
  const closeSettings = async () => {
    await evaluate("document.querySelector('#settings-close').click()");
    await waitBrowser(
      "document.querySelector('#settings-dialog')?.open === false",
      3000,
      "settings dialog did not close",
    );
  };
  const setField = (name, value) =>
    evaluate(`(() => {
      const field = document.querySelector("#file-service-form").elements[${JSON.stringify(name)}];
      field.value = ${JSON.stringify(value)};
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      return field.value;
    })()`);
  const setEnabled = (checked) =>
    evaluate(`(() => {
      const enabled = document.querySelector("#file-service-form").elements.enabled;
      enabled.checked = ${checked};
      enabled.dispatchEvent(new Event("change", { bubbles: true }));
      return enabled.checked;
    })()`);

  // The server's file service arrives without the browser being configured, and
  // adoption must not write it into storage: the server stays the owner.
  const adopted = await openLinksPanel();
  assert.equal(adopted.enabled, true);
  assert.equal(adopted.url, serverServiceURL);
  assert.equal(adopted.localPrefix, "/");
  assert.equal(adopted.servedPrefix, "");
  assert.equal(adopted.preview, `file:///example.txt → http://127.0.0.1:${filePort}/example.txt?v`);
  assert.equal(adopted.tone, "ok");
  assert.equal(
    await evaluate('localStorage.getItem("bcwebmux.settings.v1")'),
    null,
    "adoption must not write the server's file service into storage",
  );
  await closeSettings();

  // The link sits at the top-left cell of the cleared screen, so cell (2, 0) is
  // always on it. The click retries because the shell echoes the command line
  // before the command runs; until it does, the click lands on plain text.
  const linkCell = { column: 2, row: 0 };
  const clickCell = async () => {
    const geometry = await evaluate(`(() => {
      const surface = document.querySelector("#surface");
      const style = getComputedStyle(document.querySelector("#terminal"));
      const rect = surface.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        cellWidth: parseFloat(style.getPropertyValue("--cell-width")),
        cellHeight: parseFloat(style.getPropertyValue("--cell-height")),
      };
    })()`);
    const x = geometry.left + (linkCell.column + 0.5) * geometry.cellWidth;
    const y = geometry.top + (linkCell.row + 0.5) * geometry.cellHeight;
    await page.call("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      buttons: 0,
    });
    for (const type of ["mousePressed", "mouseReleased"]) {
      await page.call("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: 1,
      });
    }
  };
  const activateLink = async (uri, label) => {
    await evaluate(
      `window.bcwebmux.write(${JSON.stringify(
        `printf '\\033[2J\\033[H\\033]8;;%s\\033\\\\%s\\033]8;;\\033\\\\\\n' ${JSON.stringify(uri)} ${JSON.stringify(label)}\n`,
      )})`,
    );
    await waitBrowser(
      `window.bcwebmux.sessionText().startsWith(${JSON.stringify(label)})`,
      5000,
      `terminal did not render ${label}`,
    );
    await waitFor(
      async () => {
        await clickCell();
        if (!(await evaluate("document.querySelector('#link-dialog')?.open === true")))
          return false;
        if (
          await evaluate(
            `document.querySelector("#link-dialog-uri").textContent.startsWith(${JSON.stringify(uri)})`,
          )
        ) {
          return true;
        }
        await evaluate("document.querySelector('#link-dialog-cancel').click()");
        return false;
      },
      6000,
      `clicking ${label} did not open its link dialog`,
    );
  };
  const readDialog = () =>
    evaluate(`(() => {
      const destination = document.querySelector("#link-dialog-uri");
      const served = destination.querySelector(".link-dialog-resolved");
      const open = document.querySelector("#link-dialog-open");
      return {
        destination: destination.textContent,
        served: served?.textContent ?? null,
        servedTitle: served?.title ?? null,
        openDisabled: open.disabled,
        openLabel: open.textContent,
        openTitle: open.title,
      };
    })()`);
  const captureOpen = () =>
    evaluate(`(() => {
      window.__opened = null;
      window.open = (url, target, features) => {
        window.__opened = { url, target, features };
        return null;
      };
      return true;
    })()`);
  const closeDialog = async () => {
    await evaluate("document.querySelector('#link-dialog-cancel').click()");
    await waitBrowser(
      "document.querySelector('#link-dialog')?.open === false",
      3000,
      "link dialog did not close",
    );
  };
  const openServedLink = async () => {
    await captureOpen();
    await evaluate("document.querySelector('#link-dialog-open').click()");
    const opened = await evaluate("window.__opened");
    assert.equal(opened.target, "_blank");
    assert.ok(opened.features.includes("noopener"));
    const response = await fetch(opened.url);
    assert.equal(response.status, 200);
    assert.equal(
      await response.text(),
      reportBody,
      "the served address must return the linked file",
    );
    await waitBrowser(
      "document.querySelector('#link-dialog')?.open === false",
      3000,
      "opening a served link left the dialog open",
    );
    return opened.url;
  };

  // Phase 1: the server's template, with {host} from the page and its own query.
  await activateLink(reportUri, "OPENREPORT");
  const servedDialog = await readDialog();
  const serverServedURL = `http://127.0.0.1:${filePort}${shareDir}/${reportPath}?v`;
  assert.equal(servedDialog.destination, `${reportUri}→ ${serverServedURL}`);
  assert.equal(servedDialog.served, `→ ${serverServedURL}`);
  assert.equal(servedDialog.servedTitle, "Served address, opened in a new tab.");
  assert.equal(servedDialog.openDisabled, false);
  assert.equal(servedDialog.openLabel, "OPEN SERVED LINK");
  assert.equal(servedDialog.openTitle, `Opens ${serverServedURL} in a new tab.`);
  assert.equal(await openServedLink(), serverServedURL);

  // Phase 2: the browser's own configuration, written from the UI, outlives a
  // reload and outranks the server's template.
  await openLinksPanel();
  await setField("url", servedPrefix);
  await setField("localPrefix", shareDir);
  await setField("servedPrefix", "");
  const edited = await openLinksPanel();
  assert.equal(edited.preview, `file://${shareDir}/example.txt → ${servedPrefix}/example.txt`);
  assert.deepEqual(
    await evaluate('JSON.parse(localStorage.getItem("bcwebmux.settings.v1")).fileService'),
    { enabled: true, url: servedPrefix, localPrefix: shareDir, servedPrefix: "" },
  );
  await closeSettings();

  await activateLink(reportUri, "LOCALREPORT");
  const localDialog = await readDialog();
  assert.equal(localDialog.served, `→ ${servedPrefix}/${reportPath}`);
  assert.equal(await openServedLink(), `${servedPrefix}/${reportPath}`);

  // A bare absolute path names the same file as its file:// URL.
  const bareUri = `${shareDir}/${reportPath}`;
  await activateLink(bareUri, "BAREPATH");
  const bareDialog = await readDialog();
  assert.equal(bareDialog.destination, `${bareUri}→ ${servedPrefix}/${reportPath}`);
  assert.equal(bareDialog.served, `→ ${servedPrefix}/${reportPath}`);
  assert.equal(await openServedLink(), `${servedPrefix}/${reportPath}`);

  // A path outside the browser's prefix stays closed, even though the server's
  // configuration would have served it.
  await activateLink("file:///etc/hosts", "OUTSIDELINK");
  const outsideDialog = await readDialog();
  assert.equal(outsideDialog.destination, "file:///etc/hosts");
  assert.equal(outsideDialog.served, null);
  assert.equal(outsideDialog.openDisabled, true);
  assert.equal(outsideDialog.openLabel, "OPEN LINK");
  assert.match(outsideDialog.openTitle, /configured file service prefix/);
  await closeDialog();

  // A plain web link keeps behaving exactly as it did before.
  await activateLink("https://example.com/outside", "PLAINWEBLINK");
  const webDialog = await readDialog();
  assert.equal(webDialog.destination, "https://example.com/outside");
  assert.equal(webDialog.served, null);
  assert.equal(webDialog.openDisabled, false);
  await captureOpen();
  await evaluate("document.querySelector('#link-dialog-open').click()");
  assert.equal((await evaluate("window.__opened")).url, "https://example.com/outside");

  await page.call("Page.reload");
  await settle();
  await activateLink(reportUri, "AFTERRELOAD");
  const reloaded = await readDialog();
  assert.equal(reloaded.served, `→ ${servedPrefix}/${reportPath}`);
  assert.equal(await openServedLink(), `${servedPrefix}/${reportPath}`);

  const exceptions = page.events.filter((event) => event.method === "Runtime.exceptionThrown");
  assert.deepEqual(exceptions, [], JSON.stringify(exceptions));
  console.log(
    JSON.stringify({
      published: published.fileService,
      adopted: adopted.url,
      stored: servedPrefix,
    }),
  );
} catch (error) {
  error.message += `\nServer log:\n${serverLog}`;
  throw error;
} finally {
  await cleanup();
}

async function evaluate(expression) {
  const response = await page.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails)
    throw new Error(
      response.exceptionDetails.exception?.description || "browser evaluation failed",
    );
  return response.result.value;
}

async function waitBrowser(expression, timeout, message) {
  return waitFor(
    async () => Boolean(await evaluate(expression).catch(() => false)),
    timeout,
    message,
  );
}

async function cleanup() {
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      try {
        page?.close();
      } catch {}
      try {
        browser?.close();
      } catch {}
      await terminateProcess(chromium);
      await terminateProcess(server);
      await new Promise((resolve) => fileServer?.close(resolve) ?? resolve());
      await rm(profile, { recursive: true, force: true });
      await rm(shareDir, { recursive: true, force: true });
    })();
  }
  return cleanupPromise;
}

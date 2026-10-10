// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { waitFor } from "./test-support.mjs";

export async function verifyUnreadBell(page, evaluate) {
  const url = await evaluate("location.origin + '/'");
  await page.call("Network.enable");
  await page.call("Network.setBlockedURLs", { urls: ["*/client.js"] });
  await page.call("Page.navigate", { url });
  await waitFor(
    () => evaluate("!window.bcwebmux && document.readyState === 'complete'"),
    5000,
    "the drawer fixture page did not load",
  );
  await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 100 });
  await evaluate(`(${createFixture.toString()})()`);
  const icons = () =>
    evaluate(`(() => {
    const row = bellFixture.row();
    return {
      bell: getComputedStyle(row.querySelector('.session-bell-icon')).display !== 'none',
      action: getComputedStyle(row.querySelector('.session-lifecycle-icon')).display !== 'none',
    };
  })()`);
  try {
    const colors = await evaluate(`(() => {
      const row = document.createElement('div');
      row.className = 'session-row';
      const reference = document.createElement('span');
      document.body.append(row, reference);
      const result = ['blocked', 'error'].map(state => {
        row.dataset.programStatus = state;
        row.style.color = 'var(--session-status-color)';
        reference.style.color = 'oklch(from var(--color-' + (state === 'blocked' ? 'warning' : 'danger') + ') l c h)';
        const channels = element => getComputedStyle(element).color.match(/[\\d.]+/g).map(Number);
        return { state, actual: channels(row), original: channels(reference) };
      });
      row.remove();
      reference.remove();
      return result;
    })()`);
    for (const { state, actual, original } of colors) {
      assert.ok(
        Math.abs(actual[1] / original[1] - 1.3) < 0.0001,
        `${state} must have 30% more chroma`,
      );
      assert.equal(actual[0], original[0], `${state} must retain the original lightness`);
      assert.equal(actual[2], original[2], `${state} must retain the original hue`);
    }
    assert.deepEqual(await icons(), { bell: false, action: true });
    await evaluate(
      `bellFixture.emitInactive(${JSON.stringify("printf '\\033]0;Inactive OSC title\\007'")})`,
    );
    await waitFor(
      () => evaluate("bellFixture.controller.get(bellFixture.id).title === 'Inactive OSC title'"),
      5000,
      "inactive OSC output did not reach session metadata",
    );
    assert.deepEqual(await icons(), { bell: false, action: true });
    await evaluate(`bellFixture.emitInactive(${JSON.stringify("printf '\\007'")})`);
    assert.equal(await evaluate("bellFixture.controller.isAttached(bellFixture.id)"), false);
    await waitFor(
      async () => (await icons()).bell,
      5000,
      "a detached session's BEL did not show a bell icon",
    );
    assert.deepEqual(await icons(), { bell: true, action: false });
    assert.match(
      await evaluate("bellFixture.row().querySelector('.session-tab').getAttribute('aria-label')"),
      /unread bell/,
    );
    await evaluate("bellFixture.controller.refresh()");
    assert.deepEqual(await icons(), { bell: true, action: false });
    const point = await evaluate(`(() => {
      const rect = bellFixture.row().querySelector('.session-lifecycle').getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    assert.deepEqual(await icons(), { bell: false, action: true });
    await page.call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...point,
    });
    await page.call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...point,
    });
    assert.equal(await evaluate("document.querySelector('#session-confirm-dialog').open"), true);
    assert.match(
      await evaluate("document.querySelector('#session-confirm-dialog').textContent"),
      /terminate/i,
    );
    await evaluate("document.querySelector('#session-confirm-dialog button').click()");
    await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 100 });
    await evaluate("bellFixture.row().querySelector('.session-lifecycle').focus()");
    assert.deepEqual(await icons(), { bell: false, action: true });
    await evaluate("bellFixture.controller.switchTo(bellFixture.id)");
    assert.deepEqual(await icons(), { bell: false, action: true });
    assert.equal(await evaluate("bellFixture.controller.get(bellFixture.id).unreadBell"), false);
    await evaluate(`(() => {
      bellFixture.seenEventSeq = bellFixture.controller.activeAttachment.eventSeq;
      bellFixture.terminal.input(${JSON.stringify("printf '\\007'\n")});
    })()`);
    await waitFor(
      () =>
        evaluate(
          "BigInt(bellFixture.controller.activeAttachment.eventSeq) > BigInt(bellFixture.seenEventSeq)",
        ),
      5000,
      "the active session's BEL did not reach the terminal",
    );
    await evaluate("bellFixture.controller.switchTo(bellFixture.otherId)");
    await evaluate("bellFixture.controller.refresh()");
    assert.deepEqual(await icons(), { bell: false, action: true });
  } finally {
    await evaluate(`(() => {
      bellFixture.drawer.dispose();
      bellFixture.controller.dispose();
      bellFixture.transport.dispose();
      bellFixture.terminal.dispose();
      bellFixture.root.remove();
      delete window.bellFixture;
    })()`);
  }
}

async function createFixture() {
  const [
    { Terminal },
    { SessionApi },
    { SessionTransport },
    { SessionController },
    { SessionDrawer },
  ] = await Promise.all([
    import("/wgpuTerminal/src/index.js"),
    import("/SessionApi.js"),
    import("/SessionTransport.js"),
    import("/SessionController.js"),
    import("/SessionDrawer.js"),
  ]);
  const root = document.createElement("div");
  root.style.cssText = "position:fixed;inset:0;z-index:1000;background:var(--color-background)";
  const drawerElement = document.createElement("aside");
  drawerElement.style.cssText = "position:absolute;left:8px;top:8px;width:264px";
  const tabs = document.createElement("div");
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;left:280px;top:0;right:0;bottom:0";
  drawerElement.append(tabs);
  root.append(drawerElement, host);
  document.body.append(root);
  const terminal = new Terminal({ wasmUrl: "/terminal.wasm", renderer: "dom" });
  await terminal.open(host);
  const transport = new SessionTransport();
  transport.activate(terminal);
  const controller = new SessionController({
    terminal,
    transport,
    api: new SessionApi(),
    storage: null,
  });
  await controller.start();
  const target = await controller.create();
  const other = await controller.create();
  const drawer = new SessionDrawer({
    controller,
    storage: null,
    elements: { drawer: drawerElement, tabs, shell: root, workspace: host },
  }).init();
  window.bellFixture = {
    root,
    terminal,
    transport,
    controller,
    drawer,
    id: target.id,
    otherId: other.id,
    row: () => tabs.querySelector(`[data-session-id="${target.id}"]`),
    async emitInactive(command) {
      await controller.switchTo(target.id);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const marker = `Queued bell ${performance.now()}`;
      const started = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listener.dispose();
          reject(new Error("the shell did not accept the delayed command"));
        }, 5000);
        const listener = terminal.onTitleChange((title) => {
          if (title !== marker) return;
          clearTimeout(timer);
          listener.dispose();
          resolve();
        });
      });
      terminal.input(`(sleep 1; ${command})& printf '\\033]0;${marker}\\007'\n`);
      await started;
      await controller.switchTo(other.id);
    },
  };
}

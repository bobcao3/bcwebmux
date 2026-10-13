// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

// Settings → SECURITY: the FIDO2 keys enrolled for this origin, one row per
// device. Whoever holds the key is whoever can unlock it on that device, so
// adding or removing one requires a fresh factor: an assertion from a key that
// is already enrolled, or a current code from the authenticator app. A stolen
// session cookie alone can do neither.

import {
  creationOptions,
  describeError,
  requestJSON,
  requestOptions,
  serializeCredential,
  supported,
  unsupportedReason,
} from "/webauthn.js";
import { html, nothing, render as litRender } from "./lib/lit-html/lit-html.js";
import { repeat } from "./lib/lit-html/directives/repeat.js";

const disarmDelayMs = 5000;

export function initializeAuthSettings() {
  const list = document.querySelector("#auth-credential-list");
  const summary = document.querySelector("#auth-summary");
  const addButton = document.querySelector("#auth-add-key");
  const nameInput = document.querySelector("#auth-key-name");
  const signOutButton = document.querySelector("#auth-sign-out");
  const status = document.querySelector("#auth-status");
  const codeRow = document.querySelector("#auth-stepup-row");
  const codeForm = document.querySelector("#auth-stepup-form");
  const codeInput = document.querySelector("#auth-stepup-code");
  let busy = false;
  // With nothing enrolled the server is open and nothing can step up, so key
  // enrollment waits for an authenticator app enrolled on the host.
  let nothingEnrolled = false;
  // armedId tracks the credential awaiting a CONFIRM click by id, so the
  // armed state survives list re-renders (a refresh no longer strands it on
  // a detached button).
  let armedId = null;
  let armedTimer = null;
  let askForCode = null;
  let lastList = { credentials: [], rpId: "", totp: null };

  // failure keeps an expired session from stranding the panel: the server
  // answers 401 "unauthenticated" for a cookie that aged out mid-action, which
  // the login page can resolve. A rejected code answers 401 as well, and that
  // one belongs in this panel's status line.
  function failure(error, action) {
    if (error?.code === "unauthenticated") {
      location.replace("/login");
      return;
    }
    console.error(`${action} failed`, error);
    report(describeError(error), "error");
  }

  function report(message, tone = "") {
    status.textContent = message;
    if (tone) status.dataset.tone = tone;
    else delete status.dataset.tone;
  }

  function setBusy(value) {
    busy = value;
    addButton.disabled = value || nothingEnrolled || !supported();
    signOutButton.disabled = value;
  }

  function formatTime(value) {
    if (!value) return "never";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
  }

  function disarm() {
    clearTimeout(armedTimer);
    armedTimer = null;
    if (armedId !== null) {
      armedId = null;
      renderList();
    }
  }

  // closeCode hides the code field and releases whoever is waiting on it.
  function closeCode(code = null) {
    codeRow.hidden = true;
    codeInput.value = "";
    const pending = askForCode;
    askForCode = null;
    if (pending) pending(code);
  }

  // readCode reveals the code field and resolves with what the operator types.
  // Hiding it again resolves null, which the caller reports as a refused
  // step-up instead of leaving the panel armed by a field nobody filled.
  function readCode() {
    closeCode(null);
    codeRow.hidden = false;
    codeInput.focus();
    return new Promise((resolve) => {
      askForCode = resolve;
    });
  }

  function totpDetail(entry) {
    return `authenticator app · enrolled ${formatTime(entry.enrolledAt)} · last used ${formatTime(entry.lastUsedAt)} · ${entry.digits} digits every ${entry.period}s · enrolled on the host`;
  }

  function credentialDetail(credential) {
    const transports = credential.transports?.length
      ? ` · ${credential.transports.join(", ")}`
      : "";
    return `created ${formatTime(credential.createdAt)} · last used ${formatTime(credential.lastUsedAt)}${transports}`;
  }

  function onRemove(credential) {
    if (armedId !== credential.id) {
      disarm();
      armedId = credential.id;
      renderList();
      armedTimer = setTimeout(disarm, disarmDelayMs);
      report(
        `Remove "${credential.name}"? Click CONFIRM to drop it, and this session with it if it is the key you are using.`,
      );
      return;
    }
    disarm();
    removeCredential(credential).catch(() => {});
  }

  // renderList rebuilds the credential rows as a keyed lit list. removeCredential
  // is async and refreshes mid-arm, so keying by credential id keeps the armed
  // CONFIRM label on the right row instead of a detached button.
  function renderList() {
    const { credentials, totp } = lastList;
    litRender(
      html`${
        totp
          ? html`<div class="auth-credential">
              <div class="auth-credential-copy">
                <strong
                  >${totp.name || "authenticator app"}
                  <span class="auth-credential-badge auth-credential-badge-factor"
                    >TOTP</span
                  ></strong
                ><small>${totpDetail(totp)}</small>
              </div>
            </div>`
          : nothing
      }${repeat(
        credentials,
        (credential) => credential.id,
        (credential) =>
          html`<div class="auth-credential">
            <div class="auth-credential-copy">
              <strong
                >${credential.name}${credential.current ? html` <span class="auth-credential-badge">THIS DEVICE</span>` : nothing}</strong
              ><small>${credentialDetail(credential)}</small>
            </div>
            <button
              type="button"
              class="auth-credential-remove"
              @click=${() => onRemove(credential)}
            >
              ${armedId === credential.id ? "CONFIRM" : "REMOVE"}
            </button>
          </div>`,
      )}`,
      list,
    );
  }

  function render(credentials, rpId, totp) {
    lastList = { credentials, rpId, totp };
    nothingEnrolled = !totp && !credentials.length;
    addButton.disabled = busy || nothingEnrolled;
    renderList();
    const factors = [];
    if (totp) factors.push("the authenticator app");
    if (credentials.length)
      factors.push(`${credentials.length} security key${credentials.length === 1 ? "" : "s"}`);
    summary.textContent = factors.length
      ? `${factors.join(" and ")} can sign in at ${rpId}${totp ? "; the app works at every address" : ""}.`
      : `Nothing is enrolled for ${rpId} yet. Enroll the authenticator app on the host with bcwebmux-server auth totp.`;
  }

  // refresh rebuilds the list. It must not guard on busy: the mutations that
  // change the list run while the panel is busy.
  async function refresh() {
    if (!supported()) {
      addButton.disabled = true;
      summary.textContent = unsupportedReason();
      return false;
    }
    try {
      const result = await requestJSON("/auth/credentials");
      render(result.credentials ?? [], result.rpId, result.totp ?? null);
      return true;
    } catch (error) {
      if (error.code === "unauthenticated") {
        location.replace("/login");
        return false;
      }
      summary.textContent = error.message;
      addButton.disabled = true;
      return false;
    }
  }

  async function load() {
    if (busy) return;
    await refresh();
  }

  // Prefer the authenticator app even when keys are enrolled: a key registered
  // on another device may not be available on the device being enrolled now.
  async function stepUp() {
    const session = await requestJSON("/auth/session");
    if (session.stepUp) return;
    try {
      if (session.totp) return await codeStepUp();
      if (session.enrolled > 0) return await keyStepUp();
      throw new Error("no authenticator app or security key is enrolled for this address");
    } catch (error) {
      // The panel comes from --web-root, so a rebuild reaches the browser
      // before the running process is restarted, and a server that predates
      // the step-up endpoint answers 404 rather than naming the reason.
      if (error?.code === "not_found") {
        throw new Error(
          "the running server predates this page; restart bcwebmux-server and try again",
        );
      }
      throw error;
    }
  }

  async function keyStepUp() {
    report("Verify your security key to unlock key management…");
    const assertion = await requestJSON("/auth/stepup/begin", { method: "POST", body: {} });
    const credential = await navigator.credentials.get({
      publicKey: requestOptions(assertion.publicKey),
    });
    if (!credential) throw new Error("the browser returned no credential");
    await requestJSON("/auth/stepup/finish", {
      method: "POST",
      body: serializeCredential(credential),
    });
  }

  async function codeStepUp() {
    report("Enter the code from your authenticator app to unlock key management.");
    const code = await readCode();
    if (!code) throw new Error("no code was entered; key management stays locked");
    await requestJSON("/auth/stepup/totp", { method: "POST", body: { code } });
  }

  async function addKey() {
    if (busy) return;
    setBusy(true);
    try {
      await stepUp();
      report("Follow the browser prompt to enroll the new security key…");
      const name = nameInput.value.trim();
      const path = name
        ? `/auth/register/begin?name=${encodeURIComponent(name)}`
        : "/auth/register/begin";
      const options = await requestJSON(path, { method: "POST", body: {} });
      const credential = await navigator.credentials.create({
        publicKey: creationOptions(options.publicKey),
      });
      if (!credential) throw new Error("the browser returned no credential");
      const result = await requestJSON("/auth/register/finish", {
        method: "POST",
        body: serializeCredential(credential),
      });
      nameInput.value = "";
      const listed = await refresh();
      if (listed)
        report(
          `Enrolled "${result?.name ?? "security key"}". Key management stays unlocked for five minutes.`,
          "ok",
        );
    } catch (error) {
      failure(error, "security key enrollment");
    } finally {
      setBusy(false);
    }
  }

  async function removeCredential(credential) {
    if (busy) return;
    setBusy(true);
    try {
      await stepUp();
      await requestJSON("/auth/credentials/remove", {
        method: "POST",
        body: { id: credential.id },
      });
      if (credential.current) {
        // The session was issued to the key that just went away.
        location.replace("/login");
        return;
      }
      const listed = await refresh();
      if (listed)
        report(
          `Removed "${credential.name}". Key management stays unlocked for five minutes.`,
          "ok",
        );
    } catch (error) {
      failure(error, "security key removal");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    if (busy) return;
    setBusy(true);
    try {
      await requestJSON("/auth/logout", { method: "POST", body: {} });
      location.replace("/login");
    } catch (error) {
      failure(error, "sign out");
      setBusy(false);
    }
  }

  addButton.addEventListener("click", addKey);
  signOutButton.addEventListener("click", signOut);
  codeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    closeCode(codeInput.value.trim());
  });
  nameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addKey();
    }
  });

  return {
    refresh: load,
    close: () => {
      closeCode(null);
      disarm();
    },
  };
}

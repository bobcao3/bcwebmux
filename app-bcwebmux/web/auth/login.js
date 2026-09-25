// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

// Login page. The authenticator-app code is the baseline: it works at every
// address, including IP literals. A security key is offered as well whenever
// the origin and the enrolled keys allow it.

import {
  describeError,
  requestJSON,
  requestOptions,
  serializeCredential,
  supported,
  unsupportedReason,
} from "/webauthn.js";

const form = document.querySelector("#auth-code-form");
const codeInput = document.querySelector("#auth-code");
const verifyButton = document.querySelector("#auth-verify");
const keyButton = document.querySelector("#auth-action");
const status = document.querySelector("#auth-status");
const intro = document.querySelector("#auth-intro");

const retryFloorMs = 1000;
let busy = false;
let ready = false;
// waitUntil is the limiter's backoff deadline: until then the form stays
// disabled rather than feeding the server more rejected codes.
let waitUntil = 0;

function report(message, tone = "") {
  status.textContent = message;
  if (tone) status.dataset.tone = tone;
  else delete status.dataset.tone;
}

function setEnabled(enabled) {
  codeInput.disabled = !enabled;
  verifyButton.disabled = !enabled;
  keyButton.disabled = !enabled;
}

function unwrap(promise) {
  return promise.catch((error) => {
    report(describeError(error), "error");
  });
}

// A 429 carries the limiter's backoff, which the form honours instead of
// hammering the server.
async function verify() {
  const code = codeInput.value.trim();
  if (!code || busy) return;
  busy = true;
  setEnabled(false);
  verifyButton.textContent = "CHECKING";
  try {
    await requestJSON("/auth/totp/verify", { method: "POST", body: { code } });
    report("Signed in. Opening the terminal…", "ok");
    location.replace("/");
    return;
  } catch (error) {
    codeInput.value = "";
    if (error.status === 429) {
      const delay = Number(/\d+/.exec(error.message)?.[0] ?? "30");
      waitUntil = performance.now() + Math.max(retryFloorMs, delay * 1000);
      report(error.message, "error");
      countdown(waitUntil);
      return;
    }
    report(error.status === 401 ? error.message : describeError(error), "error");
    console.error("totp verification failed", error);
  } finally {
    busy = false;
    verifyButton.textContent = "VERIFY";
    if (performance.now() >= waitUntil) {
      setEnabled(true);
      codeInput.focus();
    }
  }
}

function countdown(until) {
  const tick = () => {
    const remaining = Math.ceil((until - performance.now()) / 1000);
    if (remaining <= 0) {
      verifyButton.textContent = "VERIFY";
      setEnabled(true);
      codeInput.focus();
      return;
    }
    verifyButton.textContent = `WAIT ${remaining}s`;
    setTimeout(tick, 250);
  };
  tick();
}

async function signInWithKey() {
  if (busy) return;
  busy = true;
  setEnabled(false);
  keyButton.textContent = "WAITING FOR SECURITY KEY";
  try {
    report("Follow the browser prompt to use your security key…");
    const assertion = await requestJSON("/auth/login/begin", { method: "POST", body: {} });
    const credential = await navigator.credentials.get({
      publicKey: requestOptions(assertion.publicKey),
    });
    if (!credential) throw new Error("the browser returned no credential");
    await requestJSON("/auth/login/finish", {
      method: "POST",
      body: serializeCredential(credential),
    });
    report("Signed in. Opening the terminal…", "ok");
    location.replace("/");
  } catch (error) {
    console.error("security key login failed", error);
    report(describeError(error), "error");
  } finally {
    busy = false;
    keyButton.textContent = "SIGN IN WITH SECURITY KEY";
    setEnabled(true);
  }
}

async function initialize() {
  ready = false;
  setEnabled(false);
  let session;
  try {
    session = await requestJSON("/auth/session");
  } catch (error) {
    codeInput.hidden = true;
    form.hidden = true;
    report(describeError(error), "error");
    setEnabled(true);
    return;
  }
  if (session.authenticated) {
    report("Already signed in. Opening the terminal…", "ok");
    location.replace("/");
    return;
  }
  const keyUsable = supported() && !!session.rpId;
  form.hidden = !session.totp;
  keyButton.hidden = !keyUsable;

  if (session.totp) {
    intro.textContent = "Enter the current code from your authenticator app.";
    if (session.enrolled) report(`${session.enrolled} security key(s) are also enrolled here.`);
    else report("");
  } else if (keyUsable) {
    intro.textContent = "Touch the security key enrolled for this address.";
    report("Waiting for your security key.");
  } else {
    form.hidden = true;
    intro.textContent = "No factor can sign in at this address.";
    report(
      session.reason ||
        unsupportedReason() ||
        "no authenticator app or usable security key is enrolled",
      "error",
    );
    return;
  }
  if (session.totp) {
    setEnabled(true);
    codeInput.focus();
  } else {
    setEnabled(true);
    keyButton.focus();
  }
  ready = true;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  unwrap(verify());
});
keyButton.addEventListener("click", () => unwrap(signInWithKey()));
codeInput.addEventListener("input", () => {
  codeInput.value = codeInput.value.replace(/[^0-9]/g, "").slice(0, 8);
});
codeInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    unwrap(verify());
  }
});
window.addEventListener("focus", () => {
  // A code that arrived while the tab was hidden should be usable at once.
  if (ready && !codeInput.disabled && !codeInput.value) codeInput.focus();
});

// Test surface: the browser suites read the form's state instead of guessing
// it from the DOM.
globalThis.bcwebmuxAuth = {
  get state() {
    return { ready, busy, waitUntil, code: codeInput.value, disabled: codeInput.disabled };
  },
};

unwrap(initialize());

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

export function initializePasteDialog(terminal) {
  const dialog = document.querySelector("#paste-dialog");
  const open = document.querySelector("#paste-button");
  const input = document.querySelector("#paste-input");
  const send = document.querySelector("#paste-send");
  const cancel = document.querySelector("#paste-cancel");
  const image = document.querySelector("#paste-image");
  const filePreview = document.querySelector("#paste-file");
  const filePath = document.querySelector("#paste-path");
  const status = document.querySelector("#paste-status");
  const terminalInput = document.querySelector("#input");
  let generation = 0;
  let edited = false;
  let file = null;
  let destination = null;
  let imageURL = null;
  let request = null;
  let uploading = false;

  function resetFile() {
    request?.abort();
    request = null;
    if (imageURL) URL.revokeObjectURL(imageURL);
    imageURL = null;
    image.removeAttribute("src");
    image.hidden = true;
    filePreview.hidden = true;
    filePath.textContent = "";
    status.textContent = "";
    input.hidden = false;
    file = destination = null;
    uploading = false;
    send.textContent = "SEND TO TERMINAL";
  }

  function show() {
    ++generation;
    edited = false;
    resetFile();
    input.value = "";
    send.disabled = true;
    terminal.commitComposition();
    terminal.clearSoftModifiers();
    terminal.suspendFocus();
    dialog.showModal();
    input.focus({ preventScroll: true });
  }

  async function json(response) {
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || "File upload failed.");
    return payload;
  }

  async function previewFile(blob) {
    if (!dialog.open) show();
    const current = ++generation;
    edited = true;
    resetFile();
    file = blob;
    input.hidden = true;
    filePreview.hidden = false;
    send.disabled = true;
    send.textContent = "UPLOAD AND PASTE PATH";
    status.textContent = "Preparing temporary path…";
    if (blob.type.startsWith("image/")) {
      imageURL = URL.createObjectURL(blob);
      image.src = imageURL;
      image.hidden = false;
    }
    const controller = (request = new AbortController());
    try {
      const prepared = await json(
        await fetch(`/api/paste-files?type=${encodeURIComponent(blob.type)}`, {
          signal: controller.signal,
        }),
      );
      if (current !== generation || !dialog.open) return;
      destination = prepared;
      filePath.textContent = prepared.path;
      if (!blob.size || blob.size > prepared.maxBytes) {
        status.textContent = "The file must be nonempty and no larger than 20 MiB.";
        return;
      }
      status.textContent =
        "Confirmation will upload the file and paste this path. The server keeps the file in its temporary directory.";
      send.disabled = false;
      send.focus({ preventScroll: true });
    } catch (error) {
      if (current === generation && dialog.open) status.textContent = error.message;
    }
  }

  async function readClipboard() {
    if (navigator.clipboard?.read) {
      try {
        const items = await navigator.clipboard.read();
        const item = items.find((item) => item.types.some((type) => !type.startsWith("text/")));
        if (item) {
          const type =
            item.types.find((type) => type.startsWith("image/")) ||
            item.types.find((type) => !type.startsWith("text/"));
          return { file: await item.getType(type) };
        }
        const textItem = items.find((item) => item.types.includes("text/plain"));
        return { text: textItem ? await (await textItem.getType("text/plain")).text() : "" };
      } catch {
        // Some browsers only support text reads; native Paste can still supply files.
      }
    }
    return { text: await navigator.clipboard.readText() };
  }

  input.addEventListener("input", () => {
    edited = true;
    send.disabled = input.value.length === 0;
  });
  open.addEventListener("pointerdown", (event) => event.preventDefault());
  open.addEventListener("click", async () => {
    if (dialog.open) return;
    show();
    const current = generation;
    try {
      const content = await readClipboard();
      if (current !== generation || !dialog.open || edited) return;
      if (content.file) return previewFile(content.file);
      input.value = content.text;
      send.disabled = content.text.length === 0;
    } catch {
      // The editable preview supports native Paste when clipboard access fails.
    }
  });

  document.addEventListener(
    "paste",
    (event) => {
      if (event.target !== terminalInput && !dialog.contains(event.target)) return;
      const blob = Array.from(event.clipboardData?.files || [])[0];
      if (uploading) {
        event.preventDefault();
        return;
      }
      if (!blob) return;
      event.preventDefault();
      void previewFile(blob);
    },
    true,
  );

  let suppressPasteKeyUp = false;
  terminalInput.addEventListener(
    "keydown",
    async (event) => {
      if (!(event.ctrlKey && event.shiftKey && event.code === "KeyV")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressPasteKeyUp = true;
      const current = ++generation;
      try {
        const content = await readClipboard();
        if (current !== generation || dialog.open || document.activeElement !== terminalInput)
          return;
        if (content.file) await previewFile(content.file);
        else terminal.paste(content.text);
      } catch {
        if (current === generation && !dialog.open && document.activeElement === terminalInput)
          show();
      }
    },
    true,
  );
  terminalInput.addEventListener(
    "keyup",
    (event) => {
      if (event.code !== "KeyV" || !suppressPasteKeyUp) return;
      suppressPasteKeyUp = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );

  send.addEventListener("click", async () => {
    if (send.disabled || uploading) return;
    let text = input.value;
    if (file) {
      if (!destination) return;
      const current = generation;
      const controller = (request = new AbortController());
      uploading = true;
      send.disabled = true;
      status.textContent = "Uploading…";
      try {
        const result = await json(
          await fetch(`/api/paste-files?name=${encodeURIComponent(destination.name)}`, {
            method: "POST",
            body: file,
            signal: controller.signal,
          }),
        );
        if (current !== generation || !dialog.open) return;
        text = /^[A-Za-z0-9_./-]+$/.test(result.path)
          ? result.path
          : `'${result.path.replaceAll("'", "'\\''")}'`;
      } catch (error) {
        if (current === generation && dialog.open) {
          status.textContent = error.message;
          uploading = false;
          send.disabled = false;
        }
        return;
      }
    }
    if (!text) return;
    if (terminal.selectionMode) terminal.exitSelectionMode({ restoreFocus: false });
    terminal.paste(text);
    dialog.close();
  });
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    ++generation;
    resetFile();
    input.value = "";
    send.disabled = true;
    if (!terminal.selectionMode) terminal.resumeFocus({ focus: true });
  });
  return {
    close() {
      ++generation;
      request?.abort();
      if (dialog.open) dialog.close();
    },
  };
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

export function initializeGlyphAtlasDialog(readAtlas) {
  const settings = document.querySelector("#settings-dialog");
  const dialog = document.querySelector("#glyph-atlas-dialog");
  const open = document.querySelector("#glyph-atlas-open");
  const close = document.querySelector("#glyph-atlas-close");
  const refresh = document.querySelector("#glyph-atlas-refresh");
  const actualSize = document.querySelector("#glyph-atlas-actual-size");
  const status = document.querySelector("#glyph-atlas-status");
  const canvas = document.querySelector("#glyph-atlas-canvas");
  let generation = 0;
  let pending = false;

  async function capture() {
    if (pending) return;
    const request = ++generation;
    pending = true;
    open.disabled = refresh.disabled = true;
    canvas.hidden = true;
    status.textContent = "Reading glyph texture…";
    try {
      const snapshot = await readAtlas();
      if (request !== generation || !dialog.open) return;
      const { width, height, data, columns, rows, tileWidth, tileHeight } = snapshot;
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      const image = context.createImageData(width, height);
      for (let i = 0; i < data.length; i++) {
        image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = data[i];
        image.data[i * 4 + 3] = 255;
      }
      context.putImageData(image, 0, 0);
      canvas.hidden = false;
      status.textContent = `${width} × ${height} px · ${columns} × ${rows} slots · ${tileWidth} × ${tileHeight} px/cell · R8`;
    } catch (error) {
      if (request === generation && dialog.open) status.textContent = error.message || "Glyph texture readback failed";
    } finally {
      pending = false;
      open.disabled = refresh.disabled = false;
    }
  }

  open.addEventListener("click", () => {
    dialog.showModal();
    void capture();
  });
  refresh.addEventListener("click", () => { void capture(); });
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    dialog.close();
  });
  actualSize.addEventListener("change", () => canvas.classList.toggle("actual-size", actualSize.checked));
  dialog.addEventListener("click", event => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  });
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    ++generation;
    canvas.hidden = true;
    canvas.width = canvas.height = 1;
    status.textContent = "";
    if (settings.open) open.focus({ preventScroll: true });
  });
  settings.addEventListener("close", () => { if (!settings.open) dialog.close(); });
}

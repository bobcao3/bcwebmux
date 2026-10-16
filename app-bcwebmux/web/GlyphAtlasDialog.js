// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

export function initializeGlyphAtlasDialog(readAtlas, readColorAtlas) {
  const settings = document.querySelector("#settings-dialog");
  const dialog = document.querySelector("#glyph-atlas-dialog");
  const open = document.querySelector("#glyph-atlas-open");
  const close = document.querySelector("#glyph-atlas-close");
  const refresh = document.querySelector("#glyph-atlas-refresh");
  const layer = document.querySelector("#glyph-atlas-layer");
  const actualSize = document.querySelector("#glyph-atlas-actual-size");
  const status = document.querySelector("#glyph-atlas-status");
  const canvas = document.querySelector("#glyph-atlas-canvas");
  let generation = 0;
  let pending = false;
  let blit = null;

  function selectedLayer() {
    return layer?.value === "color" ? "color" : "coverage";
  }

  function renderCoverage(context, snapshot) {
    const { width, height, data } = snapshot;
    if (data.length !== width * height) throw new Error("Glyph atlas data size mismatch");
    const image = context.createImageData(width, height);
    for (let i = 0; i < data.length; i++) {
      image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = data[i];
      image.data[i * 4 + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  }

  function renderColorOverlay(context, snapshot, blit) {
    const { width, height, data } = snapshot;
    if (data.length !== width * height * 4) throw new Error("Glyph atlas data size mismatch");
    if (!blit) blit = document.createElement("canvas");
    blit.width = width;
    blit.height = height;
    const blitContext = blit.getContext("2d");
    const image = blitContext.createImageData(width, height);
    image.data.set(data);
    blitContext.putImageData(image, 0, 0);
    context.fillStyle = "#181818";
    context.fillRect(0, 0, width, height);
    context.drawImage(blit, 0, 0);
    return blit;
  }

  async function capture() {
    if (pending) return;
    const request = ++generation;
    const selected = selectedLayer();
    pending = true;
    open.disabled = refresh.disabled = true;
    if (layer) layer.disabled = true;
    canvas.hidden = true;
    status.textContent = "Reading glyph texture…";
    try {
      let snapshot;
      if (selected === "color") {
        if (!readColorAtlas) throw new Error("Glyph color texture is unavailable");
        snapshot = await readColorAtlas();
      } else {
        snapshot = await readAtlas();
      }
      if (request !== generation || !dialog.open) return;
      const { width, height, columns, rows, tileWidth, tileHeight } = snapshot;
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (selected === "color") {
        canvas.setAttribute("aria-label", "Glyph atlas color overlay");
        blit = renderColorOverlay(context, snapshot, blit);
      } else {
        canvas.setAttribute("aria-label", "Glyph atlas alpha mask");
        renderCoverage(context, snapshot);
      }
      canvas.hidden = false;
      status.textContent = `${width} × ${height} px · ${columns} × ${rows} slots · ${tileWidth} × ${tileHeight} px/cell · ${selected === "color" ? "RGBA overlay" : "R8"}`;
    } catch (error) {
      if (request === generation && dialog.open)
        status.textContent = error.message || "Glyph texture readback failed";
    } finally {
      pending = false;
      open.disabled = refresh.disabled = false;
      if (layer) layer.disabled = false;
    }
  }

  open.addEventListener("click", () => {
    dialog.showModal();
    void capture();
  });
  refresh.addEventListener("click", () => {
    void capture();
  });
  layer?.addEventListener("change", () => {
    if (dialog.open) void capture();
  });
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    dialog.close();
  });
  actualSize.addEventListener("change", () =>
    canvas.classList.toggle("actual-size", actualSize.checked),
  );
  dialog.addEventListener("click", (event) => {
    const rect = dialog.getBoundingClientRect();
    if (
      event.target === dialog &&
      (event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom)
    )
      dialog.close();
  });
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    ++generation;
    canvas.hidden = true;
    canvas.width = canvas.height = 1;
    status.textContent = "";
    if (settings.open) open.focus({ preventScroll: true });
  });
  settings.addEventListener("close", () => {
    if (!settings.open) dialog.close();
  });
}

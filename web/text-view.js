// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const ROW_SIZE = 32;
const CELL_SIZE = 4;
const ROW_WRAP = 1;
const decoder = new TextDecoder("utf-8", { fatal: true });

export class TerminalTextView {
  constructor(element, callbacks) {
    this.element = element;
    this.callbacks = callbacks;
    this.rowsByKey = new Map();
    this.rowPool = [];
    this.cellPool = [];
    this.desired = [];
    this.generation = 0;
    this.enabled = false;
    this.owned = false;
    this.selectionQueued = false;
    this.handleSelectionChange = this.queueSelectionSync.bind(this);
    this.handleCopy = this.copy.bind(this);

  }

  setEnabled(enabled) {
    if (this.enabled === enabled) return false;
    this.enabled = enabled;
    if (enabled) {
      document.addEventListener("selectionchange", this.handleSelectionChange);
      document.addEventListener("copy", this.handleCopy);
    } else {
      document.removeEventListener("selectionchange", this.handleSelectionChange);
      document.removeEventListener("copy", this.handleCopy);
      while (this.element.firstChild) this.element.firstChild.remove();
      this.rowsByKey.clear();
      this.rowPool.length = 0;
      this.cellPool.length = 0;
      this.desired.length = 0;
      this.generation += 1;
    }
    return true;
  }

  update(memory, metadata, rowsPtr, cellsPtr, textPtr, textLen, changed) {
    if (!this.enabled || !changed) return;
    this.generation += 1;
    this.desired.length = 0;
    const { cols, rows } = metadata;
    const cellCount = cols * rows;
    this.validateRange(memory, rowsPtr, rows * ROW_SIZE, "text rows");
    this.validateRange(memory, cellsPtr, cellCount * CELL_SIZE, "text cells");
    this.validateRange(memory, textPtr, textLen, "text bytes");

    const rowData = new DataView(memory, rowsPtr, rows * ROW_SIZE);
    const cellData = new DataView(memory, cellsPtr, cellCount * CELL_SIZE);
    const textData = new Uint8Array(memory, textPtr, textLen);
    for (let y = 0; y < rows; y += 1) {
      const rowOffset = y * ROW_SIZE;
      const byteOffset = rowData.getUint32(rowOffset, true);
      const byteLength = rowData.getUint32(rowOffset + 4, true);
      if (byteOffset > textLen || byteLength > textLen - byteOffset) {
        throw new Error("invalid terminal text row range");
      }
      const serialLow = rowData.getUint32(rowOffset + 8, true);
      const serialHigh = rowData.getUint32(rowOffset + 12, true);
      const pageY = rowData.getUint32(rowOffset + 16, true);
      const flags = rowData.getUint32(rowOffset + 20, true);
      const hashLow = rowData.getUint32(rowOffset + 24, true);
      const hashHigh = rowData.getUint32(rowOffset + 28, true);
      let row = this.element.children[y];
      if (!row ||
          row._terminalSerialLow !== serialLow ||
          row._terminalSerialHigh !== serialHigh ||
          row._terminalPageY !== pageY) {
        const key = `${serialHigh}:${serialLow}:${pageY}`;
        row = this.rowsByKey.get(key);
        if (!row) {
          row = this.rowPool.pop();
          if (!row) row = document.createElement("div");
          row.className = "text-row";
          row._terminalHashLow = undefined;
          row._terminalHashHigh = undefined;
          row._terminalViewportRow = undefined;
          row._terminalWrap = undefined;
          this.rowsByKey.set(key, row);
        }
      }
      const wrap = Boolean(flags & ROW_WRAP);
      if (row._terminalViewportRow !== y) {
        row.dataset.row = String(y);
        row._terminalViewportRow = y;
      }
      if (row._terminalWrap !== wrap) {
        row.dataset.wrap = wrap ? "true" : "false";
        row._terminalWrap = wrap;
      }
      if (row._terminalHashLow !== hashLow || row._terminalHashHigh !== hashHigh) {
        const rowText = decoder.decode(textData.subarray(byteOffset, byteOffset + byteLength));
        this.renderRow(row, rowText, cellData, y, cols);
        row._terminalHashLow = hashLow;
        row._terminalHashHigh = hashHigh;
      }
      row._terminalSerialLow = serialLow;
      row._terminalSerialHigh = serialHigh;
      row._terminalPageY = pageY;
      row._terminalGeneration = this.generation;
      this.desired.push(row);
    }

    for (let index = 0; index < this.desired.length; index += 1) {
      const row = this.desired[index];
      const current = this.element.children[index];
      if (current !== row) this.element.insertBefore(row, current || null);
    }
    for (let index = this.element.children.length - 1; index >= 0; index -= 1) {
      const child = this.element.children[index];
      if (child._terminalGeneration !== this.generation) child.remove();
    }
    for (const [key, row] of this.rowsByKey) {
      if (row._terminalGeneration !== this.generation) {
        this.rowsByKey.delete(key);
        if (row.isConnected) row.remove();
        this.rowPool.push(row);
      }
    }
    this.element.style.height = `calc(${rows} * var(--cell-height))`;
  }

  renderRow(row, rowText, cellData, y, cols) {
    let textOffset = 0;
    let spanIndex = 0;
    for (let x = 0; x < cols; x += 1) {
      const offset = (y * cols + x) * CELL_SIZE;
      const utf16Length = cellData.getUint16(offset, true);
      const width = cellData.getUint8(offset + 2);
      if (width === 0) {
        if (utf16Length !== 0) throw new Error("terminal spacer cell contains text");
        continue;
      }
      if (width > 2 || utf16Length === 0 || textOffset + utf16Length > rowText.length) {
        throw new Error("invalid terminal text cell");
      }
      let cell = row.children[spanIndex];
      if (!cell) {
        cell = this.cellPool.pop() || document.createElement("span");
        cell.className = "text-cell";
        row.append(cell);
      }
      const start = String(x);
      const end = String(Math.min(cols, x + width));
      const cellWidth = String(width);
      if (cell.dataset.start !== start) cell.dataset.start = start;
      if (cell.dataset.end !== end) cell.dataset.end = end;
      if (cell.dataset.width !== cellWidth) cell.dataset.width = cellWidth;
      const text = rowText.slice(textOffset, textOffset + utf16Length);
      const textNode = cell.firstChild;
      if (textNode?.nodeType === Node.TEXT_NODE && cell.childNodes.length === 1) {
        if (textNode.data !== text) textNode.data = text;
      } else {
        cell.replaceChildren(document.createTextNode(text));
      }
      textOffset += utf16Length;
      spanIndex += 1;
    }
    if (textOffset !== rowText.length) throw new Error("terminal text row length mismatch");
    while (row.children.length > spanIndex) {
      const cell = row.lastElementChild;
      cell.remove();
      this.cellPool.push(cell);
    }
  }

  validateRange(memory, pointer, length, label) {
    if (!Number.isSafeInteger(pointer) || pointer < 0 ||
        !Number.isSafeInteger(length) || length < 0 ||
        pointer > memory.byteLength || length > memory.byteLength - pointer) {
      throw new Error(`invalid ${label}`);
    }
  }

  queueSelectionSync() {
    if (this.selectionQueued) return;
    this.selectionQueued = true;
    requestAnimationFrame(() => {
      this.selectionQueued = false;
      this.syncSelection();
    });
  }

  syncSelection() {
    if (!this.enabled) return;
    const selection = document.getSelection();
    const range = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
    if (!range || selection.isCollapsed || !this.contains(range.startContainer) || !this.contains(range.endContainer)) {
      if (this.owned) {
        this.owned = false;
        this.callbacks.clearSelection();
      }
      return;
    }

    const start = this.boundary(range.startContainer, range.startOffset);
    const end = this.boundary(range.endContainer, range.endOffset);
    if (!start || !end || (start.row === end.row && start.col === end.col)) {
      if (this.owned) {
        this.owned = false;
        this.callbacks.clearSelection();
      }
      return;
    }
    if (this.callbacks.setSelection(start, end)) this.owned = true;
  }

  boundary(node, offset) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element) return null;
    const row = element.closest?.(".text-row");
    if (!row || row.parentElement !== this.element) {
      if (element !== this.element) return null;
      const child = this.element.children[offset];
      if (child) return { row: Number(child.dataset.row), col: 0 };
      const last = this.element.lastElementChild;
      return last ? { row: Number(last.dataset.row), col: this.rowEnd(last) } : null;
    }

    const rowIndex = Number(row.dataset.row);
    const cell = element.closest?.(".text-cell");
    if (cell && cell.parentElement === row) {
      return {
        row: rowIndex,
        col: offset === 0 ? Number(cell.dataset.start) : Number(cell.dataset.end),
      };
    }

    if (element === row) {
      const child = row.children[offset];
      return {
        row: rowIndex,
        col: child ? Number(child.dataset.start) : this.rowEnd(row),
      };
    }
    return null;
  }

  rowEnd(row) {
    return Number(row.lastElementChild?.dataset.end || 0);
  }

  contains(node) {
    return node === this.element || this.element.contains(node);
  }

  hasSelection() {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return false;
    const range = selection.getRangeAt(0);
    return this.contains(range.startContainer) && this.contains(range.endContainer);
  }

  clearBrowserSelection(clearTerminal = true) {
    const selection = document.getSelection();
    const range = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
    const containsRange = range && this.contains(range.startContainer) && this.contains(range.endContainer);
    this.owned = false;
    if (containsRange) selection.removeAllRanges();
    if (clearTerminal) this.callbacks.clearSelection();
  }

  copy(event) {
    if (!this.owned || !this.hasSelection() || !event.clipboardData) return;
    const text = this.callbacks.selectionText();
    if (text === null) return;
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
  }
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const ROW_SIZE = 24;
const CELL_SIZE = 4;
const ROW_WRAP = 1;
const decoder = new TextDecoder("utf-8", { fatal: true });

export class TerminalTextView {
  constructor(element, callbacks) {
    this.element = element;
    this.callbacks = callbacks;
    this.rowsByKey = new Map();
    this.owned = false;
    this.selectionQueued = false;

    document.addEventListener("selectionchange", () => this.queueSelectionSync());
    document.addEventListener("copy", event => this.copy(event));
  }

  update(memory, metadata, rowsPtr, cellsPtr, textPtr, textLen, changed) {
    if (!changed) return;
    const { cols, rows } = metadata;
    const cellCount = cols * rows;
    this.validateRange(memory, rowsPtr, rows * ROW_SIZE, "text rows");
    this.validateRange(memory, cellsPtr, cellCount * CELL_SIZE, "text cells");
    this.validateRange(memory, textPtr, textLen, "text bytes");

    const rowData = new DataView(memory, rowsPtr, rows * ROW_SIZE);
    const cellData = new DataView(memory, cellsPtr, cellCount * CELL_SIZE);
    const textData = new Uint8Array(memory, textPtr, textLen);
    const desired = [];
    const desiredKeys = new Set();

    for (let y = 0; y < rows; y += 1) {
      const rowOffset = y * ROW_SIZE;
      const byteOffset = rowData.getUint32(rowOffset, true);
      const byteLength = rowData.getUint32(rowOffset + 4, true);
      if (byteOffset > textLen || byteLength > textLen - byteOffset) {
        throw new Error("invalid terminal text row range");
      }
      const serial = rowData.getBigUint64(rowOffset + 8, true);
      const pageY = rowData.getUint32(rowOffset + 16, true);
      const flags = rowData.getUint32(rowOffset + 20, true);
      const key = `${serial.toString(16)}:${pageY}`;
      const rowText = decoder.decode(textData.subarray(byteOffset, byteOffset + byteLength));
      const layout = this.cellLayout(cellData, y, cols);

      let row = this.rowsByKey.get(key);
      if (!row) {
        row = document.createElement("div");
        row.className = "text-row";
        this.rowsByKey.set(key, row);
      }
      row.dataset.row = String(y);
      row.dataset.wrap = flags & ROW_WRAP ? "true" : "false";
      if (row._terminalText !== rowText || row._terminalLayout !== layout) {
        this.renderRow(row, rowText, cellData, y, cols);
        row._terminalText = rowText;
        row._terminalLayout = layout;
      }
      desired.push(row);
      desiredKeys.add(key);
    }

    for (let index = 0; index < desired.length; index += 1) {
      const row = desired[index];
      const current = this.element.children[index];
      if (current !== row) this.element.insertBefore(row, current || null);
    }
    for (const child of [...this.element.children]) {
      if (!desired.includes(child)) child.remove();
    }
    for (const [key, row] of this.rowsByKey) {
      if (!desiredKeys.has(key)) {
        this.rowsByKey.delete(key);
        if (row.isConnected) row.remove();
      }
    }
    this.element.style.height = `calc(${rows} * var(--cell-height))`;
  }

  cellLayout(cellData, y, cols) {
    let result = "";
    for (let x = 0; x < cols; x += 1) {
      const offset = (y * cols + x) * CELL_SIZE;
      result += String.fromCharCode(
        cellData.getUint16(offset, true),
        cellData.getUint8(offset + 2),
        cellData.getUint8(offset + 3),
      );
    }
    return result;
  }

  renderRow(row, rowText, cellData, y, cols) {
    const fragment = document.createDocumentFragment();
    let textOffset = 0;
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
      const cell = document.createElement("span");
      cell.className = "text-cell";
      cell.dataset.start = String(x);
      cell.dataset.end = String(Math.min(cols, x + width));
      cell.dataset.width = String(width);
      cell.textContent = rowText.slice(textOffset, textOffset + utf16Length);
      textOffset += utf16Length;
      fragment.append(cell);
    }
    if (textOffset !== rowText.length) throw new Error("terminal text row length mismatch");
    row.replaceChildren(fragment);
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

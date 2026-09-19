// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const ROW_SIZE = 32;
const CELL_SIZE = 4;
const CELL_TEXT = 1;
const ROW_WRAP = 1;
const COARSE_SELECTION_HIT_SLOP = 22;
const decoder = new TextDecoder("utf-8", { fatal: true });
const GHOSTTY_WORD_BOUNDARIES = new Set([
  0x00, 0x20, 0x09, 0x22, 0x27, 0x2502, 0x60, 0x7c, 0x3a, 0x3b, 0x2c,
  0x5b, 0x5d, 0x7b, 0x7d, 0x28, 0x29, 0x3c, 0x3e, 0x24,
]);

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

  update(packet) {
    if (!this.enabled || !packet.textChanged) return;
    this.generation += 1;
    this.desired.length = 0;
    const { cols, rows, textRows: rowData, textCells: cellData, textBytes: textData } = packet;
    const textLen = textData.length;
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
      const flags = cellData.getUint8(offset + 3);
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
      cell._terminalCellText = (flags & CELL_TEXT) !== 0;
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

  selectWordAtPoint(clientX, clientY, options = {}) {
    const target = document.elementFromPoint(clientX, clientY);
    let cell = target?.closest?.(".text-cell");
    let row = cell?.closest?.(".text-row");
    if (!cell || !row || cell.parentElement !== row || row.parentElement !== this.element) {
      cell = null;
      row = null;
    }
    if (cell && options.nearest === true && cell._terminalCellText !== true) {
      cell = null;
      row = null;
    }
    if (!cell && options.nearest === true) {
      const style = getComputedStyle(this.element);
      const cellWidth = Number.parseFloat(style.getPropertyValue("--cell-width"));
      const cellHeight = Number.parseFloat(style.getPropertyValue("--cell-height"));
      const viewRect = this.element.getBoundingClientRect();
      if (Number.isFinite(cellWidth) && cellWidth > 0 &&
          Number.isFinite(cellHeight) && cellHeight > 0) {
        let nearestDistance = Infinity;
        for (const candidateRow of this.element.children) {
          if (!candidateRow.classList.contains("text-row") ||
              candidateRow.parentElement !== this.element) continue;
          const rowIndex = Number(candidateRow.dataset.row);
          if (!Number.isInteger(rowIndex)) continue;
          const top = viewRect.top + rowIndex * cellHeight;
          const bottom = top + cellHeight;
          const dy = clientY < top ? top - clientY : clientY > bottom ? clientY - bottom : 0;
          if (dy > COARSE_SELECTION_HIT_SLOP) continue;
          for (const candidateCell of candidateRow.children) {
            if (!candidateCell.classList.contains("text-cell") ||
                candidateCell._terminalCellText !== true) continue;
            const start = Number(candidateCell.dataset.start);
            const end = Number(candidateCell.dataset.end);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
            const left = viewRect.left + start * cellWidth;
            const right = viewRect.left + end * cellWidth;
            const dx = clientX < left ? left - clientX : clientX > right ? clientX - right : 0;
            const distance = dx * dx + dy * dy;
            if (distance <= COARSE_SELECTION_HIT_SLOP ** 2 && distance < nearestDistance) {
              nearestDistance = distance;
              cell = candidateCell;
              row = candidateRow;
            }
          }
        }
      }
    }
    if (!cell || !row) return false;
    if (cell.parentElement !== row || row.parentElement !== this.element) {
      return false;
    }
    const cellText = cell.textContent || "";
    if (!cellText) return false;

    let cellIndex = -1;
    for (let index = 0; index < row.children.length; index += 1) {
      if (row.children[index] === cell) {
        cellIndex = index;
        break;
      }
    }
    if (cellIndex < 0) return false;
    const isBoundary = (candidate) =>
      GHOSTTY_WORD_BOUNDARIES.has((candidate.textContent || "").codePointAt(0));
    const boundary = isBoundary(cell);
    let firstIndex = cellIndex;
    let lastIndex = cellIndex;
    while (firstIndex > 0 &&
           row.children[firstIndex - 1]._terminalCellText === true &&
           isBoundary(row.children[firstIndex - 1]) === boundary) {
      firstIndex -= 1;
    }
    while (lastIndex + 1 < row.children.length &&
           row.children[lastIndex + 1]._terminalCellText === true &&
           isBoundary(row.children[lastIndex + 1]) === boundary) {
      lastIndex += 1;
    }
    const firstText = row.children[firstIndex].firstChild;
    const lastText = row.children[lastIndex].firstChild;
    if (!firstText || !lastText) return false;

    const range = document.createRange();
    range.setStart(firstText, 0);
    range.setEnd(lastText, lastText.length);
    const selection = document.getSelection();
    if (!selection) return false;
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
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
    this.clearBrowserSelection(true);
  }
}

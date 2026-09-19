export interface IDisposable {
  dispose(): void;
}

export interface GpuAdapterInfoDraft {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
}

export interface GpuTerminalStatsDraft {
  backend: "webgpu" | "webgl2";
  textRenderer: "kb-stb" | "kb-canvas";
  shaderF16: boolean;
  fontFamily: string;
  fontReloads: number;
  gpuFrames: number;
  drawCalls?: number;
  coreSwitches: number;
  frameMs: number | null;
  queueDrainMs: number | null;
  gpuFrameMs: number | null;
  presentationOpportunityMs: number | null;
  bundleExecutions: number;
  rasterPasses: number;
  cacheHits: number;
  cacheMisses: number;
  grainStrength: number;
  atlasCapacity: number;
  atlasRequiredSlots: number;
  glyphSlotsUsed: number;
  viewportWidth: number;
  viewportHeight: number;
  physicalCellWidth: number;
  physicalCellHeight: number;
  physicalFontSize: number;
  pixelScaleX: number;
  pixelScaleY: number;
  gpuAdapter: GpuAdapterInfoDraft;
  gpuFallbackAdapter: boolean;
  gpuError: string | null;
}

export interface TerminalViewElements {
  viewport: HTMLElement;
  surface: HTMLDivElement;
  scrollbar: HTMLDivElement;
  scrollbarThumb: HTMLDivElement;
  textView: HTMLDivElement;
  input: HTMLTextAreaElement;
  screen: HTMLCanvasElement;
  composition: HTMLDivElement;
}

export type TerminalRenderer = "kb-stb" | "kb-canvas";

export type TerminalRenderBackend = "auto" | "webgpu" | "webgl2";

export interface TerminalTheme {
  background: string;
  foreground: string;
  surface?: string;
  border?: string;
  accent?: string;
  muted?: string;
  success?: string;
  danger?: string;
  ansi: readonly string[];
}

export interface TerminalFont {
  id?: string;
  name?: string;
  cssFamily: string;
  wasmId?: number;
  size: number;
  ligatures: boolean;
  fallbacks: readonly string[];
  /** Browser-only fonts are unsupported; both rasterizers use wasmFontUrls. */
  canvasOnly?: false;
}

export interface TerminalDebugElements {
  panel?: HTMLElement | null;
  log?: HTMLElement | null;
  clear?: HTMLElement | null;
  copy?: HTMLElement | null;
}

export interface TerminalOptions {
  wasmUrl?: string | URL;
  /** Font URLs in regular, bold, italic, bold-italic order; relative URLs resolve beside wasmUrl. */
  wasmFontUrls?: readonly [string | URL, string | URL, string | URL, string | URL];
  renderer?: TerminalRenderer;
  renderBackend?: TerminalRenderBackend;
  canonicalGeometry?: boolean;
  font?: Partial<TerminalFont>;
  theme?: TerminalTheme;
  grainStrength?: number;
  glyphCacheMaxBytes?: number;
  elements?: TerminalViewElements;
  terminalElement?: HTMLElement;
  inputDebug?: boolean;
  debugElements?: TerminalDebugElements;
  clipboardWrite?: (text: string) => void | Promise<void>;
}

export interface TerminalCoreOptions {
  wasmUrl?: string | URL;
  /** Font URLs in regular, bold, italic, bold-italic order; relative URLs resolve beside wasmUrl. */
  wasmFontUrls?: readonly [string | URL, string | URL, string | URL, string | URL];
  renderer?: TerminalRenderer;
  font?: Partial<TerminalFont>;
  theme?: TerminalTheme;
  clipboardWrite?: (text: string) => void | Promise<void>;
}

export interface TerminalAddon extends IDisposable {
  activate(terminal: Terminal): void;
}

export interface TerminalSelectionModeEvent {
  active: boolean;
  flush: boolean;
  restoreFocus?: boolean;
}

export interface TerminalState extends Partial<GpuTerminalStatsDraft> {
  selectionMode: boolean;
  frames: number;
  rxBytes: number;
  txBytes: number;
  cols: number;
  rows: number;
  viewportMode: "active" | "top" | "pinned";
  scrollTotal: number;
  scrollOffset: number;
  scrollLength: number;
  wasmParseMs: number | null;
  wasmFrameMs: number | null;
  rxLatencyMs: number | null;
  inputLatencyMs: number | null;
}

export interface TerminalCoreState {
  frames: number;
  rxBytes: number;
  txBytes: number;
  replyBytes: number;
  cols: number;
  rows: number;
  wasmParseMs: number | null;
  wasmFrameMs: number | null;
}

export interface GlyphPartition {
  baseSlot: number;
  slotCapacity: number;
  generation: number;
}

export interface FrameExpectations {
  abi?: 5;
  coreGeneration?: number;
  configGeneration?: number;
  partition?: GlyphPartition;
  cellSize: number;
  styleSize: number;
  frameSize: number;
  packetSize: number;
  maxCells: number;
  maxStyles: number;
  atlas: { columns: number; tileWidth: number; tileHeight: number };
}

/** Views are borrowed only for the synchronous consumeFrame callback. Do not retain them. */
export interface FramePacket {
  readonly token: number;
  readonly coreGeneration: number;
  readonly configGeneration: number;
  readonly leaseGeneration: number;
  readonly fullFrame: boolean;
  readonly revision: number;
  readonly graphicsRevision: number;
  readonly graphicsDraws: DataView;
  readonly graphicsResources: DataView;
  readonly cells: Uint8Array;
  readonly dirtyRanges: DataView;
  readonly dirtyRangesCount: number;
  readonly styles: Uint32Array;
  readonly styleBytes: Uint8Array;
  readonly stylesFirst: number;
  readonly stylesCount: number;
  readonly selections: Uint32Array;
  readonly selectionBytes: Uint8Array;
  readonly bitmapUploads: DataView;
  readonly bitmapUploadsCount: number;
  readonly bitmapUploadPixels: Uint8Array;
  readonly canvasRequests: DataView;
  readonly canvasRequestsCount: number;
  readonly canvasPaths: DataView;
  readonly canvasPathsCount: number;
  readonly textRows: DataView;
  readonly textCells: DataView;
  readonly textBytes: Uint8Array;
  readonly textChanged: boolean;
  readonly cols: number;
  readonly rows: number;
  readonly frameCells: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly background: number;
  readonly foreground: number;
  readonly cursorX: number;
  readonly cursorY: number;
  readonly cursorFlags: number;
  readonly cursorStyle: number;
  readonly scrollTotal: number;
  readonly scrollOffset: number;
  readonly scrollLength: number;
  readonly viewportMode: "active" | "top" | "pinned";
  readonly glyphPartitionBase: number;
  readonly glyphPartitionCapacity: number;
  readonly glyphPartitionGeneration: number;
  readonly glyphSlotsUsed: number;
}

export declare class TerminalCore implements IDisposable {
  constructor(options?: TerminalCoreOptions);
  readonly options: TerminalCoreOptions;
  readonly opened: boolean;
  readonly disposed: boolean;
  readonly ready: boolean;
  readonly memoryBytes: number;
  readonly cols: number;
  readonly rows: number;
  readonly state: TerminalCoreState;

  onData(listener: (data: Uint8Array) => void): IDisposable;
  onReply(listener: (data: Uint8Array) => void): IDisposable;
  onTitleChange(listener: (title: string) => void): IDisposable;
  onBell(listener: () => void): IDisposable;
  onNotification(listener: (notification: { title: string; body: string }) => void): IDisposable;
  onError(listener: (error: unknown) => void): IDisposable;

  open(size?: { cols?: number; rows?: number }): Promise<this>;
  write(data: string | ArrayBuffer | ArrayBufferView): void;
  input(text: string, options?: { paste?: boolean }): void;
  paste(text: string): void;
  setTheme(theme: TerminalTheme): void;
  setFont(font: Partial<TerminalFont>): void;
  setRenderer(renderer: TerminalRenderer): void;
  setRenderMetrics(layout: { cellWidth: number; cellHeight: number; fontSize: number }): number;
  setGlyphPartition(partition: GlyphPartition, atlasColumns: number): number;
  consumeFrame(consumer: (packet: FramePacket) => void | boolean, expectations: FrameExpectations): 0 | 1;
  invalidateFrame(): void;
  invalidateTextView(): void;
  setTextViewEnabled(enabled: boolean): number;
  scrollBottom(): number;
  scrollRow(row: number): number;
  scrollDelta(rows: number): number;
  scrollInput(rows: number, mods: number, x: number, y: number): number;
  mouse(action: number, button: number, mods: number, x: number, y: number, pressed: number): number;
  selection(action: number, x: number, y: number): number;
  selectWord(x: number, y: number): number;
  focus(focused: boolean): number;
  hyperlinkAt(x: number, y: number): string | null;
  resizeCanonical(options: { cols: number; rows: number; cellWidthPx?: number; cellHeightPx?: number }): number;
  setReplayMode(enabled: boolean): number;
  getSelection(): string | null;
  clearSelection(): boolean;
  reset(): boolean;
  restoreSnapshot(data: string | ArrayBuffer | ArrayBufferView): void;
  clearPendingLatency(): void;
  dispose(): void;
}

export declare class Terminal implements IDisposable {
  constructor(options?: TerminalOptions);
  readonly options: TerminalOptions;
  readonly core: TerminalCore | undefined;
  readonly coreCount: number;
  readonly element: HTMLElement | undefined;
  readonly screenElement: HTMLCanvasElement | undefined;
  readonly textarea: HTMLTextAreaElement | undefined;
  readonly cols: number;
  readonly rows: number;
  readonly selectionMode: boolean;
  readonly softModifiers: number;
  readonly isComposing: boolean;
  readonly inputTrace: string;
  readonly state: TerminalState;

  onData(listener: (data: Uint8Array) => void): IDisposable;
  onResize(listener: (size: { cols: number; rows: number }) => void): IDisposable;
  onSelectionModeChange(listener: (event: TerminalSelectionModeEvent) => void): IDisposable;
  onSoftModifiersChange(listener: (modifiers: number) => void): IDisposable;
  onTitleChange(listener: (title: string) => void): IDisposable;
  onBell(listener: () => void): IDisposable;
  onNotification(listener: (notification: { title: string; body: string }) => void): IDisposable;
  onLinkActivate(listener: (link: { uri: string; event: PointerEvent | MouseEvent }) => void): IDisposable;
  onError(listener: (error: unknown) => void): IDisposable;

  loadAddon(addon: TerminalAddon): void;
  open(parent: HTMLElement): Promise<this>;
  createCore(options?: TerminalCoreOptions): Promise<TerminalCore>;
  attachCore(core: TerminalCore): TerminalCore;
  write(data: string | ArrayBuffer | ArrayBufferView): void;
  input(text: string, options?: { paste?: boolean }): void;
  paste(text: string): void;
  setTheme(theme: TerminalTheme): void;
  setFont(font: Partial<TerminalFont>): Promise<void>;
  setRenderer(renderer: TerminalRenderer): void;
  setGrainStrength(value: number): void;
  setGlyphCacheMaxBytes(value: number): number;
  setSoftModifiers(value: number): void;
  clearSoftModifiers(): void;
  sendKey(code: string, key: string, modifiers?: number): number;
  commitComposition(): boolean;
  getSelection(): string | null;
  copySelection(): Promise<boolean>;
  clearSelection(): boolean;
  enterSelectionMode(): boolean;
  exitSelectionMode(options?: { flush?: boolean; restoreFocus?: boolean }): boolean;
  focus(): void;
  blur(): void;
  suspendFocus(): void;
  resumeFocus(options?: { focus?: boolean }): void;
  resize(): unknown;
  reset(): boolean;
  restoreSnapshot(data: string | ArrayBuffer | ArrayBufferView, core?: TerminalCore): void;
  readPixels(): Promise<{ width: number; height: number; format: string; data: Uint8Array }>;
  clearPendingLatency(): void;
  dispose(): void;
}

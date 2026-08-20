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
  backend: "webgpu";
  textRenderer: "kb-stb" | "kb-canvas";
  shaderF16: boolean;
  fontFamily: string;
  fontReloads: number;
  gpuFrames: number;
  frameMs: number | null;
  queueDrainMs: number | null;
  gpuFrameMs: number | null;
  presentationOpportunityMs: number | null;
  bundleExecutions: number;
  rasterPasses: number;
  cacheHits: number;
  cacheMisses: number;
  atlasGlyphs: number;
  atlasFormat: "r8unorm" | "rgba8unorm";
  grainStrength: number;
  atlasCapacity: number;
  atlasRequiredSlots: number;
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
  scroll: HTMLDivElement;
  spacer: HTMLDivElement;
  textView: HTMLDivElement;
  input: HTMLTextAreaElement;
  screen: HTMLCanvasElement;
  composition: HTMLDivElement;
}

export type TerminalRenderer = "kb-stb" | "kb-canvas";

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
  canvasOnly?: boolean;
}

export interface TerminalDebugElements {
  panel?: HTMLElement | null;
  log?: HTMLElement | null;
  clear?: HTMLElement | null;
  copy?: HTMLElement | null;
}

export interface TerminalOptions {
  wasmUrl?: string | URL;
  renderer?: TerminalRenderer;
  font?: Partial<TerminalFont>;
  theme?: TerminalTheme;
  grainStrength?: number;
  elements?: TerminalViewElements;
  terminalElement?: HTMLElement;
  inputDebug?: boolean;
  debugElements?: TerminalDebugElements;
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
  wasmParseMs: number | null;
  wasmFrameMs: number | null;
  rxLatencyMs: number | null;
  inputLatencyMs: number | null;
}

export declare class Terminal implements IDisposable {
  constructor(options?: TerminalOptions);
  readonly options: TerminalOptions;
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
  write(data: string | ArrayBuffer | ArrayBufferView): void;
  input(text: string, options?: { paste?: boolean }): void;
  paste(text: string): void;
  setTheme(theme: TerminalTheme): void;
  setFont(font: Partial<TerminalFont>): Promise<void>;
  setRenderer(renderer: TerminalRenderer): void;
  setGrainStrength(value: number): void;
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
  readPixels(): Promise<{ width: number; height: number; format: string; data: Uint8Array }>;
  clearPendingLatency(): void;
  dispose(): void;
}

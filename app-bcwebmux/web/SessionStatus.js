// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const PROGRAM_STATES = new Set(["idle", "working", "done", "blocked", "error"]);
const PROGRESS_STATES = new Map([
  ["set", "working"],
  ["error", "error"],
  ["indeterminate", "working"],
  ["pause", "blocked"],
]);
const BLOCKED_LABELS = {
  permission: "approval required",
  question: "answer required",
  auth: "authentication required",
};

export function sessionStatus(metadata) {
  const program = metadata?.programStatus;
  const report = metadata?.progressReport;
  const hasProgram = PROGRAM_STATES.has(program?.state);
  const state = hasProgram ? program.state : PROGRESS_STATES.get(report?.state);
  if (!state) return null;
  const progress = hasProgram ? program.progress : report.progress;
  return {
    state,
    kind: hasProgram ? program.kind : null,
    progress: Number.isInteger(progress) && progress >= 0 && progress <= 100 ? progress : null,
    paused: !hasProgram && report.state === "pause",
  };
}

export function programStatusLabel(status) {
  if (!status) return "";
  const parts = [status.paused ? "paused" : status.state];
  if (status.state === "blocked" && BLOCKED_LABELS[status.kind])
    parts.push(BLOCKED_LABELS[status.kind]);
  if (status.progress !== null) parts.push(`${status.progress}%`);
  return parts.join(" · ");
}

export function applySessionStatus(element, status) {
  const programStatus = status ? status.state : "";
  if ((element.dataset.programStatus ?? "") !== programStatus) {
    if (status) element.dataset.programStatus = status.state;
    else delete element.dataset.programStatus;
  }
  const paused = Boolean(status?.paused);
  if (element.classList.contains("is-paused") !== paused)
    element.classList.toggle("is-paused", paused);
  const progress = status?.state === "done" ? 100 : status?.progress;
  const progressText = progress == null ? "" : String(progress);
  if ((element.dataset.progress ?? "") !== progressText) {
    if (progress != null) element.dataset.progress = String(progress);
    else delete element.dataset.progress;
  }
  const progressStyle = progress == null ? "" : `${progress}%`;
  if (element.style.getPropertyValue("--session-progress") !== progressStyle) {
    if (progress != null) element.style.setProperty("--session-progress", `${progress}%`);
    else element.style.removeProperty("--session-progress");
  }
  return progress ?? null;
}

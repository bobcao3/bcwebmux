// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

export function reconcileLayout(layout, ids) {
  const remaining = new Set(ids);
  const result = [];
  if (Array.isArray(layout)) {
    for (const entry of layout) {
      const members = (Array.isArray(entry) ? entry : [entry]).filter((id) => {
        if (typeof id !== "string" || !remaining.has(id)) return false;
        remaining.delete(id);
        return true;
      });
      if (members.length === 1) result.push(members[0]);
      else if (members.length > 1) result.push(members);
    }
  }
  for (const id of remaining) result.push(id);
  return result;
}

export function moveSession(layout, source, target, position) {
  if (source === target) return layout;
  const entries = layout.map((entry) => (Array.isArray(entry) ? [...entry] : entry));
  const sourceIndex = entries.findIndex((entry) =>
    Array.isArray(entry) ? entry.includes(source) : entry === source,
  );
  if (sourceIndex < 0) return layout;
  const sourceGroup = Array.isArray(entries[sourceIndex]) ? entries[sourceIndex] : null;
  const sameGroup = sourceGroup?.includes(target) && sourceGroup.length > 2;
  if (Array.isArray(entries[sourceIndex])) {
    const members = entries[sourceIndex].filter((id) => id !== source);
    entries[sourceIndex] = members.length === 1 ? members[0] : members;
  } else entries.splice(sourceIndex, 1);
  const targetIndex = entries.findIndex((entry) =>
    Array.isArray(entry) ? entry.includes(target) : entry === target,
  );
  if (targetIndex < 0) return layout;
  const entry = entries[targetIndex];
  if (Array.isArray(entry) && (position === "before" || position === "after")) {
    const index = entry.indexOf(target);
    if (sameGroup || (position === "before" ? index > 0 : index < entry.length - 1)) {
      position = `inside-${position}`;
    }
  }
  if (position === "group") {
    if (Array.isArray(entry)) entry.push(source);
    else entries[targetIndex] = [entry, source];
  } else if (Array.isArray(entry) && position === "inside-before") {
    entry.splice(entry.indexOf(target), 0, source);
  } else if (Array.isArray(entry) && position === "inside-after") {
    entry.splice(entry.indexOf(target) + 1, 0, source);
  } else entries.splice(targetIndex + (position.endsWith("after") ? 1 : 0), 0, source);
  return entries;
}

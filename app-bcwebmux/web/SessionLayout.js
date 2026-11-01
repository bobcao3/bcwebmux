// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

// A layout entry is either a session id (a lone session) or a group object
// { name, members }. Legacy entries may still be arrays of ids; they are
// normalized here so the rest of the drawer only sees the two canonical forms.
export function isGroupEntry(entry) {
  return Boolean(entry && typeof entry === "object" && !Array.isArray(entry));
}

export function groupMembers(entry) {
  if (isGroupEntry(entry)) return Array.isArray(entry.members) ? entry.members : [];
  return Array.isArray(entry) ? entry : [entry];
}

function normalizeEntry(entry) {
  if (isGroupEntry(entry)) {
    return {
      name: typeof entry.name === "string" ? entry.name : "",
      members: Array.isArray(entry.members) ? entry.members : [],
    };
  }
  return { name: "", members: Array.isArray(entry) ? entry : [entry] };
}

export function reconcileLayout(layout, ids) {
  const remaining = new Set(ids);
  const result = [];
  if (Array.isArray(layout)) {
    for (const entry of layout) {
      const { name, members: candidates } = normalizeEntry(entry);
      const members = candidates.filter((id) => {
        if (typeof id !== "string" || !remaining.has(id)) return false;
        remaining.delete(id);
        return true;
      });
      if (members.length === 1) result.push(members[0]);
      else if (members.length > 1) result.push({ name, members });
    }
  }
  for (const id of remaining) result.push(id);
  return result;
}

export function moveSession(layout, source, target, position) {
  if (source === target) return layout;
  const entries = layout.map((entry) =>
    isGroupEntry(entry) || Array.isArray(entry)
      ? {
          name: isGroupEntry(entry) ? (entry.name ?? "") : "",
          members: [...groupMembers(entry)],
        }
      : entry,
  );
  const sourceIndex = entries.findIndex((entry) => groupMembers(entry).includes(source));
  if (sourceIndex < 0) return layout;
  const sourceEntry = entries[sourceIndex];
  const sourceGroup = isGroupEntry(sourceEntry) ? sourceEntry : null;
  const sameGroup = sourceGroup?.members.includes(target) && sourceGroup.members.length > 2;
  if (sourceGroup) {
    const members = sourceGroup.members.filter((id) => id !== source);
    entries[sourceIndex] = members.length === 1 ? members[0] : { name: sourceGroup.name, members };
  } else entries.splice(sourceIndex, 1);
  const targetIndex = entries.findIndex((entry) => groupMembers(entry).includes(target));
  if (targetIndex < 0) return layout;
  const entry = entries[targetIndex];
  if (isGroupEntry(entry) && (position === "before" || position === "after")) {
    const index = entry.members.indexOf(target);
    if (sameGroup || (position === "before" ? index > 0 : index < entry.members.length - 1)) {
      position = `inside-${position}`;
    }
  }
  if (position === "group") {
    if (isGroupEntry(entry)) entry.members.push(source);
    else entries[targetIndex] = { name: "", members: [entry, source] };
  } else if (isGroupEntry(entry) && position === "inside-before") {
    entry.members.splice(entry.members.indexOf(target), 0, source);
  } else if (isGroupEntry(entry) && position === "inside-after") {
    entry.members.splice(entry.members.indexOf(target) + 1, 0, source);
  } else entries.splice(targetIndex + (position.endsWith("after") ? 1 : 0), 0, source);
  return entries;
}

export function renameGroup(layout, anchor, name) {
  return layout.map((entry) => {
    const group = isGroupEntry(entry)
      ? entry
      : Array.isArray(entry)
        ? { name: "", members: entry }
        : null;
    if (!group || !group.members.includes(anchor)) return entry;
    return { name, members: [...group.members] };
  });
}

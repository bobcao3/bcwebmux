#!/usr/bin/env bash
# doc-metrics: reader-page measurement for markdown docs.
#
# 1 page = one 80x24 terminal screen: 24 rows of 80 columns. Override the
# geometry with COLS and PAGE_ROWS.
#
# A line occupies ceil(columns / COLS) rows, with a minimum of one row: a blank
# line counts as one row, a 79-column line counts as one row, and a line that
# folds past the right edge counts as several. Tabs advance to the next
# multiple of 8 columns. Each character counts as one column, so wide CJK
# glyphs are undercounted; the docs this measures are Latin prose.
#
# Usage:
#   bash scripts/doc-metrics.sh [FILE...]
#
# With no FILE arguments, discovers markdown from the current directory using
# fd, then git ls-files. Run it from the repository root for stable paths.
#
# Output, per file:
#   FILE    <path>  lines=<n>  rows=<n>  pages=<n.nn>  cols=<n>
#   HEADING <line>  <pages-before>  <rows-before>  <heading text>
#
# HEADING offsets are the rows and pages a reader passes before that
# heading starts. Headings inside fenced code blocks are ignored.

set -euo pipefail

COLS="${COLS:-80}"
PAGE_ROWS="${PAGE_ROWS:-24}"

# awk must count UTF-8 characters, not bytes, so a multi-byte em dash is one
# column wide. GNU awk in a UTF-8 locale does; a byte-oriented awk inflates
# widths, so warn rather than fail.
AWK="${AWK:-awk}"
if [ "$(printf '\xe2\x80\x94\n' | "$AWK" '{ print length($0) }')" != 1 ]; then
  if command -v gawk >/dev/null 2>&1 &&
     [ "$(printf '\xe2\x80\x94\n' | gawk '{ print length($0) }')" = 1 ]; then
    AWK=gawk
  else
    printf 'doc-metrics: %s counts bytes, not characters; widths may be inflated\n' "$AWK" >&2
  fi
fi

if [ "$#" -gt 0 ]; then
  files=("$@")
elif command -v fd >/dev/null 2>&1; then
  mapfile -t files < <(fd -e md -e mdx -t f \
    -E node_modules -E .git -E zig-pkg -E zig-out -E dist -E .zig-cache . | sort)
elif command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  mapfile -t files < <(git ls-files '*.md' '*.mdx' | sort)
else
  printf 'doc-metrics: pass FILE arguments, or install fd / run inside git\n' >&2
  exit 1
fi

if [ "${#files[@]}" -eq 0 ]; then
  printf 'doc-metrics: no markdown files found\n' >&2
  exit 1
fi

for f in "${files[@]}"; do
  [ -f "$f" ] || { printf 'doc-metrics: not a file: %s\n' "$f" >&2; exit 1; }
  "$AWK" -v COLS="$COLS" -v PAGE_ROWS="$PAGE_ROWS" '
    function width(s,   i, c, n, col) {
      n = length(s); col = 0
      for (i = 1; i <= n; i++) {
        c = substr(s, i, 1)
        if (c == "\t") col += 8 - (col % 8)
        else col++
      }
      return col
    }
    BEGIN { fence = 0; rows = 0; nh = 0 }
    {
      line = $0
      if (line ~ /^[[:space:]]*(```|~~~)/) fence = !fence
      w = width(line)
      r = int((w + COLS - 1) / COLS)
      if (r < 1) r = 1
      if (!fence && line ~ /^#{1,6} /) {
        nh++
        hline[nh] = NR; hrows[nh] = rows; htext[nh] = line
      }
      rows += r
    }
    END {
      printf "FILE\t%s\tlines=%d\trows=%d\tpages=%.2f\tcols=%d\n", FILENAME, NR, rows, rows / PAGE_ROWS, COLS
      for (i = 1; i <= nh; i++)
        printf "HEADING\t%d\t%.2f\t%d\t%s\n", hline[i], hrows[i] / PAGE_ROWS, hrows[i], htext[i]
    }
  ' "$f"
done

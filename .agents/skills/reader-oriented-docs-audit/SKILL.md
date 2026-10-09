---
name: reader-oriented-docs-audit
description:
  Use when auditing, reviewing, or rewriting a repository's documentation
  (READMEs, docs/ topics) from a reader's point of view — supplies 50 reader
  questions, traces read and navigation paths with 80x24 page skip costs, fans
  out read-only subagent audits, and applies concise, drift-resistant writing
  advice. Search terms — docs audit, README review, reader questions, skip cost,
  documentation rewrite, doc drift, duplicated docs.
---

# Reader-oriented docs audit

Audit docs the way a reader walks them: inventory, question traces, fan-out
subagent audits, ranked findings, rewrite, blind verification.

## Files

- `references/questions.md` — 50 reader questions in six groups; each question
  names the home its answer should have.
- `references/audit-process.md` — fan-out protocol, evidence contract, report
  shape, blind verification.
- `references/writing-advice.md` — one-home rule, source-of-truth table,
  concision tactics, rewrite order, review checklist.
- `scripts/doc-metrics.sh` — per-file pages counted as terminal screens: each
  source line occupies at least one 80-column row, longer lines fold, and blank
  lines count as rows; measure, do not estimate.

## Procedure

1. **Inventory and measure.** Run `scripts/doc-metrics.sh` (defaults to the
   repository's markdown; pass paths otherwise). Record per-file pages and
   per-section offsets.
2. **Scope.** Select question groups from `references/questions.md` and adapt
   the wording to the repository under audit. The question list is an audit
   instrument that drives narrative structure — never publish it as an FAQ.
3. **Fan out.** One subagent per question group of five to eight questions,
   following `references/audit-process.md`. Subagents are read-only and never
   spawn children.
4. **Consolidate.** Merge findings, verify every cited line before accepting
   it, then rank by skip pages removed and by drift risk.
5. **Rewrite.** Apply `references/writing-advice.md` in its triage order:
   delete, relocate, merge, rewrite, link, add. Move sections before editing
   prose, because moves remove the most skip cost per edit.
6. **Verify.** Blind-probe every rewritten question with a fresh subagent
   launched with `--disable-skill reader-oriented-docs-audit`. The prober must
   answer from the docs alone and report where the answer was found and how
   much it skipped. A rewrite that fails its probe is reverted or fixed, never
   kept on faith.
7. **Re-measure.** Rerun `scripts/doc-metrics.sh` on changed docs and report
   before and after skip costs.

## Rules

- Every finding carries `file:line` evidence; read the cited lines, never count
  or edit without reading them.
- Triage findings instead of applying them wholesale: content is often in the
  wrong place rather than worthless.
- Docs never restate values encoded in code, config, tests, or generated files.
  See the one-home rule in `references/writing-advice.md`.
- Launcher mechanics (session ids, heredocs, model selection) belong to the
  `subagents-in-pi` skill; keep delegation one level deep.

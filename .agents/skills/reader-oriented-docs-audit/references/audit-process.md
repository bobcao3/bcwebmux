# Audit process

Roles: the orchestrator (this session) owns measurement, dispatch, adjudication,
rewrites, and verification. Subagents are read-only auditors. Launcher
mechanics live in the `subagents-in-pi` skill: quoted heredoc on stdin, a
unique session id per batch, no detaching, no polling — wait for completion
notifications. Delegation stays one level deep; audit subagents never spawn
children.

## Phase 0 — Inventory and measurement

1. List the documents in scope and the entry points a reader uses (root README,
   docs index, component READMEs named by the questions).
2. Measure, do not estimate:

   ```sh
   bash scripts/doc-metrics.sh <files...>
   ```

   The script prints per-file totals and one line per heading with the page
   offset where the heading starts (1 page is one 24-row by 80-column terminal
   screen; each source line takes at least one row, lines longer than 80
   columns fold into additional rows, and blank lines count as rows).
3. Record the doc map in the audit report: file, pages, section offsets.

## Phase 1 — Fan out question batches

- Partition `references/questions.md` into batches of five to eight questions.
  Group by audience, because questions in one group share a traversal: an
  orientation batch, a deploy batch, a security batch, an embed batch, a
  develop batch, a behavior batch. Two batches of five beat one batch of ten;
  larger batches lose per-question rigor.
- Launch one subagent per batch. The prompt is self-contained: question list,
  document paths, method, evidence contract, and the metrics script path. Disable
  this skill in audit children so they cannot confuse phases with their own
  instructions, and so a successful launch proves the skill was not loaded:

  ```sh
  subagent --disable-skill reader-oriented-docs-audit -s docs-audit-<batch> <<'TASK'
  You are auditing documentation in <repo> from a reader's perspective. Read-only:
  do not modify any file. Do not run commands that write.

  Entry points for readers: <root README, docs index, component README paths>.

  Question batch:
  1. <question>
  ...
  N. <question>

  Method: for each question, enter through one of the entry points above and
  walk the docs top-down the way a reader would. Measure section sizes with
  `bash <skill-dir>/scripts/doc-metrics.sh <file>` (1 page is one 24-row by
  80-column terminal screen; each source line takes at least one row, lines
  longer than 80 columns fold into additional rows, and blank lines count as
  rows). Record, per question:
  - status: answered | partial | missing
  - path: entry point, then each section visited with its page offset
  - first answer: file:line, and the section it starts in
  - complete answer: file:line
  - skip cost: pages of on-path content that do not serve the question before
    the first answer; name each skipped section
  - duplication: passages this answer repeats from elsewhere, with both sites
  - drift risk: each stated fact that already lives in code, config, tests, or
    generated files; name the authoritative file:line
  - recommendation: delete | relocate | merge | rewrite | link | add

  Rules: cite file:line for every claim; quote at most one short line per
  finding; when the answer is absent, say missing and show the closest passage;
  never invent line numbers or page counts. End with a major-findings list.
  TASK
  ```

- If a batch backgrounds, wait for its completion notification. Resume a batch
  with the same session id only to answer follow-up questions about that same
  batch.

## Evidence contract

Discard any claim without a `file:line` citation. A question's row is complete
only when it has: status, path with page offsets, first-answer location, skip
cost with named sections, duplication sites, drift risks with authoritative
files, and a recommendation. Page counts come from the script, never from
impression.

## Phase 2 — Consolidate and report

Merge the batches into one question table. Before accepting a finding, read the
cited lines. Resolve conflicts between subagents by re-reading, not by vote.
Rank findings by skip pages removed times reader priority, and separately by
drift risk: a fact duplicated from code will rot, a misplaced fact will merely
annoy.

Report shape:

```markdown
# Docs audit — <repo or doc set>

## Inventory
<file, pages, section offsets table>

## Question traces
<one table or block per question: path, first answer, skip cost, gaps>

## Findings, ranked
1. <finding> — evidence <file:line>, skip removed <pages>, fix <triage verb>
...

## Rewrite plan
<ordered moves and edits; cite the questions each change serves>

## Verification log
<blind probe results: question, answer found at, skip after, pass/fail>
```

## Phase 3 — Rewrite

Apply `references/writing-advice.md` in its triage order: delete, relocate,
merge, rewrite, link, add. Section moves first, prose edits second. Keep each
change attributable to a question or finding.

## Phase 4 — Blind verification

A rewrite passes only if a fresh reader can answer the question without help.
Launch one prober per rewritten question (or small group), fresh session id,
with this skill disabled, and never tell the prober where the answer lives:

```sh
subagent --disable-skill reader-oriented-docs-audit -s docs-audit-verify-<q> <<'TASK'
Answer this question using only the documentation in <repo>:
<question>

Start from <entry points>. Read-only: do not modify files.

Report: your answer in your own words; every file and section you used with
file:line; where you first found the answer; and the number of 80x24 pages you
read or skipped before finding it.
TASK
```

Pass criteria: correct answer, found in the intended doc and section, skip cost
at or below the agreed budget. On failure, fix the doc and re-probe with a fresh
session id. Never keep a rewrite a blind probe cannot use.

## Failure handling

- Subagent cannot answer within budget: record missing or partial; do not
  accept invented line numbers or page estimates.
- Two subagents disagree: re-read both cited passages and record the
  contradiction as a finding with both citations.
- A batch stalls or errors: relaunch the same batch with the same session id;
  narrow the question set if it stalls twice.
- Scope creep: an audit that turns into a rewrite mid-flight loses its
  baseline; finish measurement first.

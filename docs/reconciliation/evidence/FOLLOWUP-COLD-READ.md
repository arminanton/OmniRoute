# Follow-up cold read

## Verdict: PASS

Current-byte verification completed at `2026-09-10T11:40:20.249087+00:00` after the owner follow-up and the final non-audit Markdown whitespace cleanup.

This is a documentation, report, override, provenance, and safety-consistency result. It is **not** implementation acceptance, provider-capacity proof, live-call approval, or release approval. The project remains release/live **NO-GO**.

## Scope and method

I reviewed the current project reader docs, worker reports, decision/owner overrides, wide-lane evidence index, extension publication provenance, ignore rules, and publishing/status statements. I did **not** treat `audit-source/RECONCILIATION-PLAN.md` or the original audit checklist as current normative scope where the owner override supersedes them.

No web search, provider request, login, discovery, egress check, extension execution, or live concurrency test was performed. Ignored third-party extension copies were checked only by file presence, byte count, SHA-256, Git tracking, and ignore status. The only project file written by this review is this report.

The 38-file, non-self-referential review-set digest is `4ba833be10d4e15b1bc97630bb1653500dae9209157cea2de94c5f28babdad0a`. Recipe: SHA-256 of lexically sorted UTF-8 records `path\0sha256(file-bytes)\n`. Root publication manifests are excluded from this review digest because they are intentionally regenerated after this report.

## Required checks

| Requirement | Result | Current-byte finding |
|---|---|---|
| 1. Preserve the more-than-six history and its evidence boundaries | **PASS** | Current docs separate: native stock layouts 1/2/3/4/6; direct seven-seat aggregate host execution plus the committed 12-seat real-`ChatService` aggregate/driver; and the exact owner-attested 30/32 episode, whose per-request/provider-wire trace remains missing and not disproven. The 7/12 artifacts are not presented as per-seat provider receipts or provider capacity. |
| 2. Reuse normal chat per lane with unique state | **PASS** | Each lane is one ordinary single chat using the hardened normal request, private stream accumulator/parser, and provider-exposed reasoning splitter. The design requires unique run/lane/turn/attempt, conversation, message/parent, model, tool, cancel/timeout, terminal, history, and continuation state. No batch endpoint, central stream mux, or reduced parallel parser is inferred. |
| 3. Do not hard-cap capacity at six, disprove 30, or authorize live concurrency | **PASS** | Six is only the recovered stock-native layout boundary. The search-result `30` correction is kept separate from the real local shim ceiling and from the missing 30/32 episode. No current document sets six as provider capacity or says the historical episode was disproven. Multi-lane remains default-OFF; current live policy prohibits parallel provider calls. |
| 4. Keep UC TTS/STT deferred and OFF | **PASS** | Decisions, roadmap, validation, operations, and detailed reports now agree: UC TTS/STT are provenance-only, outside core and live validation, and policy-disabled before transport. Acceptance is negative zero-transport testing. Reopening requires a new owner decision and credit budget. MaxAI STT remains a separate in-scope surface. |
| 5. Exclude extension source copies while retaining report/provenance | **PASS** | `.gitignore:5` excludes `private-evidence/`; `git ls-files` returns no ignored extension copy. Eight local beautified copies match `RELOCATION.json` by name, size, and SHA-256. The report and publication-safe `README.md`, `PROVENANCE.tsv`, `INVENTORY.json`, `RELOCATION.json`, and `SHA256SUMS` remain outside the ignored source directory and are available for the planned commit. |
| 6. Keep links and safety claims consistent | **PASS** | All 30 reader-facing repo-local references in README/docs resolve. The extension index checksum passes from `evidence-index/extension-analysis/`. Current status and publishing docs agree that owner approval for a private remote exists but no remote/push exists yet. No current evidence statement grants provider capacity, hidden chain-of-thought access, live parallelism, UC speech use, or release readiness. |

## Evidence-boundary spot checks

### MaxAI history

- `README.md:30-35`, `STATUS.md:18-24`, and `docs/00-executive-guide.md:23` state the current top-level result.
- `docs/03-maxai-parallel-lanes.md:9-15,29-43` gives the three-way evidence split and the 7/12 limitations.
- `docs/06-implementation-roadmap.md:271-282`, `docs/07-validation-matrix.md:88-103`, and `docs/09-owner-scope-update.md:7-21` preserve the same release and validation boundary.
- `workers/gates-and-pending.md:324-331` and `workers/residential-operations.md:44,50` now include the recovered 7/12 host evidence without turning it into capacity authorization.
- `workers/maxai-legacy-lane-recovery.md:93-99,135-146,371-388` is explicit that the seven-seat trace is direct host execution evidence, the 12-seat driver uses real `ChatService`, individual seat receipts/reasoning did not survive, and the exact 30/32 episode is still missing.
- Cross-source banners in the older extension/parallel reports prevent their pre-recovery body boundaries from overruling the later recovery. The earlier project cold read is now retained as `workers/PROJECT-COLD-READ-pre-owner-scope.md` with an explicit supersession notice.

### Per-lane protocol

- `plans/OWNER-SCOPE-OVERRIDES.json:20-22`, `docs/09-owner-scope-update.md:23-37`, and `docs/03-maxai-parallel-lanes.md:57-75,98-124` state the per-lane contract.
- `docs/06-implementation-roadmap.md:272-278` and `docs/07-validation-matrix.md:92-103` carry it into implementation and acceptance.
- `workers/maxai-multilane-protocol-design.md` keeps request-replay and native-thread modes explicit, never mixes them within a lane, and defines private parser, tool, cancellation, recovery, and continuation state.

### UC speech

- `DECISIONS.md:5`, `plans/OWNER-SCOPE-OVERRIDES.json:4-11,25-27`, and `docs/09-owner-scope-update.md:39-48` are the authority.
- Core operations and acceptance agree at `docs/05-residential-operations.md:125`, `docs/06-implementation-roadmap.md:141-150,280`, `docs/07-validation-matrix.md:28-40,101`, and `docs/08-decisions-and-defaults.md:13`.
- The former positive action in the detailed media report is corrected: `workers/input-upload-media.md:272` now requires no UC speech port/live test and only policy-disabled, zero-credit closure.

### Extension publication boundary

- `.gitignore:5` covers all `private-evidence/` content.
- `evidence-index/extension-analysis/RELOCATION.json` lists exactly eight beautified files; all eight current local files matched its byte counts and hashes.
- `INVENTORY.json` and `PROVENANCE.tsv` now name the ignored `private-evidence/maxai-extension-archaeology-analysis/` location.
- Running `sha256sum -c SHA256SUMS` from `evidence-index/extension-analysis/` returned four `OK` results.
- No `.pretty.js`, `.xpi`, `.bin`, or `private-evidence/` path is tracked by Git. The report and publication provenance are present and unignored.

## Exact issues

None in the requested current documentation/report/override scope.

## Post-report mechanical work

Regenerate `evidence-index/SECRET-SCAN.json`, `PROJECT-MANIFEST.json`, and root `SHA256SUMS` after adding this report and staging the intended review-safe set. Then verify the exact Git index contains no ignored/private source copy before the approved private push. This expected post-report step does not authorize a provider call or change the PASS above.

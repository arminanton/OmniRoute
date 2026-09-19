# Residential and low-risk operations policy for MaxAI and UC Persona

**Status:** proposed mandatory operating policy
**Scope:** authenticated MaxAI and UC Persona login, discovery, chat, tools, uploads, media, refresh, health checks, and validation
**Out of scope:** UC Direct. It is paid/metered and remains disabled and ineligible for routing.
**Evidence cut:** 2026-09-10. No provider call was made to prepare this policy.
The synthesis originally verified source-copy v2. The current project carries v5, whose later changes correct G1 ancestry/provenance and final audit bookkeeping only; the operations evidence cited here is unchanged.

## 1. Decision

Operate MaxAI and UC Persona as manual, account-sensitive services. Use one stable, operator-authorized residential path. Admit at most one provider operation at a time per account, with only one upstream transaction in flight, no parallel validation waves, and no silent queue growth. Every live run needs a named human, a genuine human-authored task, an exact request budget, and an explicit stop plan.

This policy does **not** authorize deceptive bot-detection evasion. It forbids synthetic “human-looking” prompt banks, prompt obfuscation, browser/fingerprint spoofing, rotating identities, CAPTCHA or challenge bypass, and use that violates provider terms. Residential egress is a stable routing and account-safety policy, not a way to evade enforcement. Use only an owned or expressly authorized residential connection. If the provider does not permit the client or access method, do not call it.

The provider code must remain topology-agnostic. Local deployment policy owns the residential route and kill switch. UC Persona is manual-only and never an automatic fallback. UC Direct remains off.

## 2. Evidence boundaries and resolved facts

The labels below keep protocol facts, historical operations, source findings, and the present deployment separate.
Paths beginning `audit-source/` are relative to this project. Paths beginning `workers/` are relative to the private evidence root named in `EVIDENCE-SYNTHESIS-SPEC.md`. Hermes message IDs resolve in `workers/hermes-lineage/restricted-verbatim/messages.jsonl.gz`; no private prompt text is reproduced here.

| ID | Evidence and conclusion | Strength / boundary | Exact evidence |
|---|---|---|---|
| E1 | A direct owner message warns to be extremely careful about MaxAI bot detection/bans and asks for natural prompts plus residential egress. A secondary historical memory reports a prior 24-hour ban and adds `30s+` pacing, one account per residential IP, and concurrency 1. | **High for the direct owner caution; moderate for the reported duration and numeric secondary-memory rule; medium for causation.** No controlled evidence proves that any single signal caused the reported ban. | Hermes session `20260823_025225_cd8f7f`, user message `517721`, content SHA-256 `a458c0333cb9e319c3607617a9941648d6c426e0078c075486714ab8dde02626`; `workers/cmx-lineage/restricted-verbatim/selected-sessions.messages.jsonl:106541`, tool message `188643`, content hash `80ab61a6aae97ccdb7c686e1324ca836d8a2f013392ab041e99507816c1c6ad9`, session `20260823_102342_73fb4d`; `workers/copilot-lineage/report-redacted/state-provider-memory-item-index.redacted.jsonl`, record `memory-1382`, source `MEMORY.md:3075`, normalized SHA-256 `fb0d48e6ccfbbddd35211121a4ce402dbf1dbcc9e866c81906c365f4f49510cb`. |
| E2 | Primary conversation evidence asks for natural live MaxAI tests `15–30s` apart and instructs the operator to seek human approval before the single front-door check; it is not evidence that approval was obtained. A later joint UC/MaxAI memory also records natural prompts and `15–30s` pacing for UC, while the earlier MaxAI memory used `30s+`. | **High for the primary historical instruction; moderate for the secondary-memory restatement; not a provider rate limit.** These values are safety pacing, not timeouts or published provider allowances. | Hermes session `20260824_061116_f121b7`, user message `529201`; `workers/copilot-lineage/restricted-verbatim/archived-evidence/secondary-memory/timeout-phenomena-records.jsonl`, `memory-1472`, `MEMORY.md:3255`, normalized SHA-256 `25f221c1773411b14fe8ff900e90607f1c9e6876d1c6ed78b161c359afe3d699`; `workers/copilot-lineage/copilot-lineage-report.md:132-140`. A four-capability UC probe described `~20–30s` spacing in Hermes cron session `cron_91bd79ad2437_20260825_132054`, tool message `546309`. |
| E3 | Historical probes used programmatically composed natural-style prompts, and a prior assistant proposed a varied prompt bank plus “human-ish” randomized gaps. Neither proves human authorship. Both patterns are now rejected: genuine prompts are required; jitter may only smooth load. | **High, source/artifact proof of historical automation; rejected by this policy.** | Hermes session `20260824_061116_f121b7`, assistant message `525216`; `workers/maxai-git/restricted-evidence/frozen-validation/maxai-attachment-validation-20260827/live-model-400k-matrix.mjs:14-15,30-67,191`; `workers/maxai-git/evidence/review-overflow-parallel/untracked/scripts/probes/maxai-parallel-agent-probe.mjs:58-89`; current synthesis specification. |
| E4 | The local operating design routed traffic through an owned residential exit using a Tailscale/TUN/network-namespace layer. The present container starts through an app-egress wrapper, has a Tailscale child, and has an `omni-ts-egress` sidecar. The read-only runtime audit made no egress call, so it did not freshly attest the current public exit. This is deployment topology, not a UC protocol requirement. | **High for the historical/current local topology; not current-IP or universal provider proof.** | `workers/runtime/BROKEN-UC-PRELIMINARY.md`, “Live containers and processes”; `audit-source/CAPABILITY-MATRIX.md`, row `uc.proxy_egress`; `memory-1472` above. Do not publish the retained raw exit IP. |
| E5 | UC uses ordinary fetch/WebSocket paths. No UC-specific residential-IP class or TLS fingerprint requirement was proven. A required proxy lookup must nevertheless fail closed under local policy. | **High, source review.** | `audit-source/CAPABILITY-MATRIX.md`, row `uc.proxy_egress` and controls `UC-EGRESS-1/2`; `audit-source/UC-SOURCE-REVIEW.md:186-195,276`. |
| E6 | Upstream MaxAI defines a Windows Firefox-150 profile only behind `ENABLE_TLS_FINGERPRINT`; proxied use also needs allowlisting. `801fb15757a36f22c4c751211b0561097cbe1b3b` tried to require Firefox-150/wreq, but relay, ineligible-request, environment, `NO_PROXY`, and nested-context paths can bypass or change the claimed route. | **High, static source proof. Presence of code is not provider authorization and does not prove a universal requirement.** | `audit-source/CAPABILITY-MATRIX.md`, row `maxai.proxy_egress`; `audit-source/MAXAI-SOURCE-REVIEW.md:279-301`; `801fb15757a36f22c4c751211b0561097cbe1b3b:open-sse/services/maxaiTransport.ts:23-55`, `801fb15757a36f22c4c751211b0561097cbe1b3b:open-sse/utils/wreqProxyCompatibility.ts:3-22`, `801fb15757a36f22c4c751211b0561097cbe1b3b:open-sse/utils/proxyFetch.ts:311-318,576-723,747-832,972-1034,1080-1146`; `801fb15757a36f22c4c751211b0561097cbe1b3b:tests/unit/maxai-image-route-transport.test.ts:93-250`. |
| E7 | The first-final image `b00b0741e5e48b4e5568cedabe287aa95912a55fb6d5b5d37b0c8c798818b0e0` was rejected because its proof did not exclude a possible environment-proxy escape and its direct `ip.guide` check was not bound to the selected MaxAI connection. The accepted final2 image `bf6570f7259ca868e6a892244db7041684b4d5c21df791df8ada90095935fe99` bounded its claim to a fixed same-container environment with all six proxy variables empty, `proxy_enabled=0`, and a Tailscale kill switch. | **High, frozen review evidence; exact-run only.** | `workers/maxai-git/IMAGE-RECOVERY.md:95-104`; `workers/maxai-git/restricted-evidence/frozen-validation/maxai-overflow-parallel-final2-review-bundle/reviews/parallel-review.md:35-41`; same bundle `reviews/closure-review-final-2.md:13-30,42-48`, `evidence/live-preflight-final.txt`, `evidence/final-image-fail-closed.txt`, and `reviews/final-acceptance-review.md:47-64`. |
| E8 | A proxy fast-fail can return 503 while a signed upload, generation, STT, or chat continues. It can spend quota, retain data, and leak a concurrency slot after the caller sees failure. | **High, static source proof; blocking.** | `audit-source/MAXAI-SOURCE-REVIEW.md:287-293`; `audit-source/MAXAI-SOURCE-REVIEW.json`, finding `TRN-02`; `801fb15757a36f22c4c751211b0561097cbe1b3b:open-sse/utils/proxyFetch.ts:576-723`. |
| E9 | Current upstream commit `838fc00f254a1f74527b7be012d8b5de9b4b5cd7` separates queue admission (`maxWaitMs`) from post-dispatch execution (`executionMaxWaitMs`, default 600,000 ms). The retained historical MaxAI `300,000 ms` value is only a queue/admission input and is a no-op in the provider-default sliding limiter unless an override applies. The shared default `maxQueueDepth=0` means there is no effective queue-depth cap. None of these values is pacing. | **High, source plus deterministic tests.** | `838fc00f254a1f74527b7be012d8b5de9b4b5cd7:src/lib/resilience/settings.ts`; `838fc00f254a1f74527b7be012d8b5de9b4b5cd7:open-sse/services/rateLimitManager.ts`; `838fc00f254a1f74527b7be012d8b5de9b4b5cd7:tests/unit/rate-limit-execution-timeout-message-4165.test.ts::execution outliving the queue-wait budget completes (opencode-go 504 regression)`; `838fc00f254a1f74527b7be012d8b5de9b4b5cd7:tests/unit/ratelimit-admission-control-6593.test.ts`; `audit-source/CAPABILITY-MATRIX.md`, rows `uc.queue_execution_timeout` and `maxai.queue_execution_timeout`; `audit-source/MAXAI-SOURCE-REVIEW.md:366-370`. |
| E10 | The optional final2 worker queue is one active plus eight queued, but it is unweighted, has no tenant fairness, excludes PDF workers, retains full queued buffers, and can be poisoned by termination failure. It is not provider request admission. | **High, frozen source review.** | `audit-source/MAXAI-SOURCE-REVIEW.md:206-213,354-358`; `workers/maxai-git/evidence/image-patch-snapshots/validated-overflow-parallel-final2-bf65/image/open-sse/executors/maxai/workerQueue.ts:25-45,61-70,97-105`. |
| E11 | Only one two-lane MaxAI tool run was live: six chat calls, three per lane, with first starts about 1.7 ms apart and `30–40s` follow-ups; the retained run reported one active MaxAI connection. Modes 3/4/6/all, continuations, positive reasoning separation, and failures were offline. The harness design can distribute lanes across connections, and one run does not establish a provider or same-account concurrency contract. Its largest derived test budget was 60 requests. | **High for the exact run; no provider concurrency contract.** | `workers/maxai-git/IMAGE-RECOVERY.md:77-93`; `audit-source/MAXAI-SOURCE-REVIEW.md:217,366-370`; `workers/maxai-git/restricted-evidence/frozen-validation/maxai-overflow-parallel-final2-review-bundle/evidence/live-evidence/parallel-wave2-summary.json`; same bundle `reviews/final-acceptance-review.md:35-45,47-64`; `workers/maxai-git/evidence/review-overflow-parallel/untracked/docs/providers/maxai-parallel-agents.md:39,47,68,77,110`; `workers/maxai-git/evidence/review-overflow-parallel/untracked/tests/unit/maxai-live-probe-hardening.test.ts:78-83`. |
| E12 | The runtime audit’s retained call records contain 43 MaxAI rows: 30 model-test 504s, ten DeepSeek 502s, one 401, one 499, and one 200. They contain 20 UC Persona rows: fourteen local 15-second 504 expirations, six aborts, and no 2xx. These rows span predecessor and current containers. The MaxAI model tests show an approximately two-hour repeating pattern, consistent with an unattended caller, but the rows alone do not name the scheduler. | **High for counts/status/times; medium for background-caller attribution. Cross-image aggregate only.** Do not call these quota events or assign every row to the current image. | `workers/runtime/recent-provider-call-aggregate.json`; `workers/runtime/recent-provider-call-summaries.redacted.jsonl`; `workers/runtime/BROKEN-UC-PRELIMINARY.md`, “Observed provider evidence.” |
| E13 | HTTP ports were observed not listening while logs from `CredentialHealth` and `ProviderLimitsSync` were still present. This proves that provider-adjacent background activity can remain observable without front-door availability. | **High for the underlying historical port/process/log outputs; the assistant interpretation is corroborating. It does not prove that every job consumed quota in that moment.** | Hermes session `20260822_213133_06b022`, tool messages `511270`, `511272`, `511276`, and assistant messages `511273`, `511277`. |
| E14 | Secondary historical records say one UC Persona free-tier account exhausted its daily message quota after heavy multi-round testing. An unparsed top-level `message_limit_exceeded` frame made calls look like 25–120 second hangs. The records say that after stream and non-stream parsing were fixed, the same condition returned a typed 429 in about 0.8 seconds. | **Moderate for the detailed chronology because it is secondary memory; not present deployment or current-tree proof.** | `workers/copilot-lineage/restricted-verbatim/archived-evidence/secondary-memory/timeout-phenomena-records.jsonl`, `memory-0392` (`MEMORY.md:1038`, normalized SHA-256 `cb8879e833f1af33eb8f6e8e4378b4d1c2f4ab23e3b0160309ca9d0ce9a75e28`) and `memory-0395` (`MEMORY.md:1044`, normalized SHA-256 `fd7dcf9806c8447c28c340e424888768646d59fe68835ec17ebcefd15cdb7423`); `workers/copilot-lineage/copilot-lineage-report.md:132-140`. The records attribute the fix to historical commits and a 9/9 regression run, but this policy does not cite those unlocated claims as repository or current-tree test proof. |
| E15 | UC source still needs strict finite reset parsing and a bounded cooldown. MaxAI has no captured remaining-quota API. MaxAI HTTP-200 paywall/quota/error terminal frames can become empty success, which can trigger more calls if treated as retryable. | **High, static source review.** | `audit-source/UC-SOURCE-REVIEW.md:217-226`; `audit-source/MAXAI-SOURCE-REVIEW.md:303-309`; `audit-source/CAPABILITY-MATRIX.md`, rows `uc.quotas_retries_headers` and `maxai.quotas_retries_headers`. |
| E16 | UC's heuristic “auto-cure” can issue a second generation; combo fallback can start another provider after client abort; a MaxAI narration-miss retry can also spend one extra request. | **High, source review.** | `audit-source/UC-SOURCE-REVIEW.md:64,186-193,217-225`; `audit-source/MAXAI-SOURCE-REVIEW.md:360-377`. |
| E17 | The currently running image has no UC implementation: 0 of 20 selected UC files and no compiled UC markers. A stale active connection record does not prove readiness. | **High, present live-deployment snapshot as of the evidence cut.** | `workers/runtime/BROKEN-UC-PRELIMINARY.md`, “Deployed-file hash comparison,” “Observed provider evidence,” and hypotheses H1/H3. |
| E18 | The accepted final2 validation used seven intentional chat calls (one context plus six across two lanes), yet its provider log summary contained eight MaxAI rows, all HTTP 200, because of one extra `connection-test`. Script-local chat budgets therefore did not cover every upstream transaction. | **High, historical live artifact.** | `workers/maxai-git/restricted-evidence/frozen-validation/maxai-overflow-parallel-final2-review-bundle/evidence/live-evidence/context-spill-summary.json`; same directory `parallel-wave2-summary.json` and `live-verification-summary.json`; same bundle `reviews/final-acceptance-review.md:35-66`. |
| E19 | A historical `418 ja3_tls_code` was initially attributed to TLS/bot blocking, but expiry evidence plus a later refresh/models success corrected that incident to an expired token. A 418 is therefore a stop signal, not proof of a ban or fingerprint failure. | **High for raw results plus the corrected historical interpretation.** | `workers/cmx-lineage/restricted-verbatim/selected-sessions.messages.jsonl`, root session `20260820_150715_bf2212`: tool messages `197427`, `197465`, `197469` at JSONL lines `88446`, `88484`, `88488` (turns `6622`, `6660`, `6664`; content hashes `56e6409feca56e95eab02a95dca5561047a3cf019527966c523245b2aac89c84`, `f8273cbf8a678f800ace415a6932d0a05275ab6a8244dbca29fc77312d7244b0`, `3af1e8df6b03fba1a5a34914e27f2873013b412bdb7216e516751f2dad8abdcd`) and explanatory messages `197434`, `197470`, `197474` at lines `88453`, `88489`, `88493` (turns `6629`, `6665`, `6669`). |
| E20 | A historical UC 4,000,000-character attempt returned a pre-generation 429 with reset metadata. It proves quota exhaustion at that moment, not a prompt-size ceiling. | **High, revision-bound historical result.** | `workers/runtime/historical-validated-image-evidence.redacted.json`, fields under `uc_persona_validation.current_4m_attempt_*`; `workers/uc-git/restricted-evidence/frozen-validation-20260827/verification-manifest.json:145-149`; image `08ab818d328b324e2dbf943b93c9c8e7f5d3266ec408c52769f1ceb2305cb49f`. |
| E21 | The recovered stock native client exposes layouts 1/2/3/4/6; each panel makes an ordinary request, and the examined bundle's search-result 30 is not a native panel limit. Separately, later legacy archaeology recovered seven-seat direct aggregate host evidence, a committed 12-seat real-`ChatService` aggregate harness, and a configurable host council ceiling 30. The exact owner-attested 30/32 per-provider request trace remains missing—not disproven. | **High for native source and 7/12 aggregate host evidence; owner-attested for exact 30/32. None is a provider-capacity authorization.** | `workers/maxai-extension-archaeology.md`; `workers/maxai-legacy-lane-recovery.md`; `evidence-index/MAXAI-WIDE-LANE-EVIDENCE.json`. |

### Proven / incomplete / rejected / still to implement

- **Current upstream — proven:** `838fc00f254a1f74527b7be012d8b5de9b4b5cd7` separates queue admission from execution expiry. Upstream MaxAI has a conditional Firefox-150 profile; it does not prove that the profile is universally required or authorized. [E6, E9]
- **Recovered local implementation — incomplete:** `801fb15757a36f22c4c751211b0561097cbe1b3b` adds selected-connection/wreq intent, but route bypass, precedence, and non-aborting fast-fail remain. Final2's one-active/eight-queued CPU queue is not sufficient admission. [E6, E8, E10]
- **Historical test/live evidence — proven only at its boundary:** the owner recorded a prior ban and conservative pacing; final2 proved one two-lane run; separate legacy artifacts prove seven-seat and twelve-seat aggregate host execution. The exact 30/32 per-provider request set and safe concurrency allowance are still not proven. [E1-E3, E11, E21]
- **Present deployment — proven snapshot:** Tailscale/app-egress is running, but the deployed image contains no UC implementation. Recent MaxAI/UC error counts are operational failures, not quota proof. [E4, E12, E17]
- **Rejected by this policy:** deceptive fingerprinting, automated prompt “humanization,” route/account rotation after a block, automatic quota-gated generation, parallel lanes, unbounded queues, silent retry/fallback, and UC Direct.
- **Still to implement before live use:** provider-permission/client gate; exact selected-route attestation and kill switch; linked abort; unified foreground/background admission; serial pacing and durable budgets; captured terminal/quota parsing; immutable build provenance; redacted audit ledger; and local operations controls L0–L7 below.

### Important non-equivalences

- `15–30s` pacing, the old `15,000 ms` queue value, a `25–120s` UC pseudo-timeout, the MaxAI `300,000 ms` queue floor, and the `600,000 ms` execution backstop describe different controls. Never substitute one for another. [E2, E9, E14]
- A residential route is an operator deployment choice. It is not proof that a provider permits an unofficial endpoint or client. [E4-E7]
- A successful two-lane experiment is not a concurrency allowance. A one-active/eight-queued CPU queue is not an account request limit. [E10-E11]
- A 502/504 or empty 200 is not evidence of quota exhaustion. [E12, E15]

## 3. Mandatory controls

### 3.1 Authorization and scope

1. **Terms gate.** Before first use and after any material terms or endpoint change, a human records that the account, client, endpoint, content, and automation are allowed. If this is unknown, the provider is disabled.
2. **Provider gate.** UC Persona is explicit/manual-only. It must never be an automatic fallback. UC Direct is disabled and cannot be selected by key prefix, alias, combo, or fallback.
3. **Build gate.** Pin an immutable image digest, source commit, and configuration hash. The mutable `omniroute:base` tag is not evidence. The present snapshot fails this gate for UC because it contains no UC code. [E17]
4. **Purpose gate.** A run declares one purpose and exact capabilities. Approval for discovery does not approve chat, upload, image, audio, login, refresh, tools, continuation, or concurrency.
5. **Human presence.** A named human starts the run, reviews the exact transaction plan, remains available for any challenge or provider notice, and closes the run. No unattended provider-generating cron is allowed. A CLI `--acknowledge-*` flag is only a software interlock; it is not evidence of named human approval. Historical parallel flags are in `workers/maxai-git/evidence/review-overflow-parallel/untracked/scripts/probes/maxai-parallel-agent-probe.mjs:23-24,136-177` and `workers/maxai-git/evidence/review-overflow-parallel/untracked/tests/unit/maxai-parallel-agent-probe.test.ts:264-303`.

### 3.2 Genuine prompts; no behavioral disguise

1. A human must write or select the actual task because they genuinely need its answer. The human sees the exact prompt and attachments before dispatch.
2. Do not rewrite a prompt merely to make automation appear human. Do not use prompt banks, synonyms, padding, typo insertion, style randomization, or semantic camouflage. The rejected historical “human-shaped” prompt-bank proposal is not an allowed control. [E3]
3. Do not send synthetic assertions such as ping/test/exact-output probes to live providers. Put deterministic assertions against mocks or recorded fixtures. A live smoke test uses one ordinary, useful task and validates only coarse success metadata.
4. Store only an approval record and content hash by default. Do not put private prompt bodies, tool results, attachments, credentials, cookies, tokens, email codes, or raw egress IPs in operational logs.
5. Tool prompts must use the audited nonce/name/schema contract. Rejected or ambiguous tool markup stays text. Disable any heuristic second generation used to “fix” a refusal or narration miss unless a separate human explicitly approves and budgets it. [E16]

### 3.3 Stable residential egress, fail closed

1. Use one stable, owned or explicitly authorized residential exit per account. During MaxAI validation, bind only one MaxAI account to that exit. Do not rotate exits, borrow third-party identities, or change routes to escape a block. [E1]
2. Keep the provider executor egress-agnostic. Enforce routing in the local wrapper/network namespace/Tailscale layer. Do not encode a private residential identity or Tailscale topology in public provider code or docs. [E4-E5]
3. Before taking the account lease, attest egress from the **same network namespace and same selected connection/connector** that will issue the request. A generic host check or a direct container `ip` check is insufficient. Use an operator-controlled canary through the same route. Record a route-policy ID, ASN/class result, and a salted IP hash, not the IP. [E7]
4. For browser/capture traffic that can use UDP, verify both TCP and UDP use the same authorized exit. For HTTP/WebSocket provider calls, verify the selected TCP route and policy rules. A mismatch is a hard stop.
5. Pin route precedence. Conflicting ambient `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, nested provider proxies, relay branches, and implicit direct fallback must be rejected before dispatch. A missing or failed required proxy lookup is different from “direct is intentionally selected.” Neither may silently inherit another route. [E5-E7]
6. A Tailscale/exit-node health badge is insufficient. Exercise the kill switch in a no-provider-call test: remove or invalidate the route and prove the provider connector cannot open a socket.
7. Make route selection blocking for non-idempotent work. If a reachability decision races a request, the same linked `AbortSignal` must cancel the real request before 503 is returned. Prove no upload, generation, or chat continues after fast-fail. [E8]
8. Re-attest after restart, network change, Tailscale rekey/failover, account switch, proxy/config change, or process migration. Any change invalidates the approval envelope.

### 3.4 Firefox-150/wreq boundary

Historical code and operator notes tied MaxAI to a Windows Firefox-150/wreq profile. The later source audit found that upstream enables the profile conditionally, did not establish it as a universal provider requirement, and found bypasses in the stricter local implementation. [E6]

There is a recorded recommendation conflict: `audit-source/CAPABILITY-MATRIX.md`, control `MX-EGRESS-2`, proposed a wreq release default, while `audit-source/MAXAI-SOURCE-REVIEW.json`, optional item `OP-01`, says universal Firefox-150 is not established and is policy-gated. **Evidence strength: high for the conflict; normative resolution here.** This policy resolves it under the current compliance constraint: transport imitation is not a ban-evasion control, and lack of authorization blocks the call.

Therefore:

1. Do **not** use Firefox-150, wreq, Camoufox, user-agent manipulation, or any other fingerprint control to impersonate a person or defeat bot detection.
2. If MaxAI supplies or expressly permits a client profile for protocol compatibility, record that authorization and test its route integrity offline. Use the profile only within that permission. Otherwise disable the feature.
3. If the deployed MaxAI implementation requires a spoofed profile to function and no provider authorization exists, fail closed and leave MaxAI disabled. Do not fall back to ordinary fetch, a relay, or another identity.
4. UC Persona has no evidenced TLS-profile requirement. Do not add one. [E5]

### 3.5 Admission, concurrency, queueing, and pacing

The following are **local safety ceilings**, not claims about provider capacity. An **operation** is one human-approved action and its predeclared protocol graph. A **transaction** is each upstream request/connection inside that graph; every transaction counts against budget.

1. **Account concurrency:** one active operation per account and only one upstream transaction in flight. Transactions include auth/refresh, model/config lookup, signed-URL creation, upload, generation, polling, continuation, retry, and tool-retry legs.
2. **Validation concurrency:** one active transaction total across the shared residential exit. MaxAI parallel layouts 2/3/4/6/all remain disabled. UC gets no provider-specific parallel feature. [E11]
3. **Queue:** manual validation has queue depth zero: acquire the lease immediately or reject. Routine interactive service may hold at most one pending request per account, with a visible expiry and cancellation. Reject further requests with a typed local overload result. Do not use final2's one-active/eight-queued worker queue as request admission. [E10]
4. **Pacing:** wait at least **30 seconds from completion of one user-visible operation to dispatch of the next** on the same account or shared exit. Also apply the floor between separate generations, retries, continuations, health checks, discoveries, or refreshes inside a larger run. This selects the conservative edge of the recorded UC `15–30s` range and satisfies the earlier MaxAI `30s+` rule. [E1-E2]
5. **Protocol-coupled exception:** do not insert the 30-second delay between short-lived, mandatory legs of the same operation, such as credential mint→WebSocket connect or signed-URL creation→upload. Execute only the declared minimum legs, serially and promptly. Count every leg. The exception cannot cover a second generation, retry, continuation, polling loop, health check, or background call.
6. **Jitter:** an optional additional `0–5s` may be used only to prevent synchronized local jobs. It must not alter prompt content, imitate human timing, or reduce the 30-second floor. Record the chosen delay. Provider `Retry-After` or a valid UC `next_reset` always wins when longer.
7. **Timeout separation:** keep queue admission and execution timers separate as in `838fc00f254a1f74527b7be012d8b5de9b4b5cd7`. An execution timeout never authorizes another attempt. The MaxAI 300-second `maxWaitMs` is a historical/configured admission input and may be a no-op without an applicable override; the 600-second `executionMaxWaitMs` is the execution backstop. Neither is a pacing or quota allowance. [E9]
8. **No stale dispatch:** queued work loses approval if the human leaves, the run expires, the route changes, or the request content changes.

### 3.6 Request budgets and accounting

1. Missing budget means **zero network transactions**.
2. The default live-validation envelope is **one generation attempt, one account, one model, no upload, no continuation, no refresh, and no retry**. A human may approve a larger exact integer only after offline evidence shows why each transaction is needed.
3. The run manifest must enumerate the worst case before dispatch. Count every provider-visible attempt, including failed/aborted attempts and all implicit legs: login, mint/touch/refresh, catalog/config, signed-URL creation, each upload, chat, image/audio/video generation, each poll, tool narration retry, continuation, and combo fallback.
4. Enforce both per-run and per-account/day local caps. The per-run cap equals the approved integer. The daily cap is an operator-set value below any known plan allowance; if the allowance is unknown, keep the default one-attempt envelope and require fresh approval. Unused budget does not roll over.
5. Never adopt the historical probe caps of 13 or 60 as production allowances. They belong to bounded experimental harnesses, and the 60-request value was never validated as a same-account provider contract. [E11]
6. A dispatched attempt consumes budget even if the client aborts, times out, receives 5xx, or cannot prove whether the provider completed it.
7. No automatic retry is assumed free. A replay-safe credential retry may occur only if the approval included it, the prior attempt is proven not to have produced a provider side effect, and the credential generation changed. Otherwise stop.
8. Prevalidate prompt size, attachment count/type/bytes, and the full transaction graph before the first network operation. Keep automatic context spill off; it can upload the complete conversation and has no recovered delete operation.

### 3.7 Background callers and cancellation

1. All provider callers must use the same account lease, pacing clock, request ledger, circuit breaker, and budget. There are no exempt “health,” “test,” “refresh,” “recovery,” polling, combo, or cron calls.
2. Before a manual run, enumerate and pause or drain at least: `CredentialHealth`, `ProviderLimitsSync`, `AutoRefreshDaemon`, connection recovery, provider tests, scheduled live probes, media pollers, combo fallbacks, retry workers, and any other process holding the account. The historical runtime showed background jobs alive without the front door and periodic MaxAI test traffic. [E12-E13]
3. Provider health is local/offline by default: process state, immutable digest, route state, credential expiry metadata, and recorded fixtures. An authenticated provider health request needs its own budget line and uses the same pacing. Auth-only touch, JWT mint, token refresh, and model/config lookup are still upstream transactions even when they consume no known message unit. The final2 run’s extra connection-test row proves why chat-only counters are insufficient. [E18]
4. Do not schedule quota-gated UC generation for a guessed reset time. Historical user instructions explicitly changed UC tests from automatic to manually run after reset; a prior cron did run a four-capability suite. Cite Hermes messages `592930`/`592967` (manual-only correction) and cron session `cron_91bd79ad2437_20260825_132054` (historical run). Do not repeat the cron pattern.
5. Client abort, human cancel, lease expiry, or route failure must cancel queued work, stream readers, sleeps, polls, and the real upstream operation. Return 499 for client cancellation without penalizing account health. Verify there is no later terminal side effect. [E8, E16]

### 3.8 Quota and error handling

1. **UC Persona:** parse top-level and nested quota/error frames. On `message_limit_exceeded`, `rate_limit_exceeded`, or a valid 429, record the safe reset metadata, open a circuit breaker, cancel pending work, and stop. Wait until the later of a valid bounded `next_reset`/`Retry-After` and human reapproval. Never infer a reset from `usagePercent`. A 429 on a large input is not an input-size measurement. [E14-E15, E20]
2. Treat the UC cooldown cache as process-local protection, not durable quota truth. Keep a durable operator ledger across restarts and bound/evict the in-process per-session map.
3. **MaxAI:** no captured explicit remaining-quota API exists. Do not advertise one and do not infer quota from 401/499/502/504 or latency. Parse captured HTTP-200 auth/paywall/quota/error/terminal frames before enabling repeat behavior. An empty or unrecognized 200 is failure, not success. [E12, E15]
4. **401/403:** stop. Reauthentication is a new human-approved operation. Do not loop refresh.
5. **418, challenge, CAPTCHA, account-warning, or ban notice:** stop immediately. Do not retry, change identity, alter a fingerprint, or route around it. Follow the provider's official recovery process. Do not diagnose 418 as a ban or TLS failure from status alone; one historical 418 was corrected to an expired-token incident. The reported prior 24-hour ban is a warning, not a cooldown algorithm. [E1, E19]
6. **429/paywall/quota:** stop the account, honor valid provider timing, and do not fail over to UC Direct or another paid surface.
7. **499/abort:** stop and verify cancellation. **502/503/504/timeout/abnormal close/empty result:** stop the run after the first unexpected failure; diagnose offline. Do not label it quota and do not extend all timeouts to hide the layer. [E8, E9, E12, E15]
8. Disable heuristic auto-cure, unapproved narration retries, and post-abort combo fallback. Each can spend another quota unit. [E16]

## 4. Stop conditions

The controller must atomically close admission, abort work, and require new human approval when any condition below occurs:

- terms, account permission, client authorization, or endpoint purpose is unclear;
- immutable image/commit/config does not match the approved manifest;
- route attestation is missing, stale, different from the selected connector, or changes mid-run;
- Tailscale/namespace/kill-switch health fails, proxy precedence conflicts, or any direct fallback becomes possible;
- a fingerprint-manipulation requirement appears without explicit provider authorization;
- the account lease is already held, queue is nonempty beyond the single allowed pending item, or an unknown/background caller attempts access;
- the 30-second completion-to-dispatch floor cannot be enforced;
- the run or daily request budget is exhausted or transaction count is uncertain;
- the human leaves, cancels, or does not approve changed prompt/attachment/subcalls;
- 401, 403, 418, 429, paywall, quota/reset frame, CAPTCHA, challenge, warning, or ban signal;
- first unexpected 5xx, local timeout, abnormal close, malformed/unknown terminal frame, or empty success;
- client abort does not demonstrably cancel the upstream operation;
- an upload succeeds and a later stage fails, because no remote rollback/delete contract was recovered;
- logs reveal a secret, raw prompt, raw response, credential, cookie, token, email code, or raw egress IP.

A stop never authorizes route rotation, account rotation, prompt alteration, or retry.

## 5. Local live-operations sequence L0–L9 (inside reconciliation G9)

All controls are fail-closed. L0–L7 use no MaxAI or UC provider call. L8 is the first live smoke and is permitted only inside the main reconciliation G9 after reconciliation G0–G8 pass.

| Gate | Required proof | Pass condition |
|---|---|---|
| **L0 — scope and terms** | Human-signed run manifest with provider/account pseudonym, purpose, capability, model, exact transaction graph, per-run budget, daily cap, retention, expected hosts/methods, and stop owner. | Terms/client/automation use is allowed; UC Persona is manual-only; UC Direct cannot resolve. |
| **L1 — immutable deployment** | Record source commit, image digest, patch/config hashes, and provider registry inventory. | Digest is immutable and expected files are present. Current `omniroute:base` and the 2026-09-10 UC-less runtime fail. [E17] |
| **L2 — route isolation** | From the actual provider process and selected connector, use an operator-controlled canary to attest the stable residential route. Test conflicting proxy env/`NO_PROXY`, nested contexts, no-assignment versus lookup failure, relay/ineligible branches, restart, and account switch. | Every approved branch uses one route; every unapproved/missing branch refuses before provider dispatch. No raw IP enters evidence. [E5-E7] |
| **L3 — kill switch and cancellation** | Simulate route loss and fast-fail with a fake upstream that records open/abort/terminal effects. | No socket opens after failed preflight; an already-open fake request observes abort; no upload/generation/chat terminal side effect occurs. [E8] |
| **L4 — compliant client** | Static configuration and dependency review. | No fingerprint spoofing or deceptive automation. Any provider-supplied/authorized compatibility profile has written scope; otherwise MaxAI remains disabled rather than falling back. UC has no added fingerprint profile. |
| **L5 — unified admission** | Fake-clock tests and process inventory for every foreground/background caller. Include `CredentialHealth`, `ProviderLimitsSync`, refresh, recovery, cron, polls, retries, tools, and combos. | One account lease, active=1, manual-validation queue=0, routine queue<=1 pending, 30-second operation-completion-to-next-dispatch floor (with only the declared protocol-coupled exception), optional 0–5s load-smoothing jitter, exact shared counter, and zero bypass paths. [E2, E9-E13] |
| **L6 — quota/error semantics** | Recorded/synthetic fixtures only: UC top-level quota/reset frames; MaxAI compact/expanded terminal auth/paywall/quota/error frames; 401/403/418/429/499/5xx/empty-body/abnormal-close cases. | Typed status, bounded reset parsing, circuit opens, no retry/fallback, no false empty success, and safe headers/logs. [E14-E16] |
| **L7 — prompt/privacy/budget** | Human review UI plus tests for content hashes, exact subtransaction accounting, redacted logs, and budget exhaustion. | Prompt/attachments cannot change after approval; missing budget=0; every dispatched subcall counts; raw private content and identities are absent from logs. |
| **L8 — one-call smoke** | New explicit human approval after L0–L7. Start with one ordinary useful prompt, no attachment/tool/continuation, one model, budget=1, concurrency=1. | Egress is still attested; response has a recognized terminal state; no warning/error/empty success; ledger count is exactly one. |
| **L9 — post-run drain** | Close admission and inspect local ledger, queue, workers, sockets, and call records. | No late request, retry, refresh, health check, poll, or upload occurs; budget and status reconcile. If not, stop the provider until root cause is fixed offline. |

A capability expansion repeats L0 and L7–L9 with a new exact graph. Upload/media validation must also disclose partial remote retention and count each upload/poll. Parallel validation remains prohibited by this policy; historical two-lane evidence is not a waiver.

## 6. Minimal run manifest

```yaml
provider: maxai | uc-persona
account_id_hash: "..."
purpose: "..."
terms_and_client_authorized_by: "human-name"
approved_by: "human-name"
approval_expires_at: "..."
image_digest: "sha256:..."
source_commit: "..."
config_hash: "..."
selected_route_policy_id: "..."
egress_attested_at: "..."
egress_asn_class: residential
# Never store the raw egress IP.
prompt_sha256: "..."
attachment_sha256s: []
model: "..."
transaction_graph:
  - kind: generation
    max_attempts: 1
per_run_transaction_budget: 1
per_account_daily_cap: 1
concurrency: 1
max_pending: 0
minimum_operation_completion_to_next_dispatch_ms: 30000
load_smoothing_jitter_ms: [0, 5000]
background_callers_drained: true
stop_owner: "human-name"
```

The sample daily cap is the one-attempt validation default, not a claimed provider limit. Any increase needs a new, exact human approval and must remain within provider terms and known plan limits.

## 7. Release posture

- **UC Persona:** blocked for live use on the captured 2026-09-10 runtime because the deployed image lacks UC code. Only after the main reconciliation G0–G8 and local operations L0–L7 pass may a new explicit reconciliation-G9 envelope authorize one manual L8 smoke. Keep manual-only routing.
- **UC Direct:** disabled/ineligible. No fallback, discovery, health probe, or media use.
- **MaxAI:** source work may proceed offline. Live use is blocked until route/cancellation gaps are closed and the client-profile compliance question is resolved without fingerprint spoofing. Do not treat the one recent 200, the two-lane run, or the current Tailscale topology as a waiver.
- **Parallel/spill:** default-off. Parallel is prohibited by this operating policy. Context spill separately requires privacy/retention approval because it uploads the complete assembled conversation and no delete contract was recovered.

## 8. Audit hygiene

Emit only: UTC time, run ID, provider/account hashes, immutable build/config hashes, route-policy ID, salted egress hash and ASN class, prompt/attachment hashes, transaction kind/count, queue/pacing decisions, status class, duration, circuit-breaker decision, and stop reason. Use mode `0600` or a stricter equivalent. Never serialize credentials or private content. Preserve source/image boundaries; do not combine historical pass counts from v2, final-v8, final2, or the current runtime.

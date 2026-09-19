# OmniRoute Master Reconciliation, Concurrency, and Build Plan

**Status:** Ready for Final Review & Execution
**Target Repository:** `/home/ndsadmin/_/omnirouter/src` (branch: `local` / `next`)
**Private Documentation & Tools Repository:** `https://github.com/arminanton/uc-maxai-recon`

---

## 1. Executive Overview

This master plan unifies all forensic audit discoveries, high-concurrency gateway requirements (40–70 active subagent requests), provider core reconciliations (MaxAI and UC Persona), private email authentication automation, and single-stage Docker build optimizations into one cohesive, sequential implementation.

```
                                  MASTER PIPELINE
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │ TRACK 1: Ingress Concurrency & Anti-Collision Engine                             │
 │ • Raise heavy in-flight slots to 50, queue wait to 30s, queue bytes to 64MB.    │
 │ • Virtual session queue lanes per subagent via header routing (x-session-id).    │
 │ • Antigravity 429 soft-retry resilience (no false 5-min database lockouts).      │
 └────────────────────────────────────────┬─────────────────────────────────────────┘
                                          ▼
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │ TRACK 2: Provider Core Reconciliation & Quota Safety                             │
 │ • UC Persona: Canonical `uc-persona`, `uc`/`ucn` aliases, Clerk WebSocket,       │
 │   PDF/PNG attachment, captured video, policy-disabled speech (0 credits).       │
 │ • MaxAI: Dynamic signer extraction, atomic token persistence, stateless          │
 │   `randomUUID()` conversation IDs, final-v8 document/PDF engine, STT bounds.     │
 │ • Multi-Family Tooling: Cryptographic nonces, Claude XML, GPT JSON, DeepSeek tags│
 └────────────────────────────────────────┬─────────────────────────────────────────┘
                                          ▼
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │ TRACK 3: Personal Codex Gmail OTP Authentication Helper                          │
 │ • `scripts/auth/auto_email_login.py`: Automates MaxAI/UC email OTP retrieval     │
 │   using `codex exec` with `gpt-5.6-luna` (medium reasoning) + Gmail plugin.      │
 └────────────────────────────────────────┬─────────────────────────────────────────┘
                                          ▼
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │ TRACK 4: Unified Single-Stage, Fast Dockerfile & Build Pipeline                  │
 │ • Use prebuilt `better-sqlite3` ARM64 binaries (eliminates 3-min C++ compile).   │
 │ • In-tree CommonJS fix in `assembleStandalone.mjs` (eliminates second build).    │
 │ • Modernize deprecated dev dependencies via `package.json` overrides.           │
 └────────────────────────────────────────┬─────────────────────────────────────────┘
                                          ▼
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │ TRACK 5: Branch-Disciplined Candidate Image Deployment                           │
 │ • `local` is the deployed-source marker; `next` is active integration/development.│
 │ • Build immutable candidate, use isolated private state, and preserve rollback.  │
 │ • Controlled container recreate has brief downtime; zero-downtime needs proxy.   │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Detailed Technical Specifications

### Track 1: Ingress Concurrency & Virtual Lane Isolation
1. **`src/shared/middleware/chatBodyAdmission.ts`**:
   * `CHAT_MAX_HEAVY_IN_FLIGHT = 50` (supports 6–7 parallel sessions with 10–20 subagents each).
   * `CHAT_ADMISSION_QUEUE_MAX_MS = 30000` (30s queue wait before shedding).
   * `CHAT_ADMISSION_MAX_QUEUED_BYTES = 64 * 1024 * 1024` (64 MB buffer).
2. **`src/shared/middleware/chatAdmissionIdentity.ts`**:
   * Inspect headers `x-session-id`, `x-conversation-id`, `session-id`, `x-request-id` to assign distinct virtual admission lanes per subagent, eliminating queue collisions across terminal sessions.
3. **`open-sse/services/antigravity429Engine.ts` & `open-sse/executors/antigravity.ts`**:
   * Differentiate transient RPM burst 429s (`soft_retry`) from true quota exhaustion (`full_quota_exhausted`).
   * Perform brief in-flight backoff (2–3s) without setting 5-minute cooldowns in the database.

---

### Track 2: Provider Core Reconciliation

#### UC Persona (`open-sse/executors/uc/` & `open-sse/config/providers/registry/uc/`)
* **Identity & Multi-Alias**: Canonical `id: "uc-persona"`, alias `"uc"`, additionalAliases `["ucn"]`, display name `"UC Persona / Emotional"`.
* **Transport**: Keyless Clerk session JWT derivation (`uid`) over WebSocket `wss://internal-6.pubyar.com/ws/{uid}?token={jwt}` with 120s timeout and linked abort propagation.
* **Attachments & Media**: PDF and PNG via pre-signed `/user/upload` with canonical base64, 64 MiB decoded bounds, and HTTPS DNS-pinned remote fetch with redirect denial.
* **Captured Video**: `wan-2.2-spicy` image-to-video with clamped parameters (FPS, steps, resolution).
* **Zero-Credit Speech Guard**: Policy-disable UC TTS and STT (`open-sse/handlers/uc/ucTts.ts`), returning 400 policy-disabled before socket creation.
* **Direct Exclusion**: `uc-direct` remains disabled/ineligible (`POLICY_DISABLED`).

#### MaxAI Core (`open-sse/executors/maxai/`)
* **Dynamic Signer**: Extraction with fallback and atomic persistence across `apiKey`, `accessToken`, `refresh_token`, and device IDs.
* **Stateless Multi-Subagent Concurrency**: Every request generates an isolated `conversation_id = randomUUID()` with flattened context.
* **Selected Transport**: Fail-closed Firefox-150/wreq transport across all proxy branches.
* **Final-v8 Document Engine**: Max 5 files; 10M image / 48M PDF / 20M other docs; local prevalidation before upload; isolated PDF text extraction.
* **STT Ingress**: Pre-parse API key validation; chunked multipart streaming; non-empty `speech_text` requirement.
* **Multi-Family Tooling (`open-sse/translator/webTools.ts`)**: Cryptographic per-request `_nonce` generation (`randomBytes(8).toString("hex")`), requested-tool allowlist validation, and `<think>` reasoning extraction.

---

### Track 3: Personal Automated Email Login Helper
* **File**: `~/_/omnirouter/bin/auto-email-login.py`
* **Execution**: Invokes `/home/ndsadmin/.local/bin/codex` with `gpt-5.6-luna` (reasoning: `medium`) + `gmail@openai-curated-remote` plugin.
* **Behavior**: Queries Gmail inbox for verification passcodes from MaxAI or UC/Clerk received in the last 2 minutes and submits them browserlessly.
* **Privacy**: Stored in personal private repository `https://github.com/arminanton/uc-maxai-recon` and never published upstream.

---

### Track 4: Single-Stage, Fast Dockerfile & Build Pipeline
1. **Prebuilt `better-sqlite3` Binaries**:
   * Use precompiled `linux-arm64` binaries directly in `Dockerfile`, replacing the 2–4 minute `node-gyp rebuild` C++ compilation step.
2. **In-Tree Standalone ESM Fix**:
   * Ensure `scripts/build/assembleStandalone.mjs` patches `package.json` to strip `"type": "module"` during the build, eliminating `omniroute-fix.Containerfile` and reducing builds to a single command.
3. **Dependency Modernization**:
   * Add overrides in `package.json` to resolve deprecated dev tools (`glob@^13`).
4. **Single Command Build**:
   ```bash
   podman build --ulimit "nofile=1048576:1048576" -t localhost/omniroute:base .
   ```

---

### Track 5: Branch-Disciplined Candidate Image Deployment
1. **Branch model**:
   * `local`: frozen marker for the exact deployed source commit, synced to `origin/local`.
   * `next`: active development/integration branch checked out at `/home/ndsadmin/_/omnirouter/src`, synced to `origin/next`.
2. **Candidate workflow**:
   * Build an immutable candidate image from the exact clean `next` commit.
   * Record source/tree/lockfile/image digests and dirty state.
   * Start a private preflight with isolated writable state and provider egress blocked.
   * Preserve the prior deployed image digest for rollback.
   * Recreate the live container only after preflight passes, then verify health/readiness.
   * Move `local` to `next` only after successful cutover.
3. **Honest availability**:
   * Current cutover has brief container-recreate downtime and is not Prime Agent-style seamless adoption.
   * True zero-downtime later requires simultaneous blue/green containers, a stable reverse proxy, draining, and credential/background-job fencing—not duplicate source directories.

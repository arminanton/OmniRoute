# Concurrency Overhaul & Personal Automated Email Auth

Implemented: 2026-09-10
Status: **Implemented & Verified in Reconciled Repository**

---

## 1. High-Concurrency Ingress & Multi-Terminal 503 Fix

### The Problem
When running multiple agent sessions in parallel (Hermes, Prime Agent, OpenCode) across different terminal windows:
* OmniRoute dropped concurrent turns with `503 Chat admission capacity is temporarily unavailable. Retry shortly.` (`chat_admission_busy`).
* **Root Cause**: `CHAT_MAX_HEAVY_IN_FLIGHT` was hardcoded to `1` in `src/shared/middleware/chatBodyAdmission.ts`. Every agent turn after turn 1 has >256KB context or tools, classifying it as "heavyweight". A single agent holding that slot caused all other terminals to be shed.

### The Fix
In `src/shared/middleware/chatBodyAdmission.ts`:
1. `CHAT_MAX_HEAVY_IN_FLIGHT`: raised from default `1` to **`50`**.
2. `CHAT_ADMISSION_QUEUE_MAX_MS`: raised from `2000` (2s) to **`30000` (30s)** to absorb burst dispatches across subagents without burning client retry budgets.
3. `CHAT_ADMISSION_MAX_QUEUED_BYTES`: raised from `4 MB` to **`64 MB`**.

---

## 2. Antigravity (`agy/`) 429 Resilience

### The Problem
When multiple agents across terminals hit `antigravity/` models concurrently:
* Google Cloud Code returned temporary burst 429s (RPM rate limits).
* OmniRoute's `antigravity429Engine.ts` immediately locked out the entire account for 5 minutes (`SHORT_COOLDOWN_MS = 5 * 60 * 1000`) in the persistent SQLite database (`setConnectionRateLimitUntil`).
* As a result, subsequent turns across all other terminal sessions failed immediately with:
  `Error: 429 [antigravity/gemini-3.8-flash] All antigravity accounts have exhausted their quota (reset after 5m)`.

### The Fix
In `open-sse/executors/antigravity.ts` (lines 1622–1630):
* Differentiated transient RPM burst 429s (`soft_retry` / `instant_retry_same_auth`) from true quota exhaustion (`full_quota_exhausted` / `short_cooldown_switch_auth`).
* Soft rate limits now sleep briefly (2–3s) for in-flight retry on the active request **without locking out the account across other terminal sessions in the database**.

---

## 3. Personal Automated Email OTP Login (Codex CLI + Gmail Plugin)

Both MaxAI and UC Persona authenticate via one-time email passcodes.

### Implementation: `scripts/auth/auto_email_login.py`
Located at `~/_/omnirouter/bin/auto-email-login.py`:
* Uses local `/home/ndsadmin/.local/bin/codex` with model `gpt-5.6-luna` (reasoning: `medium`).
* Leverages the active `gmail@openai-curated-remote` plugin to search Gmail inbox for verification emails received in the last 2 minutes.
* Extracts the numerical passcode and submits it to complete login browserlessly.
* **Privacy boundary**: Kept in the personal reconciliation repo and never published upstream.

---

## 4. Reconciled Provider & Speech Policy Invariants

* **UC Persona**: Configured canonical `id: "uc-persona"` with aliases `["uc", "ucn"]` in `open-sse/config/providers/registry/uc/index.ts`.
* **UC Direct**: Disabled/ineligible (`POLICY_DISABLED`).
* **UC Speech (TTS/STT)**: Explicit policy guard in `open-sse/handlers/uc/ucTts.ts` returns 400 policy-disabled before socket creation, guaranteeing **zero AI credit spend**.
* **MaxAI Stateless Multi-Subagent Concurrency**: Every request generates an isolated `conversation_id = randomUUID()` in `open-sse/executors/maxai/protocol.ts` with independent reasoning and tool state.

# Prompt, upload, file-type, image, video, TTS, and STT evidence

**Scope:** MaxAI and **UC Persona** only. UC Direct is mentioned only to prevent evidence leakage across products.

**Owner scope override:** `plans/OWNER-SCOPE-OVERRIDES.json` makes UC TTS/STT historical provenance only; both are deferred/OFF and receive no implementation or live-credit validation in this release.
**Method:** read-only. No provider, login, upload, media, model-discovery, or quota call was made. No OmniRoute worktree, image, runtime, or database was changed.
**Evidence cut:** 2026-09-10. This synthesis originally verified source-copy v2. The current project carries v5, whose later changes correct G1 ancestry/provenance and final audit bookkeeping only; the input/file/media evidence cited here is unchanged.

Paths below use:

- `AUD/` = `/home/ndsadmin/_/uc-maxai-recon/audit-source/`
- `EV/` = `/home/ndsadmin/.prime/agent/session-artifacts/01a08922-a4e7-750c-a7c6-575c2e7283a2/uc-maxai-reconciliation/`
- `LIVEWS/` = `/mnt/devvm/custom/omnirouter/workspace/live-validation-20260827/`
- `MXATT/` = `EV/workers/maxai-git/restricted-evidence/frozen-validation/maxai-attachment-validation-20260827/`
- `MXV8/` = `EV/workers/maxai-git/evidence/image-patch-snapshots/validated-attachments-v8-999e/image/`
- `MXF2/` = `EV/workers/maxai-git/restricted-evidence/frozen-validation/maxai-overflow-parallel-final2-review-bundle/`
- `MXF2SRC/` = `EV/workers/maxai-git/evidence/image-patch-snapshots/validated-overflow-parallel-final2-bf65/image/`

Image/revision prefixes used later resolve to these exact IDs:

- `90c1cce...` = `90c1cce3fe9cf82b6f6f635121e6551ea9857df699dbf5c6b70f842c5df72c7d`
- `f788177...` = `f78817786ae2fd3b27afd9e208e454f674956d4bfd07fb27c18edd119e9671af`
- `9ffbdaf...` = `9ffbdaf00c2daa4c9107663b75d8df6a46033d2b81408c74c5b92e0b76465a08`
- `999e6c2...` = `999e6c2c86dcd4ccacf82fbb70777a3169c887f0649dc503e87c3bf8521cf18d`
- `bf6570f...` = `bf6570f7259ca868e6a892244db7041684b4d5c21df791df8ada90095935fe99`
- `b7dd7b6...` = `b7dd7b6e2b6d59079e8ab3fa356241fd7fbd2651e1ef3c2813ba89407a9f2f29`
- `0902501...` = `090250122af18a2867bf11998ab770bf3da4ff6fc76fc07220131d46c87ae33a`
- `08ab818...` = `08ab818d328b324e2dbf943b93c9c8e7f5d3266ec408c52769f1ceb2305cb49f`
- `801fb157...` = `801fb15757a36f22c4c751211b0561097cbe1b3b`; `7b73b6b...` = `7b73b6bad0f5f2ee7eb716ee0548bfb83b7cfae0`; `afa50d9...` = `afa50d9b4fcea841fb476819de8f223855da6f8d`.

## Executive answers

1. **There is no proven universal prompt ceiling for either provider.** MaxAI has a strong one-model tested lower bound of 6,000,000 ASCII characters and a separate 13-model safe point of 400,000 characters. UC Persona has a historical lower bound of 480,586 characters. Each result is model-, payload-, and image-specific.
2. **Automatic huge-prompt-to-file upload is not a current or core OmniRoute capability.** Current upstream and the deployed image do not contain it. A separate uncommitted `final2` image proved one 420,000-character automatic spill, but it uploads the complete conversation and has no recovered delete operation. The audit explicitly excludes it from core and requires it to remain default-off.
3. MaxAI's browser UI has a different behavior: at **at least 8,000 trimmed JavaScript string units**, it intercepts paste and offers **“Paste as prompt”** or **“Paste as source.”** It does not unconditionally choose a file. The source choice creates a `.txt`; the prompt choice creates a saved executable prompt template.
4. A historical standalone MaxAI v3 client automatically routed text **over 5,000 characters** through save-prompt → invoke → delete. One 10,004-character run passed. That was a saved-prompt transport, **not a file upload**, and it is not OmniRoute.
5. MaxAI explicit attachment retrieval is strongly proven for `.txt`, `.pdf`, `.docx`, `.png`, and `.jpg` on image `9ffbdaf...`. Other extensions have only browser-capture or offline classification evidence as listed below.
6. UC Persona explicit blob retrieval is strongly proven for `.pdf` and `.png`. No UC provider-side success was found for `.txt`, `.md`, `.doc`, `.docx`, `.zip`, `.jpg`, or a literal `.jpeg` filename.
7. Media status: MaxAI vision, image generation, and STT have historical live proof; MaxAI video and TTS do not. UC Persona vision, PDF input, image generation, image-to-video, and TTS have historical live proof; UC STT does not.
8. The release state is still **NO-GO**. The public source, local candidates, historical validation images, and deployed image are different boundaries. No reconciled combined candidate exists.

## Evidence-strength legend

- **High / live:** retained result plus exact source/image or a tight timestamped image chronology.
- **High / capture:** raw decoded provider-client traffic and/or exact shipped client code. It proves the captured path, not all file semantics.
- **High / static:** exact hash-bound source plus passing offline tests. It is not provider acceptance.
- **Medium-high:** historical result recorded in a frozen source/memory artifact but not self-contained in the result file.
- **Negative:** an exhaustive relevant search found no test. This means “unproven,” not “provider rejects.”

## 1. Do not mix these implementation boundaries

| Boundary | Exact identity | What exists there | What must not be inferred |
|---|---|---|---|
| Latest public OmniRoute at audit cut | `949235736042b13cf64215632e6d44db7985af76`; locally inspectable provider-equivalent tree `ba597b631d22d85e56db6982f24b7d1ebe238df9` | Merged MaxAI and UC baselines. MaxAI flattens full history inline and uploads only explicit byte-bearing file parts. UC baseline has blob media. MaxAI has no final2 spill. | Not the same as either local improvement branch or any validation image. `949235...` differs from `ba597...` only in three DeepSeek-PoW files. Evidence: `EV/upstream/anchor-verification/ANCHOR-VERIFICATION.json`; `AUD/FINAL-AUDIT-SUMMARY.md:111-125`. |
| Present deployed runtime at audit cut | image `9ffbdaf00c2daa4c9107663b75d8df6a46033d2b81408c74c5b92e0b76465a08`; rev `801fb157...`; patch `maxai-attachment-protocol-fix-v2` | Dirty, image-only MaxAI V2 attachment implementation and accepted MaxAI STT source. It contains **0/20** audited UC paths. It does not contain final-v8 limits or final2 spill. | Historical UC success does not describe the current deployment. Evidence: `AUD/FINAL-AUDIT-SUMMARY.md:27-35`; `EV/workers/maxai-git/IMAGE-RECOVERY.md:39-59`; `EV/workers/runtime/live-file-hash-comparison.json`. |
| Preferred MaxAI attachment donor | offline image `999e6c2c86dcd4ccacf82fbb70777a3169c887f0649dc503e87c3bf8521cf18d`; rev `801fb157...`; patch `maxai-attachment-final-v8` | Strong static/build/offline PDF closure and safer per-file limits. | It did not serve the 5/5 remote attachment matrix. Evidence: `EV/workers/maxai-git/IMAGE-RECOVERY.md:61-75`. |
| Optional MaxAI overflow line | image `bf6570f7259ca868e6a892244db7041684b4d5c21df791df8ada90095935fe99`; baseline `afa50d9...`; dirty patch `maxai-overflow-parallel-final` | Automatic generated-document spill and a host-side parallel probe. | Not upstream, not deployed, not core, and not an approved landing patch. Evidence: `EV/workers/maxai-git/IMAGE-RECOVERY.md:77-93`. |
| Historical UC validation | matrix image `b7dd7b6e2b6d59079e8ab3fa356241fd7fbd2651e1ef3c2813ba89407a9f2f29`; later final TTS/docs image `08ab818d328b324e2dbf943b93c9c8e7f5d3266ec408c52769f1ceb2305cb49f`; rev `7b73b6b...` | UC Persona media matrix on `b7dd...`; final TTS result on `08ab...`. | Neither image is deployed now. Image/run binding: Hermes session `20260827_025922_9ec757`, messages `589338`, `589611`, `591998`, `592000`; `EV/workers/uc-git/restricted-evidence/frozen-validation-20260827/verification-manifest.json`. |

## 2. Prompt and input limits

### 2.1 MaxAI: measured provider behavior versus local controls

| Kind | Exact value and outcome | Evidence / interpretation | Confidence |
|---|---|---|---|
| Cross-model inline safe point | All 13 curated models accepted **400,000 chars = 400,000 UTF-8 bytes**. Exact `cl100k_base` counts were **93,415–94,187**. All returned HTTP 200 and all 52 requested tail fields were recovered. | `MXATT/live-model-400k-results.json` (SHA-256 `9b4176...`) and `model-400k-preflight.json` (`e7e9f1...`). This ran on attachment V1 `f78817786ae2...` by timestamped image chronology, not V2 or final-v8. It is a conservative tested point, not a ceiling. | High for outcome; medium-high for image binding because the result JSON omits the image ID. |
| Largest retained one-model success | `grok-4-1-fast-non-reasoning`: **6,000,000 chars/bytes**, JSON body **6,031,848 bytes**, local usage estimate **1,500,000 tokens**, HTTP 200, tail recalled. | `LIVEWS/maxai-large-turn-6000000.json`, SHA-256 `979927...`. Run after image `90c1cce3fe9c...` was created. | High. |
| Smallest retained effective one-model failure | Same model and image: **6,250,000 chars/bytes**, JSON body **6,283,170 bytes**, reached execution but ended HTTP 502 after an empty provider response. | `LIVEWS/maxai-large-turn-6250000.json`, SHA-256 `a5c402...`. This is not an explicit provider “too large” response, so it does not establish a precise hard limit. | High fact; low as a universal ceiling. |
| Local model-window rejection | Same image/model: **7,957,866 chars** was rejected locally with HTTP 400 and `context_length_exceeded` at an estimated **2,000,000-token** window; **8,000,000 chars** estimated 2,010,590 and was also rejected. Four fewer input characters (`7,957,862`) passed the local gate but later got the same empty-provider 502. | `LIVEWS/maxai-large-turn-{7957862,7957866,8000000}.json`. This is OmniRoute's estimator/window gate, not a measured provider ceiling. | High. |
| Browser UI large-paste trigger | `clipboardData.getData("text").trim().length >= 8e3`; JavaScript UTF-16 string units, not bytes or tokens. Opens a two-choice selector. | Web build `webpage_8.18.0`: `/mnt/devvm/custom/MaxAI/beautified/site__www.maxai.co___next__static__chunks__41068-6f8108ba5efbd08c.js.pretty.js:9652-9677`; Hermes `20260827_055146_c50d7c#593850`. | High / source. |
| Historical standalone-client routing cap | `MAXAI_V3_LARGE_PROMPT_CHARS`: route only values **over 5,000 chars** through ephemeral saved-prompt CRUD. One **10,004-char** prompt passed save → invoke → delete with no residue. | MaxAI private-client commit `8dcd01edcc0f0bce20ddd8c6e3d213d021808bb0`, `v3/src/maxai_v3/chat/large_prompt.py`; frozen memory `memory-1098` (`MEMORY.md:2507`). Not an OmniRoute behavior and not a file upload. | High / code; medium-high / historical live. |
| Clean-current chat ingress cap | Hard JSON chat-body cap **52,428,800 bytes (50 MiB)**. A body at **262,144 bytes**, or a request with at least **32,000 estimated tokens**, **200 messages**, or **64 tools**, is classified heavyweight for admission. Default hard message-count cap is `0` (disabled). | `949235...` is provider-equivalent to `ba597...`; `ba597...:src/shared/middleware/chatBodyAdmission.ts:55-63,104-114,184-187`; current docs `docs/reference/ENVIRONMENT.md:220-230`. Admission serializes/sheds/rejects; it does not spill or upload. | High / current source. |

The 6,000,000/6,250,000 pair is the narrowest retained empirical bracket for one specific MaxAI model and ASCII workload. It is not monotonic proof for every model, language, tokenizer, response duration, or future provider version. The 400,000 result is the better cross-model operating point.

#### The exact 400,000-character matrix

Serving boundary: attachment V1 image `f78817786ae2fd3b27afd9e208e454f674956d4bfd07fb27c18edd119e9671af`, rev `801fb157...`, patch `maxai-attachment-protocol-fix`. The image was created at `13:28:14Z`; requests ran `13:45:30Z–13:51:12Z`; V2 `9ffbdaf...` was not created until `14:03:11Z`. See `EV/workers/maxai-git/evidence/maxai-image-source-inventory.json`, `MXATT/live-model-400k-results.json`, and `MXATT/review-final-closure.md:59`.

| Model | Catalog context metadata | Exact prompt tokens (`cl100k_base`) | Result |
|---|---:|---:|---|
| `gpt-5.6-luna` | 1,050,000 | 93,415 | HTTP 200; 4/4 tail facts |
| `claude-haiku-4-5` | 200,000 | 93,625 | HTTP 200; 4/4 |
| `gemini-3-1-flash-lite` | 1,000,000 | 94,026 | HTTP 200; 4/4 |
| `grok-4-1-fast-non-reasoning` | 2,000,000 | 93,844 | HTTP 200; 4/4 |
| `llama-3.3-70b` | 128,000 | 93,608 | HTTP 200; 4/4 |
| `deepseek-v3.2` | 128,000 | 93,587 | HTTP 200; 4/4 |
| `gpt-5.6` | 1,050,000 | 93,544 | HTTP 200; 4/4 |
| `claude-5-sonnet` | 1,000,000 | 93,542 | HTTP 200; 4/4 |
| `grok-4-1-fast-reasoning` | 2,000,000 | 93,606 | HTTP 200; 4/4 |
| `gpt-5.6-thinking` | 1,050,000 | 93,778 | HTTP 200; 4/4 |
| `gemini-3.1-pro-preview` | 1,000,000 | 94,044 | HTTP 200; 4/4 |
| `grok-4.5` | 500,000 | 93,951 | HTTP 200; 4/4 |
| `deepseek-r1` | 128,000 | 94,187 | HTTP 200; 4/4 |

The catalog values are input/context metadata, not observed character maxima. Current MaxAI discovery can replace them from valid positive `/models/get_config.chat_models[].max_tokens`, but only for the curated 13 IDs; otherwise it uses the static **128,000-token fallback**. Exact source: `EV/workers/maxai-git/evidence/image-patch-snapshots/validated-attachments-v8-999e/image/open-sse/executors/maxai/catalog.ts:24-75` and `MXV8/open-sse/services/maxaiModels.ts:85-100,112-185`.

### 2.2 UC Persona: measured provider behavior versus local controls

| Kind | Exact value and outcome | Evidence / interpretation | Confidence |
|---|---|---|---|
| Historical native-provider lower bound | `claude-opus-46` passed staged tail-recall prompts of **32,649 / 96,640 / 192,267 / 320,249 / 480,586 chars**. The largest was approximately **120,146 tokens** and recalled the head marker. | `/mnt/devvm/custom/uc.com/docs/findings/test-artifacts/context-volume-claude-opus-46.json`, SHA-256 `8619f6...`; generator `/mnt/devvm/custom/uc.com/native/scripts/uc_context_volume_probe.py:52-80`; `EV/workers/uc-git/restricted-evidence/frozen-validation-20260827/verification-manifest.json#/live_results/uc_persona/prior_artifact`. This was the historical Hermes native adapter, not an OmniRoute image. | High for retained rows and reconstructed length; medium-high for old runtime identity. |
| Current-then OmniRoute attempt | `uc-persona/grok-4-20`, **4,000,000 chars/bytes**, whole JSON **4,021,253 bytes**, returned HTTP 429 because the plan limit was active before generation. | `LIVEWS/uc-persona-large-turn-4000000.json`, SHA-256 `466cd0...`. Timestamp binds it to image `090250122af18a...` (`uc-wspath-tts-finalframe`), created one minute earlier. It proves only that local parsing/routing reached the quota path; it establishes no provider input limit. | High. |
| Local serializer only | A mocked local test preserved a **5,000,000-char** turn in a **5,000,626-char** WebSocket JSON frame. | Hermes session `20260827_031124_953f96#587669`. No provider call, so this is not acceptance evidence. | High / static only. |
| Local media cap | `UC_INLINE_MEDIA_MAX_BYTES = 64 MiB` decoded, plus exactly **one** attachment per Persona turn in the hardened `7b73b6b...` line. | `7b73b6b...:open-sse/executors/uc/media.ts:34-58,147-236`; `.../uc.ts:298-360`. This is a local memory/safety rule, not a provider limit. The audit requires count-before-decode and final API/body policy before landing. | High / candidate source. |
| Current upstream baseline | No UC prompt spill and no UC-specific text character cap. Current turn plus full `chat_history` remain inline. The merged media decoder is permissive/unbounded and upload is best-effort; this must be replaced by the bounded one-file concern. | `AUD/CAPABILITY-MATRIX.md:102-108`; `AUD/UC-SOURCE-REVIEW.md:61-72,175-184`. | High. |

No completed post-quota upper-bound result exists in the frozen corpus. Therefore **480,586 characters is the largest proven UC Persona lower bound**, not the ceiling.

#### UC catalog token metadata (not measured Persona turn limits)

The 19-model static table spans **163,840–2,000,000 context tokens** with unknown-model fallback **128,000**. These values were mapped from UC's Direct catalog to Persona IDs and are described in code as plan-dependent; they are not direct Persona max-prompt measurements.

| Persona model(s) | Context | Max output metadata |
|---|---:|---:|
| `claude-opus-45` | 200,000 | 64,000 |
| `claude-opus-46`, `-46-v2`, `-47`, `-47-v2`, `-48-uncensored` | 1,000,000 | 128,000 |
| `deepseek-r1` | 163,840 | 16,000 |
| `glm-5.1` | 202,752 | 131,072 |
| `gpt-5.5` | 1,050,000 | 128,000 |
| `gemini-3-flash`, `gemini-31-uncensored`, `gemini-emotional`, `gemini-3-uncensored` | 1,048,576 | 65,536 |
| `grok-4`, `grok-4-3` | 1,000,000 | no separate cap in source |
| `grok-4-20` | 2,000,000 | no separate cap in source |
| `kimi-k2-thinking`, `kimi-k2.5` | 262,144 | 262,144 |
| `minimax-m2-her` | 204,800 | 131,072 |

Source: `7b73b6b...:open-sse/executors/uc/catalog.ts:35-173`; current `ba597...` has the same numeric table (wording differs only). Do not call these provider request-size limits.

## 3. Huge-prompt handling: four different mechanisms

| Mechanism | Trigger | Transport | Current/core? | What is proven |
|---|---:|---|---|---|
| MaxAI web UI | Trimmed paste `>=8,000` JS string units | Opens a choice. **Source:** create `.txt`, upload, later `doc_list`. **Prompt:** store template and invoke it by ID. | Provider UI behavior, not OmniRoute. Not unconditional. | Direct shipped-code evidence. The source capture had 56,705 bytes / 11,526 tokens and `upload_done`; its exact later chat was not captured. A different capture proves the four-field `doc_list` shape. |
| Historical MaxAI v3 client | Assembled text `>5,000` chars | Automatically save as prompt → invoke saved prompt → delete node. | No. Separate Python client; not a file. | One 10,004-char live pass at commit `8dcd01e...`. |
| Current upstream / deployed OmniRoute | No prompt-to-file trigger | Inline flattened text. Generic context checking/compression may reject or compress; only explicit file parts take upload paths. | **Yes; this is current behavior.** | 400k inline across 13 models; 6m inline on one model. Current source `ba597...:open-sse/executors/maxai.ts:191-220` has no spill branch. |
| Optional final2 | Inline only when **both** JS length and UTF-8 length are `<=400,000`; spill if either exceeds it | Entire assembled system/history/tool/current context becomes deterministic `maxai-context-<sha256>.txt`, uploaded to `/app/upload_document`, then referenced through `doc_list`. | **No.** Uncommitted isolated line; if copied as-is the behavior is automatic and has no request/config consent gate. | One 420,000-char/byte (~105k estimated-token) live request passed on image `bf6570f...`, recovering beginning/middle/end facts. Offline edges cover 20 MiB and 800k-token losslessness. |
| UC Persona | None | Current text and full history remain inline; explicit media uses the blob path. | No spill implementation or candidate. | 480,586-char historical inline success; 4m attempt quota-blocked. |

Final2 exact limits are **20,971,520 UTF-8 bytes**, **800,000 exact `cl100k_base` tokens**, valid paired UTF-16, and one attachment slot out of five. Spill must be lossless or reject. Sources: `MXF2SRC/open-sse/executors/maxai/protocol.ts:19-23,400-498`, `MXF2SRC/open-sse/executors/maxai.ts:247-340`, `MXF2SRC/open-sse/executors/maxai/documents.ts:35-41,228-287`; live: `MXF2/evidence/live-evidence/context-spill-summary.json`; review: `MXF2/reviews/final-acceptance-review.md:17-31`.

**Privacy result:** final2 uploads the complete assembled conversation, including system text, history, tools/results, and current request. No remote delete operation was recovered. The deterministic filename can link repeats. The implementation itself is not gated. The audit disposition is **exclude from core; separate opt-in/default-off privacy project**. See `AUD/INDEPENDENT-EVIDENCE-REVIEW.md:97-109,325-327` and `AUD/FINAL-AUDIT-SUMMARY.md:101-109`.

## 4. Upload and reference contracts

### MaxAI

1. Only byte-bearing parts on the latest user turn are candidates: OpenAI Chat `type:"file"`, Responses `type:"input_file"`, or Claude `type:"document"` with base64/data URL.
2. A pre-existing remote `file_id` or remote file URL is not resolved by final-v8. Inline `image_url` is a separate vision path.
3. OmniRoute computes the provider-required content-derived HMAC-SHA1 `doc_id`, prepares `doc_type`, `pure_text`, and `tokens`, then posts raw bytes in signed multipart to `/app/upload_document`.
4. It parses the terminal SSE `upload_done`, verifies returned metadata, and sends chat only the reference `{doc_id,doc_type,file_name,current:false}` in `doc_list`. File bytes and the presigned storage URL are not placed in chat text.
5. Final-v8 uploads serially and fails closed. Current clean upstream `ba597...` instead uploads in parallel/best-effort and can silently continue after attachment loss. Current deployed V2 is also superseded.
6. The website has an optional persistent project layer (`/project/upload_document`). OmniRoute's chat bridge omits that layer. The web upload result advertised a seven-day presigned URL (`expires:604800`), but URL expiry is not proof that the provider document record or data is deleted.
7. No provider delete/transaction was recovered for normal document uploads. If upload 1 succeeds and upload 2 or chat fails, upload 1 can remain remotely.

Evidence: `MXATT/review-protocol-lineage.md:31-159`; `MXV8/open-sse/executors/maxai/documents.ts:353-467,523-772`; `AUD/MAXAI-SOURCE-REVIEW.md:162-188,332-340`.

**Reference-count nuance:** final-v8 caps new explicit attachments at five. Separately, web capture `run-20260719-031845` placed **21 already-uploaded text/code references** in one chat `doc_list`. Thus five is the recovered per-turn upload/product policy in the candidate, not proof that the provider rejects a `doc_list` longer than five. Hermes `20260827_055146_686ef8#593704`.

### UC Persona

1. UC uses one blob layer for images and documents: request a signed upload URL, `PUT` raw bytes with MIME, require readiness, and send only singular `media_blob_name` plus `media_content_type` in the Persona WebSocket frame.
2. The provider performs image/PDF interpretation server-side. No local PDF parser or `doc_list` exists.
3. The capture proves one attachment. The hardened local line rejects more than one before send and fails closed if upload/readiness fails.
4. Remote image URLs are a separate input form. The recommended port must use HTTPS-only, public-only, DNS-pinned bounded fetching. Existing current upstream behavior is not sufficient.
5. There is no captured general file-ID/reference reuse API. Supported chat-document MIME types beyond the tested cases remain open.

Evidence: `/mnt/devvm/custom/uc.com/docs/reverse-engineering/UC-FILE-UPLOAD.md`; `7b73b6b...:open-sse/executors/uc/media.ts:34-236,271-361`; `7b73b6b...:open-sse/executors/uc.ts:298-360`; `AUD/UC-SOURCE-REVIEW.md:61-72,161-184`.

## 5. File-extension evidence

### 5.1 MaxAI provider-exercised extensions

| Extension | Result | Exact build/image/capture | Confidence |
|---|---|---|---|
| `.txt` | **PASS semantic retrieval:** a small text-document retry returned HTTP 200 and the expected fact; later a 60,000-byte pasted-source file returned HTTP 200 and all four tail facts. Earlier UI capture also uploaded a 56,705-byte / 11,526-token pasted source with `upload_done`. | Small retry: image `90c1cce...`, patch `maxai-stt-raw-multipart`, `LIVEWS/maxai-retry-results.json`. Large file: image `9ffbdaf...`, patch `maxai-attachment-protocol-fix-v2`, `MXATT/live-attachment-results.json:81-96`. UI: `run-20260722-130122`, web `webpage_8.18.0`, Hermes `20260827_055146_c50d7c#593850`. | High live; high capture. |
| `.md` | **PASS transport/reference:** nine Markdown files got HTTP 200/`upload_done` and appeared in a 21-item chat `doc_list`. No retained answer proves semantic use of each file. | MaxAI web capture `run-20260719-031845`, web `webpage_8.18.0`; Hermes `20260827_055146_686ef8#593538,#593704,#593793`. No OmniRoute image. | High for upload/reference only. |
| `.json` | **PASS transport/reference:** seven files uploaded and appeared in the same `doc_list`; no per-file semantic Q&A. | Same web capture/build/messages. | High for transport/reference only. |
| `.yml` | **PASS transport/reference:** two files uploaded and appeared in `doc_list`; no `.yaml` literal case. | Same web capture/build/messages. | High for transport/reference only. |
| `.toml` | **PASS transport/reference:** one file. | Same web capture/build/messages. | High for transport/reference only. |
| `.sh` | **PASS transport/reference:** one file. | Same web capture/build/messages. | High for transport/reference only. |
| extensionless `config` | **PASS transport/reference:** one file. | Same web capture/build/messages. | High for transport/reference only. |
| `.pdf` | Exact 457-byte fixture: first matrix **FAIL** HTTP 502 before upload on `90c1...`; attachment V1 then **FAIL** HTTP 400 because packaged PDF.js/canvas assets were missing; V2 **PASS** HTTP 200 and expected content returned. Final-v8 parsed the same bytes offline but did not serve the remote matrix. | First failure: `90c1cce...` / `maxai-stt-raw-multipart`, `LIVEWS/maxai-results.json`. V1: `f788177...` / `maxai-attachment-protocol-fix`. V2 pass: `9ffbdaf...` / `maxai-attachment-protocol-fix-v2`. Offline final-v8: `999e6c2...`. See `MXATT/live-attachment-results-v1-missing-canvas.json`, `live-pdf-v2-packaged-pass.json`, `live-attachment-results.json`; `EV/workers/maxai-git/IMAGE-RECOVERY.md:26-75`. | High. |
| `.docx` | **PASS semantic retrieval:** 998 bytes, HTTP 200, both facts returned. It passed on V1 and V2. | `f788177...` and `9ffbdaf...`; final retained row `MXATT/live-attachment-results.json:26-42`. | High. |
| `.png` | **PASS semantic retrieval as a file** on both V1 and V2: 4,263 bytes, HTTP 200, correct blue circle. A separate 74-byte PNG passed inline vision on `90c1...`. A July web capture uploaded a 1,828-byte PNG but did not attach that object to chat. | Files: `f788177...` and `9ffbdaf...`, `MXATT/live-attachment-results-v1-missing-canvas.json:44-60` and `live-attachment-results.json:44-60`. Inline: `90c1cce...`, `LIVEWS/maxai-results.json`. Capture-only: `run-20260719-031845`, Hermes `20260827_055146_686ef8#593793`. | High, with paths kept separate. |
| `.jpg` | **PASS semantic retrieval on both V1 and V2:** 16,870 bytes, MIME `image/jpeg`, HTTP 200, correct green triangle. | `f788177...` and `9ffbdaf...`; `MXATT/live-attachment-results-v1-missing-canvas.json:62-78` and `live-attachment-results.json:62-78`. | High. |
| `.jpeg` | **No literal `.jpeg` filename was tested.** The `.jpg` case proves `image/jpeg`; final-v8 regex recognizes both. | `MXV8/open-sse/executors/maxai/documents.ts:78,270-296`. | High negative; static-positive only. |
| `.doc` | **No provider test.** Final-v8 regex maps it with `.docx`. | `MXV8/open-sse/executors/maxai/documents.ts:79,270-296`. | High negative; static-positive only. |
| `.zip` | **No upload/reference/unit/provider case found.** Do not infer it from `.epub` or MIME `application/epub+zip`. It has no dedicated final-v8 type and falls to generic `chat_file`. | Exhaustive capture review Hermes `20260827_055146_686ef8#593793`; MXV8 source/test search. | High negative. |
| `.webm` (STT) | **PASS:** 16,611-byte WebM/Opus input returned HTTP 200 and the expected transcript. | `90c1cce3fe9c...`, rev `801fb157...`, patch `maxai-stt-raw-multipart`; `LIVEWS/maxai-stt-after-fix.json`; fixture hash `bb013a...`. | High; result-to-image association is manifest/chronology rather than embedded in the result JSON. |

### 5.2 MaxAI offline classification only

These are passing local assertions, **not provider upload tests**. Exact source boundary is final-v8 (`801fb157...`; offline image `999e6c2...`). Test: `MXF2/before-snapshot/tests/unit/maxai-documents.test.ts:55-75`; result: `MXATT/final-v8-focused-tests.tap:98-99` within a 54/54 run.

| Extension(s) | Tested local classification |
|---|---|
| `.pdf` | `page_content__pdf` |
| `.docx` | `chat_file_docx` |
| `.pptx` | `chat_file_pptx` |
| `.xlsx`, `.csv` | `chat_file_excel` |
| `.epub` | `chat_file_ebook` |
| `.jpg`, `.png` | `image` |
| `.py`, `.ts`, `.m`, `.t`, `.coffee` | `chat_file_code` |
| `.txt` | `chat_file` |
| `.md` | Its byte-bearing Responses input shape was tested; the final-v8 classifier maps `.md`/`.markdown` to `chat_file_markdown`. |

The shipped MaxAI extension `8.37.1` statically advertises more types: audio `.mp3/.wav/.ogg/.m4a/.flac` (50 MiB), image `.jpg/.jpeg/.png/.gif/.webp` (10 MiB), code types (20 MiB), Word `.doc/.docx` (20 MiB), `.epub` (20 MiB), `.pptx` (20 MiB), spreadsheet `.csv/.ods/.xlsx/.xlsm/.xls` (20 MiB), `.md` (20 MiB), `.pdf` (48 MiB), and generic `.txt/.md` (20 MiB). That is a **static client taxonomy**, not evidence that each extension was uploaded or read. Exact source: `/mnt/devvm/custom/MaxAI/beautified/extension__chunks__66WCMSON.js.pretty.js:8860-8967`.

### 5.3 UC Persona extensions

The live matrix began immediately after image `b7dd7b6e2b6d59079e8ab3fa356241fd7fbd2651e1ef3c2813ba89407a9f2f29` was created (`uc-improvements-wspath-basefix`, rev `7b73b6b...`). Its result is `EV/workers/uc-git/restricted-evidence/frozen-validation-20260827/uc-results.json`.

| Extension | Result | Exact build/image | Confidence |
|---|---|---|---|
| `.pdf` | **PASS semantic retrieval:** 457-byte `project-note.pdf`, HTTP 200, expected codename. | `b7dd7b6e2b6d...`; harness and build chronology in Hermes `20260827_025922_9ec757#586937,#589338,#589611`. | High. |
| `.png` | **PASS vision:** 74-byte PNG, HTTP 200, correct color. Same PNG data-URL type was used for the successful image-to-video input. | `b7dd7b6e2b6d...`; same artifacts/messages. | High. |
| `.txt` | No provider-side Persona upload/read result found. Candidate only guesses `text/plain`. | `7b73b6b...:uc/media.ts:119-136`. | High negative. |
| `.md` | No provider-side Persona result; candidate only guesses `text/markdown`. | Same. | High negative. |
| `.doc`, `.docx` | No provider-side Persona result; candidate has MIME guesses only. | Same. | High negative. |
| `.jpg`, literal `.jpeg` | No provider-side input-file result. The MIME mapping exists, and generated image output was `image/jpeg`, which does not prove input parsing. | Same; `uc-results.json` image-generation row. | High negative for upload/read. |
| `.gif`, `.webp`, `.csv`, `.json` | MIME mappings exist in the candidate but no provider-side read test was found. | Same. | High negative. |
| `.zip` | No mapping and no test found. | Source/corpus search. | High negative. |
| `.mp4` | The generic signed-blob mechanism was captured with `video/mp4`; live image-to-video returned a fetchable `video/mp4`. This is a video flow, not chat document Q&A. | Capture `/mnt/devvm/custom/uc.com/docs/reverse-engineering/UC-FILE-UPLOAD.md`; live `b7dd...`, `uc-results.json`. | High, narrow. |
| `.mp3` | TTS output, not input: final repaired run returned a valid 53,961-byte MP3. | Final image `08ab818d328b...`, patch `uc-wspath-tts-final-dedupe-docs`; `uc-tts-after-fix.json` and `.mp3`. | High. |

The local unit suite exercises PNG data URLs and PDF across OpenAI `file`, Responses `input_file`, and Claude `document` forms. It does not turn the other MIME guesses into provider evidence. Source: `7b73b6b...:tests/unit/uc-capabilities.test.ts:100-225`.

## 6. Numeric upload/resource limits

| Provider/boundary | Implemented or captured values | Meaning |
|---|---|---|
| MaxAI web `webpage_8.18.0` | Paste trigger 8,000 UTF-16 units; captured pasted source 56,705 bytes / 11,526 tokens; upload helper declared 30 MiB general, 10 MiB image, and up to 800,000 text tokens. | UI/client behavior, not a provider chat cap. Hermes `20260827_055146_c50d7c#593850`. |
| MaxAI model capability metadata | Commonly `file_upload.max_count=5`; model-specific `max_size_mb` is 5 or 20 in the captured extension config. | Provider-advertised client capability; not a near-boundary live test. `/mnt/devvm/custom/MaxAI/beautified/extension__background.js.pretty.js:40015-40584`. |
| MaxAI final-v8 local policy | Five files; image 10 MiB (10,485,760 bytes), PDF 48 MiB (50,331,648 bytes), other 20 MiB (20,971,520 bytes); 64 MiB (67,108,864 bytes) **inline decode/preallocation guard only**; 3,200,000 extracted PDF chars; 800,000 text tokens; PDF worker 60 s; tokenizer worker 30 s; upload 120 s; upload response 1 MiB. | Strong frozen implementation evidence. No aggregate request cap, byte-weighted global worker admission, all-document prevalidation, or incremental SSE parser. `AUD/CAPABILITY-MATRIX.md:123,127`; `MXV8/open-sse/executors/maxai/documents.ts:30-41,75-88,309-349,743-772`; `MXV8/open-sse/executors/maxai/pdfText.ts:1-4,172-233`. |
| Proposed MaxAI reconciled policy | Separate aggregate decoded cap 64 MiB. | **Not implemented.** Do not describe the inline guard as this aggregate cap. `AUD/FINAL-AUDIT-SUMMARY.md:101-106`. |
| MaxAI STT accepted candidate | Only `.webm` advertised; accepts real EBML WebM or the captured Ogg/Opus bytes while naming and labeling the part `audio.webm` / `audio/webm`; provider timeout 30 s. | Current shared middleware has a nominal **100 MiB** audio `Content-Length` ceiling, while the route comment says “up to 2GB.” The route itself calls `formData()` before handler auth and has no actual streamed/file-size cap, so missing/false length and chunked bodies remain effectively unbounded; the helper then copies the full Blob/multipart and reads response unbounded. `ba597...:src/shared/middleware/bodySizeGuard.ts:20-24,47-67`; `AUD/MAXAI-SOURCE-REVIEW.md:221-229`; `MXV8/open-sse/executors/maxai/transcription.ts:20-21,49-107,110-163,229-300`. |
| UC hardened local candidate | One attachment; 64 MiB decoded cap; 20 s blob-readiness timeout. | Local policy only, and still needs count-before-decode/API-body alignment. `7b73b6b...:uc/media.ts:31-58`; `AUD/UC-SOURCE-REVIEW.md:175-184`. |
| UC TTS dirty donor | 120 s socket timeout. | No text-length, per-frame, aggregate decoded-audio, or WebSocket-payload bound. Must not land unchanged. `AUD/UC-SOURCE-REVIEW.md:197-215`. |
| UC video candidate | Default poll timeout 300 s, interval 3 s; inherited image resolution cap 1 MiB. | Candidate accepts arbitrary finite workload and polling values; capture-bounded enums/ranges are still required. `AUD/UC-SOURCE-REVIEW.md:217-226`; `7b73b6b...:ucVideo.ts`. |

**Cross-layer reachability:** the clean-current chat route's 50 MiB hard JSON-body cap applies before provider dispatch. All recovered attachment inputs are base64/data URLs. A 48 MiB raw PDF expands to about 64 MiB before JSON overhead, so final-v8's nominal 48 MiB PDF allowance cannot be reached unchanged on the current chat ingress. The same issue makes UC's 64 MiB decoded-media guard an upper decoder guard, not a reachable upload allowance. The reconciled implementation must choose limits that agree across raw bytes, base64 expansion, JSON, aggregate memory, and route admission. Evidence: `ba597...:src/shared/middleware/bodySizeGuard.ts:20-24,47-67`; `ba597...:src/shared/middleware/chatBodyAdmission.ts:55-63`; `MXV8/open-sse/executors/maxai/documents.ts:31-35,309-327`; `7b73b6b...:uc/media.ts:34-58`.

## 7. Image, video, TTS, and STT conclusions

| Surface | MaxAI | UC Persona |
|---|---|---|
| Vision input | Proven: inline PNG data URL returned HTTP 200 and correct shape/color on `90c1cce...`. File-upload PNG/JPG retrieval separately passed on `9ffbdaf...`. MaxAI inline URLs still need scheme/count/byte policy. | Proven: PNG blob vision passed on `b7dd7b6...`. Recommended implementation is one fail-closed blob, not inline passthrough. |
| Image generation | Proven one live `flux-1-schnell` request on `90c1cce...`: HTTP 200 and a fetchable 1,021,124-byte asset, reported `binary/octet-stream`; no output extension proven. Six models are implemented. | Proven Persona image generation on `b7dd7b6...`: HTTP 200; fetched 880,947-byte `image/jpeg`. Current policy exposes 22 Persona models but must preserve registry ordering and provider-ID dispatch. |
| Video | **Absent** from all reviewed MaxAI implementations. | Proven only for capture-backed `wan-2.2-spicy` image-to-video on `b7dd7b6...`: HTTP 200 and fetchable `video/mp4`. Guessed Persona text-to-video must remain rejected. Caller-controlled workload/poll values need bounds before release. |
| TTS | **Absent** from all reviewed MaxAI implementations. The web-app “voice” observation is not an accepted TTS port. | Initial matrix on `b7dd...` failed HTTP 502 after 129.736 s. Separate final run on `08ab818d...` passed HTTP 200 with `audio/mpeg`, 53,961 bytes, 3.36975 s, 44.1 kHz mono, and clean `ffmpeg` decode. Do not call this one 7/7 run. Donor still lacks canonical base64 and payload caps. |
| STT | Proven `.webm` on `90c1cce...`; source also handles captured Ogg/Opus bytes presented as WebM. It is not release-safe until auth-before-parse, actual-byte/body caps, bounded memory/response, and required nonempty `speech_text` land. | **No UC STT protocol, implementation, or test was established.** |

Primary artifacts: `LIVEWS/maxai-results.json`, `maxai-stt-after-fix.json`, `uc-results.json`, `uc-tts-after-fix.json`; `EV/workers/uc-git/restricted-evidence/frozen-validation-20260827/review-uc-closure.md`; `AUD/CAPABILITY-MATRIX.md:122-127`; `AUD/MAXAI-SOURCE-REVIEW.md:221-237,342-378`; `AUD/UC-SOURCE-REVIEW.md:197-226`.

## 8. Direct answer: is automatic huge-prompt-to-file upload currently core/proven?

**No.** The precise answer has four parts:

- **Current public core (`949235...`): no.** MaxAI sends assembled text inline. Its upload bridge activates only for explicit file parts. UC Persona has no spill.
- **Current deployed image (`9ffbdaf...`): no.** It is MaxAI V2, lacks final2, and contains no UC implementation.
- **MaxAI UI: not unconditional.** At 8,000 trimmed JS units the UI opens a choice. “Paste as source” creates/uploads `.txt`; “Paste as prompt” saves an executable prompt template.
- **Optional final2: yes, narrowly proven, but explicitly non-core.** One 420k request automatically uploaded a generated `.txt` and succeeded on `bf6570f...`. The code is uncommitted and ungated, uploads full conversation state, has no recovered delete, and is excluded/default-off by the audit.

The historical MaxAI v3 client adds a fifth nuance: it automatically used saved-prompt CRUD over 5,000 chars, but that is **not** a file upload and is not OmniRoute.

## 9. Required work before release

1. Keep final2 absent unless an explicit product/privacy decision adds a default-off feature gate, per-request consent, clear retention notice, non-linkable naming, and an accepted cleanup/retention contract.
2. Port MaxAI final-v8 by concern, not by copying its tree. Add a true aggregate decoded cap, count/validate/prepare all files before the first upload, byte-weighted global admission/resource isolation, malformed/bomb/parallel tests, incremental upload-SSE parsing, canonical filenames, and explicit non-atomic remote-retention behavior.
3. Put MaxAI STT authentication/admission before multipart parsing. Enforce declared and actual byte caps, handle missing/chunked length, avoid duplicate full buffers, bound the provider response, and require nonempty `speech_text`.
4. Reconstruct UC Persona one-file handling on current upstream with count-before-decode, strict canonical base64, an agreed request/media cap, safe pinned remote fetching, readiness enforcement, and fail-closed semantics.
5. Do not port or live-test UC TTS/STT in this release. Preserve historical TTS evidence only, and prove both speech routes return policy-disabled before transport with zero credit-consuming calls.
6. Keep UC Direct disabled/ineligible. Its untested media surface is not Persona evidence.
7. Build and validate one immutable combined image. No combined candidate exists and all implementation gates remain unexecuted.

## 10. Evidence limitations

- Raw response bodies were not retained for every historical live request. Status, excerpts, sizes, hashes, and input reconstruction remain verifiable.
- Some result JSON files omit image IDs; exact image attribution uses creation/deployment chronology and is labeled accordingly.
- Static extension recognition is not provider acceptance. Upload success is not semantic retrieval unless the response required the file content. Output MIME is not proof of accepting the same extension as input.
- The 6.25M MaxAI failure was empty output, not an explicit size error. The 4M UC result was quota-blocked before generation. Neither is a universal ceiling.
- Current runtime facts are the 2026-09-10 audit snapshot, not a claim about a later deployment.
- Restricted corpora may contain private content or credentials. This report cites IDs and redacted metadata only and reproduces no secrets or private prompt bodies.

# Inputs, files, and media

Full evidence: `../workers/input-upload-media.md`
Compact result files: `../evidence-index/compact-results/`
Owner scope override: `../plans/OWNER-SCOPE-OVERRIDES.json`

UC TTS/STT results below are historical provenance only. Both speech surfaces are deferred/OFF and will not be implemented or live-tested in this release.

## Short answer

Current OmniRoute does **not** safely and automatically turn an oversized prompt into a file reference.

- Normal MaxAI and UC Persona chat still sends text inline.
- MaxAI’s own web UI offers a prompt-versus-source choice for large pastes.
- A recovered optional OmniRoute prototype automatically spills when either assembled JavaScript character count or UTF-8 byte count exceeds 400,000, but it uploads the complete assembled conversation and has no delete contract. It remains excluded and off.
- UC Persona has no spill implementation.

The core release should not silently upload a user's conversation. It should use per-model input accounting and return a typed size error. A later explicit “attach as source” action can be designed with informed consent, retention disclosure, and deletion/lifecycle controls.

## Prompt-size evidence

### MaxAI

| Evidence | Result | Meaning |
|---|---:|---|
| Cross-model matrix | 400,000 ASCII characters; 93,415–94,187 exact `cl100k_base` tokens; 13/13 models passed with tail recall | Strong conservative cross-model point, not a ceiling |
| One-model probe | 6,000,000 ASCII characters passed with tail recall on `grok-4-1-fast-non-reasoning` | Model- and payload-specific lower bound |
| Same model | 6,250,000 characters reached the provider but returned empty content/502 | Not a clean “too large” boundary |
| Local context gate | Around 7,957,866–8,000,000 characters crossed an estimated 2,000,000-token limit | OmniRoute estimator limit for that model, not provider measurement |
| Current chat ingress | 50 MiB JSON body hard cap; heavyweight admission at 256 KiB, 32k estimated tokens, 200 messages, or 64 tools | Admission/rejection only; no upload |

Recommended operating rule for the reconciled core:

1. Count exact bytes and model tokens before dispatch.
2. Keep the model-specific context limit authoritative.
3. Treat 400,000 ASCII characters as a historical cross-model test point, not a static product cap.
4. Reject over-budget inline input with a typed error and an explicit attachment option.
5. Do not silently use the final2 full-conversation spill.

### UC Persona

| Evidence | Result | Meaning |
|---|---:|---|
| Historical native Persona probe | 480,586 characters, roughly 120,146 heuristic tokens, passed with head/tail recall on `claude-opus-46` | Largest proven lower bound |
| OmniRoute attempt | 4,000,000 characters returned quota 429 before generation | Does not establish an input ceiling |
| Local mock | 5,000,000 characters serialized into a WebSocket frame | Local serializer proof only |
| Model metadata | Static model context metadata ranges from roughly 163,840 to 2,000,000 tokens | Mapped metadata, not measured Persona request limits |
| Media guard | 64 MiB decoded attachment cap in recovered hardening | Memory guard, not a text limit |

UC needs per-model accounting and a typed over-limit response. No automatic Persona prompt spill should be invented from MaxAI behavior.

## Large paste and source upload behavior

Four different mechanisms were found:

| Mechanism | Trigger | What it does | Current OmniRoute core? |
|---|---:|---|---|
| MaxAI web UI | At least 8,000 trimmed JavaScript string units | Offers “Paste as prompt” or “Paste as source”; source becomes `.txt` and is referenced through `doc_list` | No; upstream product behavior only |
| Historical MaxAI v3 client | More than 5,000 characters | Save prompt template, invoke it, then delete it | No; not a file upload |
| Current OmniRoute | None | Sends chat text inline; uploads only explicit file parts | Yes |
| Optional final2 | Above 400,000 chars or bytes | Uploads the complete assembled conversation as generated `.txt` and replaces it with a pointer | No; uncommitted, privacy-sensitive, default-off |

Final2 proved one 420,000-character spill with beginning/middle/end retrieval. That proof does not resolve remote retention, deletion, account fairness, worker memory, or cancellation after upload.

## File extensions and semantic retrieval

“Live semantic pass” means the provider read the uploaded content or image and returned the planted fact/visual result. “Capture only” proves an upload/reference shape, not semantic retrieval in OmniRoute.

| Extension/type | MaxAI | UC Persona | Conclusion |
|---|---|---|---|
| `.txt` | **Live pass**, 60,000-character source | Not tested | MaxAI proven only |
| `.md` | Browser capture: 9 uploads + `doc_list`; no isolated semantic Q&A | Not tested | Unproven as an OmniRoute semantic format |
| `.pdf` | **Live pass**, exact 457-byte PDF; packaging failure fixed | **Live pass** | Proven for both |
| `.docx` | **Live pass**, 998-byte fixture | Not tested | MaxAI proven |
| `.doc` | Not provider-tested | Not tested | Unproven |
| `.png` | **Live pass**, blue circle | **Live pass**, red image vision | Proven for both |
| `.jpg` | **Live pass**, green triangle | Not tested | MaxAI proven |
| literal `.jpeg` | Not provider-tested | Not tested | Unproven |
| `.json` | Browser capture: 7 upload/reference cases; no isolated semantic Q&A | Not tested | Capture-only for MaxAI |
| `.yml` | Browser capture: 2 upload/reference cases | Not tested | Capture-only for MaxAI |
| `.toml` | Browser capture: 1 upload/reference case | Not tested | Capture-only for MaxAI |
| `.sh` | Browser capture: 1 upload/reference case | Not tested | Capture-only for MaxAI |
| extensionless `config` | Browser capture: 1 upload/reference case | Not tested | Capture-only for MaxAI |
| `.csv`, `.pptx`, `.xlsx`, `.epub`, code files | Offline classifier/source evidence only | Not tested | Not provider-proven |
| `.zip` | Not provider-tested | Not tested | Unsupported until explicitly designed and safely unpacked; no archive expansion in core |

### MaxAI live attachment matrix

All five requests used `maxai/gpt-5.6-luna` and cloud upload plus `doc_list`:

- PDF: HTTP 200, recovered `PURPLE-OTTER-42`
- DOCX: HTTP 200, recovered supplier and spending ceiling
- PNG: HTTP 200, identified blue circle
- JPG: HTTP 200, identified green triangle
- TXT: HTTP 200, recovered all scheduling facts

Images were uploaded as file objects and retrieved through `doc_list`; they did not pass through an inline fallback.

### UC Persona live input matrix

Provider-side proof is narrower:

- PNG vision: HTTP 200, identified solid red image
- PDF document: HTTP 200, recovered `PURPLE-OTTER-42`

The candidate MIME map names more formats, but a code map is not provider acceptance evidence. The reconciled release should initially allow only reviewed/proven MIME types or mark additional types experimental behind fixtures and feature gates.

## Generated media and speech

| Capability | MaxAI | UC Persona |
|---|---|---|
| Vision input | Historical live pass | Historical PNG live pass |
| Image generation | One live `flux-1-schnell` pass; six models were implemented but not all live-tested | Historical live pass; JPEG asset retrieved |
| Image-to-video | No proven MaxAI implementation | Historical live pass; MP4 asset retrieved |
| Text-to-video | Not proven | Guessed Persona path rejected; do not expose |
| STT | Historical `.webm`/Ogg-Opus-as-WebM live pass | Not implemented/proven |
| TTS | Not implemented/proven | Historical repair produced a valid MP3, but TTS is now deferred/OFF and excluded from core/live validation |

UC's later TTS success is separate from the earlier 6/7 matrix. It must not be described as one uninterrupted 7/7 run or as current release scope.

## Limits that must be reconciled

### MaxAI final-v8 intended policy

- Maximum explicit attachments: 5
- Image: 10 MiB each
- PDF: 48 MiB each
- Other document: 20 MiB each
- Inline decode/preallocation guard: 64 MiB
- Proposed aggregate decoded request guard: 64 MiB
- Extracted PDF text: 3.2 million characters
- Document text: 800,000 exact tokens
- Upload response: 1 MiB

These values are not yet internally reachable as one policy. A 48 MiB raw PDF expands to roughly 64 MiB in base64 before JSON overhead and therefore cannot fit through the current 50 MiB JSON-body cap. G0 must choose aligned limits or introduce a bounded streaming/multipart ingress path.

### Required implementation decisions

1. Align raw bytes, base64 expansion, JSON body, aggregate decoded memory, and provider upload caps.
2. Authenticate before parsing large STT multipart bodies.
3. Bound STT file bytes and upstream response bytes.
4. Globally bound PDF/tokenizer workers by bytes and concurrency.
5. Prevalidate all local documents before the first remote upload.
6. Disclose and test that remote uploads are non-atomic: an earlier upload may remain after a later failure.
7. Reject ZIP/archive inputs until archive-bomb, path, count, and extraction policies exist.
8. Keep automatic full-conversation spill outside core.

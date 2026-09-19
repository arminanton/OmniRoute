# Residential and human-supervised operations

Full policy: `../workers/residential-operations.md`
Owner scope override: `../plans/OWNER-SCOPE-OVERRIDES.json`

## Purpose

Reduce accidental route drift, quota loss, resource spikes, and account blocks while using authorized provider access.

This policy does not authorize fingerprint spoofing, bot-detection evasion, synthetic “human-looking” prompt generation, identity rotation, or terms-of-service bypass.

## Required operating mode

- Use only an owned or explicitly authorized account and residential connector.
- Check provider/client authorization and terms before enabling a compatibility path.
- MaxAI uses the selected Firefox-150/wreq compatibility client and fails closed when unavailable. Do not silently use another TLS or proxy path.
- UC Persona remains manual-only.
- UC Direct remains disabled and ineligible.
- Every live action has a named human approver and a finite upstream transaction budget.

## Route attestation

Attest from the exact connector that will send the provider request.

A generic container public-IP check is insufficient because direct fetches, environment proxies, `NO_PROXY`, edge relays, or nested account/provider proxy settings may choose a different path.

Before the first transaction:

1. Resolve the selected connection.
2. Resolve its exact egress/TLS connector.
3. Attest the expected residential organization/ASN/IP hash from that connector.
4. Verify IPv6 cannot bypass policy.
5. Bind the attestation to the operation ID.
6. Recheck on route/network changes.
7. Fail before the provider call on uncertainty.

Never retry around a route or challenge failure by changing identity, proxy, or connector.

## Human prompt policy

Use a prompt the human actually wants answered.

Allowed:

- genuine user-authored work
- natural follow-ups based on the previous answer
- public or non-sensitive validation content that has a real purpose

Not allowed:

- reusable prompt banks designed to appear human
- obfuscation or random wording intended to bypass detection
- synthetic “human-like” filler
- timing imitation
- unattended repeated probes

The goal is authentic supervised use, not simulation.

## Pacing and concurrency

Default live validation policy:

- one active operation per account
- one upstream transaction in flight
- queue depth zero for manual validation
- parallel layouts disabled
- at least 30 seconds between completed operations
- optional 0–5 second jitter only for load smoothing, never for imitation
- no automatic retry unless the approved envelope explicitly counts it

Historical 15–30 second pauses were capture/test practice, not proof of a safe provider rate. The new 30-second floor is a conservative local starting policy, not a provider guarantee.

## Count every upstream transaction

A “single test” can make multiple remote calls. The budget must count:

- login request and code verification
- token mint/touch/refresh
- catalog discovery
- signed URL creation
- file upload
- generation start
- every status poll
- chat generation
- retry or continuation
- health/connection test

Missing or uncertain budget means zero calls.

## Background work

Before a live canary, disable or drain:

- background provider health checks
- model discovery schedules
- refresh and keepalive jobs
- recovery retries
- cron probes
- media pollers
- parallel coordinators

Use one linked abort signal. A local `499` or `503` must not leave upstream work running.

## Stop immediately on

- selected connector or residential attestation changes
- login challenge, CAPTCHA, bot-warning, or `418`
- `429`, quota limit, or paywall response
- first unexpected `5xx`, empty terminal response, or malformed provider event
- request count becomes uncertain
- cancellation does not stop upstream work
- credential or response data appears in logs
- human supervision ends

Do not auto-retry these states.

## Capability-specific rollout

1. Offline fixtures only
2. Private candidate with provider egress blocked
3. One approved metadata or chat transaction
4. Observe and review
5. One next capability only after approval

For UC Persona, suggested order is chat → tools → PNG vision/PDF → image generation → image-to-video. UC TTS/STT are excluded and receive no live envelope. For MaxAI, chat → tools → explicit TXT/PDF/DOCX/PNG/JPG → image generation → STT. Parallel lanes and automatic spill remain separate projects.

## Required audit record

For every authorized live envelope, retain only safe metadata:

- candidate image digest and source commit
- provider/capability/model
- account/connection pseudonymous ID
- approver and time window
- connector attestation hash
- allowed hosts and methods
- total transaction cap and actual count
- minimum spacing and concurrency
- stop reason/status
- response/error hashes and redacted summaries
- rollback result

Never put credentials or private prompts in the audit repository.

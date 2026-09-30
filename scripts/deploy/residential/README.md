# Residential launch source (LN-30 / LN-31)

Versioned launch source for the local blue/green deployment. Installing these
files does not start a workload or switch the active slot. Build from the exact
release commit in the idle slot, preserve persistent data outside both slots,
and explicitly activate only after deployment checks.

## Explicit profiles

`runtime_launcher.py` now supports `profile: "kernel-residential-v1"` with
`activation: "approved-deployment"`. This is an OS-enforced deployment profile,
not a grant of the experimental application-policy adapter table. It does not
mount `/run/omni-runtime-policy`. The entrypoint refuses an image containing that
reserved path, including a broken symlink or torn authority. Existing application
security source is unchanged. Ordinary standalone behavior remains available.
The old profile (no `profile` field) still requires its locked authority/reviews;
its `approved-deployment` hard stop remains. Do not mix the profiles.

Every role uses fixed rootful Podman arguments: exactly
`--network=ns:/run/netns/omni-app`, UID/GID10001, all capabilities dropped,
no-new-privileges, namespace-denying seccomp, read-only image, private PID/mount/
IPC/UTS boundaries, no engine socket, no port publishing, no image pulls, no
image environment inheritance, and only fixed nonrecursive mounts. Children
inherit the namespace and cannot use setns/unshare to leave it. Separately
launched browser/Codex roles join that same namespace and use loopback endpoints.
Existing host helpers (including Ollama) are neither moved nor trusted.

Launch checks protected installation/config/state paths, an exact policy-bound
root approval receipt, the reviewed installed seccomp file, a fresh public
controller lease, current boot and the named namespace inode. Before any workload
spawn the entrypoint independently checks its real namespace, lease, UID/GID,
capabilities, seccomp, NNP and read-only mounts. Missing, wrong or stale proof
refuses launch. There is no host/default-bridge fallback.

After launch the existing kernel gate remains the authority. It closes on lease
expiry/controller failure and is managed by the existing primary/fallback
controller. This code does not choose devices or modify TCP/UDP/DNS forwarding,
IPv6 denial, private ingress or host routes. A lease expiring between preflight
and payload startup is rejected by the payload. Later expiry blocks traffic in
the kernel; it does not automatically stop processes. Reopening may restore
connectivity; broken streams are not replayed by this launcher.

## Operator inputs and later invocation

Install reviewed files into `/opt/omni-local-next/runtime`, root-owned and not
writable by workload: launcher, entrypoint, boundary checker, unchanged canonical
runtime-policy module, `seccomp.arm64.json`, and `containers.conf`. Install the
same filter as `/etc/omni-local-next/seccomp.json`, and private engine config as
`/etc/omni-local-next/containers.conf`. All ancestors must be root-owned and not
group/world-writable. Keep `/etc/omni-local-next/no-hooks` empty. Implicit Podman
mounts.conf entries are refused. This is not an installer.

Use `kernel-policy.example.json` as the shape, not as approval. Replace ALL image
IDs with reviewed local `sha256:` IDs. Select helpers explicitly. The app image
must contain its assembled `/app/dev/run-standalone.mjs` and
`/app/server-ws.mjs` (trusted peer-stamp/WS wrapper). CLI/browser dependencies
must already exist in their selected images; no runtime downloader is supplied.
After acceptance, set activation to `approved-deployment` and create private
root-owned `/etc/omni-local-next/activation.json` with exactly:

```json
{
  "schema": 1,
  "profile": "kernel-residential-v1",
  "policySha256": "<SHA256 of exact policy.json bytes>"
}
```

Configuration is `/etc/omni-local-next/policy.json`, root-owned mode0600.
The kernel profile does not inject an auth env file or `INITIAL_PASSWORD`.
Normal OmniRoute bootstrap generates missing secrets in `/app/data/server.env`;
first-run onboarding remains enabled. Do not pre-seed the headless password.

Persistent application data is `/home/ubuntu/.omniroute`, mounted at `/app/data`.
It is outside both release slots. Preserve existing contents. The data directory
must be UID/GID10001 mode0700; its parent is the operator-owned (UID1001),
non-group/world-writable home. Symlink/non-directory ancestry is refused.
Root-owned `/run/omni-local-next` and `/var/lib/omni-local-next/podman-home`
must exist, mode0700. Optional helper state remains under `/var/lib/omni-local-next`.
Codex needs root-owned `codex-token/token`, root:10001 mode0440, mounted read-only.
The legacy experimental profile retains its separate explicit auth requirements.

Existing controller must publish protected
`/run/omni-egress/public/residential-v1.json`, and own
`/run/netns/omni-app` and `/etc/netns/omni-app/resolv.conf`. If publication is not
installed/healthy, launch refuses; it does not synthesize proof or change the
controller. Parent handles installation compatibility in acceptance.

Later explicit root invocation, once prerequisites are accepted:

```text
/usr/bin/python3 -I /opt/omni-local-next/runtime/runtime_launcher.py execute app
/usr/bin/python3 -I /opt/omni-local-next/runtime/runtime_launcher.py execute browser
/usr/bin/python3 -I /opt/omni-local-next/runtime/runtime_launcher.py execute codex
/usr/bin/python3 -I /opt/omni-local-next/runtime/runtime_launcher.py stop app
```

Only enabled helper roles may start. `omni-local-next@.service.in` provides the
same launch/stop commands and existing controller dependencies, with no boot
enablement. Stop validates the exact CID, role label and namespace before action.
Stale CID files require operator inspection, never automatic adoption/replacement.
The app binds dashboard20128, API20129 and live WS20132 only when explicitly
started. Existing private Serve routes remain the ingress product; no host port
or new DNS/service is introduced.

## Applicability and remaining acceptance

This profile guarantees local socket routing, not final upstream origin through
remote HTTP/SOCKS proxies, relays, hosted browsers or remote CLI services. Existing
saved configuration can select such services. Deployment must identify those
settings and reject a claim that remote work inherits the namespace. This code
does not approve remote helpers, create grants or remove auth/credential/SSRF/
transport protections. Restored auth/feature/proxy settings need operator review;
three env secrets alone are not proof of the final saved authentication posture.
Container-spawning features have no engine socket and cannot escape via Docker.

Offline fixtures in `tests/test_kernel_launcher.py` and
`tests/test_kernel_entrypoint.mjs` cover argv/profile separation, stale/wrong
leases, normal onboarding, legacy auth-env filtering, image-marker rejection
and boundary-before-spawn composition. The Node VM fixtures require
`--experimental-vm-modules`. Existing
boundary tests remain applicable. Actual OCI namespace join, native dependencies,
helper startup, writable paths, private ingress/auth and controller fail-closed/
fallback behavior still require consolidated acceptance. No deployment success,
remote-service containment or uninterrupted-session claim is made.

## Browser and local API deployment

Use the `runner-browser-cli` target for the combined locked CLI/browser runtime.
It installs the locked Playwright Chromium revision, Xvfb and noVNC tooling at
build time. Set policy `browserPool: true` to enable a private headed inference
display. Enable `helpers.browser` for the headed CDP sidecar and
`helpers.browserLogin` for the isolated interactive-login helper; the latter
requires an exact `dashboardOrigin` HTTPS origin and a `browser-login` image ID.
When configured, `dashboardOrigin` also sets the app's `OMNIROUTE_PUBLIC_BASE_URL`
so OAuth origin checks recognize the private HTTPS dashboard behind the proxy.
It does not enable trust in arbitrary forwarded headers.
The helper's state directory is `/var/lib/omniroute-browser-login` in its container.
Its UNIX socket directory `/run/omniroute-browser-login` is helper-writable and
app-read-only, and is not mounted into other helpers. Existing local-only VNC
routes remain local-only; the new provider-login API is session-authenticated
and forwards only fixed login operations to the helper.

The optional `omni-api-local.socket` / `.service` pair provides host access at
`http://localhost:20129/v1` over IPv4 and IPv6 loopback only. The accepted socket
stays in the host namespace; systemd-socket-proxyd connects to the existing APP
API endpoint from the ingress WAN namespace using its existing root-only rule.
It does not publish a LAN socket, alter routes, bypass API authentication, or
provide TLS on localhost. Private HTTPS remains at the configured Tailscale
Service hostname. Install/enable only after reviewing these fixed addresses
against the existing topology. No provider key belongs in either unit.

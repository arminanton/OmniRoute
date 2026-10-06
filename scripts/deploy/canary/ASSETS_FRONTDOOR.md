# Retained assets and actual frontdoor acknowledgment

`static_assets.py` imports only reviewed absolute `.next/static` paths. The
installer must run under the fixed root owner and use the root-owned public store
`/var/lib/omni-local-next/canary-static`. Every published snapshot is carried into
subsequent immutable unions, so an older open page can fetch delayed chunks even
after several app generations retire. No automatic deletion or deadline GC occurs.
A collision where the same URL has different bytes refuses promotion; do not hide
it by overwriting an old chunk. Store limits fail closed before publication.

`merge_static_assets(oldStatic, newStatic, storeRoot)` returns the exact
`omni-static-assets/v1` record `{schema,digest,path,fileCount,totalBytes}`. The
snapshot name hashes its canonical manifest. `verify_asset_snapshot(path)` checks
actual bytes, manifest, no-follow traversal, no hardlinks, root ownership and
0444/0555 modes. `nginx_location(path)` additionally requires protected ancestry
traversable by the fixed nonroot proxy worker; it serves only GET/HEAD static
assets, with no proxy fallback, POST dispatch, retry or mirroring. Root must bind
this record to the reviewed host layout and fingerprint the companion modules.
Source artifacts and credentials are never copied from app data into this store.

`frontdoor.observe_frontdoors(targets,key,generation,timeout=3)` returns the existing
five-field installed-host acknowledgment. Targets are fixed loopback listeners:

- Dashboard: `/api/canary-readiness`; actual generation header, body schema,
  generation and ready=true must agree, with missing-key access denied.
- API: `/v1/models?prefix=alias&configuredOnly=true`; model-list schema, unique
  IDs and actual generation header must agree. A catalog may intentionally be
  public, so sending a Bearer header is not itself authentication evidence.
- API authentication is checked separately through read-only
  `POST /v1/session-leases` with `{action:"status",generation:1}`. Missing/invalid
  keys must return401 with the corresponding lease-auth code; the ordinary
  private read/manager key lacking `lease:exclusive` must return403
  `LEASE_SCOPE_REQUIRED`. No acquire, renewal, release, provider call or lease
  mutation is requested. A key with an exclusive lease scope is deliberately not
  the observer credential.

All responses are bounded and nonredirecting. Observations come from forwarded
app responses, not NGINX's static `/_omni_generation` marker. Wrong proxy_pass
with a correct static marker is rejected. The optional `requester` hook is for a
reviewed fixed WAN-namespace executor using the same request signature; it must
perform actual requests and never substitute receipt booleans. Diagnostics do
not expose keys, URLs, bodies or raw exceptions.

The process-owned response header is emitted by `canary-lifecycle.cjs` only for a
valid32-hex boot generation; incoming client markers never supply its value.
Management exposure and API bridge route restrictions are unchanged.

Validation commands:

```
python3 -m unittest discover -s tests/integration -p test_canary_assets_frontdoor.py -v
node --import tsx/esm --test tests/unit/canary-lifecycle.test.ts
OMNI_TEST_NGINX_BINARY=/reviewed/private/nginx node --test tests/integration/nginx-canary-acceptance.test.mjs
```

The real private NGINX fixture proves wrong-upstream refusal, public-catalog versus
protected-auth distinction, delayed old/new chunk and HEAD success after old
backend/artifact retirement, static POST refusal with no backend dispatch and
missing-chunk404. Filesystem unit fixtures substitute their own UID solely to
exercise disposable files; production OWNER_UID remains0 and wrong ownership is
separately rejected. These are source/runtime fixtures, not a production install
or a vendor100-generation capacity claim.

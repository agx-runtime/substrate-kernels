# ADR 0011 — Download proxy with analytics

- **Status:** Accepted
- **Date:** 2026-05-28
- **Context doc:** [../design/download-proxy.md](../design/download-proxy.md);
  [../../README.md](../../README.md) (Releases — the public download URL the
  proxy is bound to)

## Context

release.yml uploads `.kernel` bundles and the per-version `SHA256SUMS` to
the `substrate-kernels` Cloudflare R2 bucket, which is served publicly at
`https://kernels.substrate.loopholelabs.io/<filename>` and
`https://kernels.agx.so/<filename>` ([README §Releases](../../README.md)).
Today both hostnames are bound directly to the bucket via a custom domain
— no Worker in front. That gives us **zero observability of who downloads
which kernel, from where, or how often**.

We have a product-analytics pipeline (a separate repo,
`loopholelabs/analytics`, with its own constitution) that accepts events
on a Cloudflare queue and lands them in ClickHouse. Its `proxy-producer`
library is purpose-built for exactly this case: a CF Worker that proxies
downloads and records one `kernel_download` event per download into the
shared analytics queue, with `request.cf` enrichment for IP / ASN /
country / city (analytics
[docs/spec/queue-protocol.md](https://github.com/loopholelabs/analytics/blob/main/docs/spec/queue-protocol.md)).

Adding a Worker is a new component in substrate-kernel's repo — its first
TypeScript artifact. CLAUDE.md §7 requires an ADR for the decision and a
design doc for the component, both landing in the same change as the
implementation; CLAUDE.md §10 requires the doc-manifest gate to include
both. CLAUDE.md §1 requires substrate-native naming — the Worker is the
*download proxy*, the bundles it serves are *kernel bundles*, the bucket
is *substrate-kernels*; the analytics queue is named in the analytics
repo and referenced here only as a dependency.

## Decision

1. **A new `download-proxy/` Cloudflare Worker subtree lives at the repo
   root**, alongside `scripts/`, `patches/`, `tools/`. It is the only
   TypeScript artifact in the repo and is self-contained under that
   directory (its own `package.json`, `tsconfig.json`, `vitest.config.ts`,
   `wrangler.toml`, `src/`, `test/`, `README.md`). It does NOT integrate
   into the kernel-build Makefile — it has a different lifecycle (Worker
   code rarely changes; kernel releases happen on tag pushes).

2. **The Worker is bound to both
   `kernels.substrate.loopholelabs.io` and `kernels.agx.so`** via
   `custom_domain = true` routes. Same hostnames the README already
   documents — no client URL change. Direct R2 S3 URLs continue to work
   as a break-glass for ops; only the public hostnames now go through
   the Worker.

3. **The Worker reads R2 via a binding** (`KERNELS` → bucket
   `substrate-kernels`), not via S3 — faster, no SigV4 in the Worker,
   no egress fees inside the CF network. It supports `GET`, `HEAD`, and
   single-range `GET` requests with proper `Content-Range` (resumable
   downloads of 23–29 MB `.kernel` files matter).

4. **It emits exactly one `kernel_download` event per full 200 GET** via
   `recordDownload(...)`, implemented locally in
   `download-proxy/src/analytics.ts` per the analytics queue contract at
   [analytics/docs/spec/queue-protocol.md](https://github.com/loopholelabs/analytics/blob/main/docs/spec/queue-protocol.md).
   No emit on HEAD (metadata, not a download), 206 (a resumable download
   is N requests; emitting per chunk over-counts), 404, or 405. The
   producer swallows queue-send failures, so an analytics outage cannot
   block a kernel download.

   Substrate-kernel does NOT take a package dependency on the analytics
   monorepo. The analytics repo is private, bun 1.3.x cannot authenticate
   private GitHub git installs (no env-var expansion in dep URLs, no
   credential-helper passthrough for `git+https://`, no SSH agent on
   `git+ssh://`), and analytics ADR 0015 explicitly endorses the
   hand-roll path as first-class: *"the spec is authoritative; a
   hand-rolled producer that conforms to it is equivalent."* The local
   producer is ~50 lines, cites the spec inline, and is asserted against
   the spec by the integration test (every event shape required by the
   spec is checked).

5. **The `(package, version)` split** on the event matches what the
   filename already encodes: `package = "linux-<variant>-<arch>"`
   (e.g. `"linux-base-x86_64"`), `version = "<version>"` (e.g.
   `"6.12.91"`); `SHA256SUMS` rows use `package = "linux-SHA256SUMS"`,
   `version = "<version>"`. The shape is dashboard-friendly: GROUP BY
   `package` gives per-(variant,arch) totals; GROUP BY `version` gives
   release-adoption over time.

6. **Deploy is manual** — `bunx wrangler deploy` from `download-proxy/`.
   No GitHub Actions workflow ships with this ADR. The Worker code rarely
   changes; coupling its deploy to release.yml would create false
   coupling to the kernel release cadence.

7. **The Worker MUST live in the same Cloudflare account as the analytics
   `analytics-events` queue** (cross-account queue producer bindings are
   not supported). That same account already hosts the R2 bucket and the
   analytics workers, so this is satisfied by the existing account.

## Consequences

- **Every download is observable.** Per-(variant, arch) volume, geo
  distribution, ASN organization, release adoption curves — all queryable
  in ClickHouse without changing kernel-build code.
- **Per-IP rate limit** (60 req/min, Workers Rate Limiting binding)
  bounds CPU/request quota and analytics queue fan-out from a single
  source; the endpoint is public + unauthenticated.
- **`GET /` is a browseable HTML listing** of every artifact currently
  in the R2 bucket — SSR by the Worker, 5-min edge cache + ETag,
  per-row link to that version's SHA256SUMS. Visual identity mirrors
  the substrate-bench dashboard (`agx/substrate/tools/bench/dashboard/index.html`)
  so the two pages share an identity; the same three substrate-bench
  divergences (single-item nav, 3-piece footer, server-curated top
  card) apply. The Pencil design's cosign claim is replaced with a
  source-link to this repo — we are reproducibly built, not cosign-
  signed (yet). [design/download-proxy.md](../design/download-proxy.md)
  "Listing page" is authoritative.
- **substrate-kernel grows a TypeScript subtree.** Self-contained under
  `download-proxy/`; its tests (`bun test`) and deploy (`bunx wrangler
  deploy`) live there and don't touch the Makefile. The existing `make
  ci` doc-manifest gate now also enforces the ADR + design-doc additions.
- **The analytics proxy spec is exercised in production.** Before this
  ADR, the spec was only exercised by the analytics repo's own
  proxy-producer tests. The download proxy is the first real, customer-
  facing consumer.
- **The analytics-spec is the only contract — no cross-repo install dep.**
  No bun-lock SHA pin to bump, no auth plumbing for private installs.
  Trade-off: the spec at `analytics/docs/spec/queue-protocol.md` must be
  watched when it changes; the integration test catches shape drift
  against the documented required fields.

## Alternatives considered

- **Status quo — direct R2 with no observability.** Rejected: no signal
  on adoption, regional usage, or release uptake. The analytics pipeline
  exists; not using it leaves a free signal on the floor.
- **A separate `analytics-proxy` repo.** Rejected: the kernel bundles are
  produced and released from this repo, so the artifact-serving Worker
  belongs alongside the artifact build. A separate repo splits review
  surface across two PRs whenever a release-pipeline change has to touch
  serving (e.g. a new variant name).
- **Use the published `@loopholelabs/analytics/proxy-producer` library
  via a git-URL pin** (analytics ADR 0015's recommended path). Tested
  and ruled out: bun 1.3.x cannot authenticate `git+https://` or
  `git+ssh://` GitHub installs for a private repo without inlining a
  token in the URL (no env-var expansion in dep URLs, no credential
  helper passthrough). The viable workarounds — make analytics public,
  ship an install wrapper that injects a token — each add operational
  surface for no functional benefit at this scale. The hand-roll path
  is the cheaper equivalent.
- **Couple deploy to release.yml on tag push.** Rejected: the Worker
  has no version-locked dependency on a specific kernel build. False
  coupling would mean "redeploy the Worker on every kernel release" for
  no functional reason. Manual deploy keeps the lifecycles independent.

# ADR 0016 — Release provenance attestation

- **Status:** Accepted
- **Date:** 2026-07-06
- **Context doc:** [ADR 0005](0005-build-environment-and-reproducibility.md)
  (byte-reproducibility — the property attestation makes independently checkable);
  [ADR 0011](0011-download-proxy-with-analytics.md) (the R2 distribution surface
  the attestation mirrors to); `.github/workflows/release.yml` (the producer)

## Context

A `.kernel` bundle is injected directly into guest memory by substrate, so its
supply-chain story matters: a consumer should be able to check not just *what* the
bytes are (`SHA256SUMS`, and byte-reproducibility per
[ADR 0005](0005-build-environment-and-reproducibility.md)) but *where they came
from* — that this exact artifact was built by this repo's release workflow from a
specific commit, not hand-built and uploaded. Reproducibility alone requires the
verifier to rebuild; provenance attestation gives a cheap cryptographic check.

GitHub's artifact attestation provides this with no key management: the release
job requests an OIDC token (`id-token: write`), sigstore signs a SLSA build
provenance predicate keyless, and GitHub stores the attestation
(`attestations: write`) queryable by artifact digest. The listing page's copy
("reproducibly built", no signature claim —
[design/download-proxy.md](../design/download-proxy.md)) predates this decision.

## Decision

1. **Every release artifact is attested with SLSA build provenance.** The manually
   dispatched workflow builds both supported kernel lines from one exact
   repository commit. Its publish job runs `actions/attest-build-provenance` over
   all eight `.kernel` bundles, the combined and per-version checksum manifests,
   and `RELEASE-MANIFEST.json` after checksumming and **before** the GitHub Release
   is created, with `id-token: write` + `attestations: write` permissions. Signing
   is keyless (GitHub OIDC → sigstore); no signing secrets exist.

2. **The primary verification path is GitHub's attestation store.**

   ```
   gh attestation verify linux-<version>-<variant>-<arch>.kernel \
       --repo agx-runtime/substrate-kernels
   ```

   works for any artifact regardless of where it was downloaded from (GitHub
   Release or R2), because verification looks the artifact up by digest.

3. **The attestation bundle is mirrored as an artifact.** The action's combined
   sigstore bundle is attached to the commit-scoped GitHub Release as
   `substrate-kernels-<12-char-commit>-attestations.sigstore.jsonl` and copied to
   R2 once per kernel line as `linux-<version>-attestations.sigstore.jsonl`, so an
   offline or GitHub-less verifier still has the material.

4. **The R2 mirror is best-effort, like the rest of the R2 surface.** The
   attestation upload is gated on the Cloudflare credentials exactly as the bundle
   uploads are; a missing mirror never blocks the release, and the GitHub store
   remains authoritative.

5. **The download proxy does not yet route the attestation object.** Its path
   patterns accept only `.kernel` and `SHA256SUMS` shapes, so the R2 copy is
   reachable via direct bucket access, not via `kernels.substrate.so`. Extending
   the proxy's routes (and the listing page's "reproducibly built" copy, which may
   now also say "provenance-attested") is a deliberate follow-up with its own
   deploy lifecycle ([ADR 0011](0011-download-proxy-with-analytics.md) §6) — not
   part of this decision.

## Consequences

- Any consumer can verify, in one command and without rebuilding, that a bundle
  was produced by this repo's release workflow from a specific commit — a
  complement to (not a replacement for) byte-reproducibility, which remains the
  stronger, rebuild-based check.
- The release workflow gains two permissions and two steps; no secrets, no key
  rotation, no signing infrastructure to operate.
- Release identity is an exact repository commit and its generated
  `build-<12-char-commit>` tag, while upstream versions remain artifact metadata.
  This avoids forcing one of two independently pinned kernel lines into the
  release name.
- A release run attests the bytes it actually built. If a later commit retains an
  upstream version but changes its bytes, commit-scoped GitHub Releases and the
  GitHub attestation store retain history even though the same-named R2 alias is
  replaced.

## Alternatives considered

- **cosign-sign each artifact** — rejected: same sigstore trust root but adds a
  signing identity/key-management decision and a second CLI for consumers;
  `gh attestation verify` ships with the CLI consumers already use for releases.
- **The generic `actions/attest` action** — rejected: it requires hand-rolling the
  predicate; `attest-build-provenance` emits the standard SLSA provenance predicate
  that `gh attestation verify` checks natively.
- **No attestation (reproducibility is enough)** — rejected: reproducibility
  requires a full pinned-container rebuild to check; provenance is verifiable in
  seconds and covers the "was this actually built by CI" question reproducibility
  alone does not answer for a casual consumer.
- **Serve the attestation through the download proxy now** — rejected for this
  change: the proxy has its own deploy lifecycle and strict path validation; the
  GitHub store already serves every online verifier, so the proxy route is a
  follow-up, not a blocker.

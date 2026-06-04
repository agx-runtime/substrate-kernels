# ADR 0009 — Confidential-compute variants (TEE / SEV / TDX)

- **Status:** Accepted
- **Date:** 2026-05-27
- **Context doc:** [../architecture.md](../architecture.md) §4 (the variant
  matrix); [ADR 0008](0008-kernel-capability-surface-vs-vmm-scope.md) (the
  capability boundary)

## Context

Confidential computing — AMD **SEV-SNP** and Intel **TDX** — runs the guest in an
encrypted, attested memory domain the host cannot read. Supporting it in the guest
kernel needs source changes a normal build does not: the virtio DMA path must use
the DMA API / bounce buffers when guest memory is restricted, the x86 AP boot/reset
and CPUID paths change under encryption, and the guest needs a way to retrieve
attestation secrets at boot. We carry exactly such a series (a small TEE patch
set) applied only for the sev/tdx variants, plus — when wired — a prebuilt qboot
firmware blob and a prebuilt initrd.

The approach: carry the TEE patches and the sev/tdx configs, keep TEE out of base,
and (when wired) supply the firmware/initrd by **vendoring prebuilt blobs pinned by
sha256**, not by building them. Building a minimal confidential-boot firmware and a
secret-retrieval initrd from source is out of scope; we vendor known-good blobs.

## Decision

1. **TEE is out of the base kernel and lives only behind opt-in variants.** The
   matrix (ADR 0002) carries `sev` and `tdx` cells **on x86_64 only**. A base build
   contains **none** of the TEE patches, config, or firmware.

2. **The TEE patch series is quarantined** in `patches-tee/`, applied **only** for
   the sev/tdx variants, never in a base build (ADR 0007 §8). The carried changes,
   each with a why-header and provenance, cover: virtio using the DMA API when guest
   memory is restricted; the x86 SEV AP reset-vector path; retrieving attestation
   secrets from the boot path; and avoiding the native CPUID instruction under
   encryption ([design/patches.md](../design/patches.md)).

3. **The TEE variants supply qboot firmware and a baked initrd by vendoring
   prebuilt blobs — not by building them.** Confidential boot on x86
   needs a minimal firmware stage and an initrd that performs early
   secret-retrieval/measurement before the rootfs is available. It ships
   these as committed binary blobs (no source). When the TEE variants are wired,
   substrate-kernels vendors those same blobs, pinned by sha256 and recorded with
   their provenance, and passes them to the packer's `qboot`/`initrd` sections (ADR
   0003), which are **zero/absent for base builds** ([design/initramfs.md](../design/initramfs.md)).

4. **TEE wiring is deferred.** The `patches-tee/` series and the `config-sev_x86_64`
   / `config-tdx_x86_64` cells are carried and gated (apply-clean + config-invariant)
   now, but the firmware/initrd blobs are **not yet vendored**, so sev/tdx bundles
   are not yet buildable. Settling blob-vendoring (which prebuilt blobs, their
   provenance + pins) is a follow-up; base ships first.

5. **The bundle marks the variant explicitly.** The header's `variant` field
   (`1`=sev, `2`=tdx) tells substrate (and any attestation tooling) precisely what it
   is loading; a base consumer never receives a TEE bundle by accident.

6. **Base reproducibility and gates are unaffected.** Because TEE is fully
   quarantined, the base build's source surface, size budget, and boot-smoke are
   exactly as if TEE did not exist.

## Consequences

- substrate's base guest never carries confidential-compute code.
- The TEE patches/configs are carried and gated; the
  firmware/initrd blobs are vendored when the variants are actually wired.
- The build matrix carries two x86-only TEE cells; the base matrix is untouched.
- If the TEE variants are never wired, they remain carried-but-unbuilt patch/config
  artifacts without affecting base.

## Alternatives considered

- **Build the qboot firmware + secret-retrieval initrd from source** — rejected:
  building a minimal confidential-boot firmware and a secret-retrieval initrd from
  scratch is a large, separate effort and out of scope here. We vendor known-good
  prebuilt blobs, pinned by sha256, instead.
- **Put TEE support in the base kernel (config + patches always present)** —
  rejected: it would place confidential-compute code in every base guest, bloating
  size and source surface; we quarantine it behind the opt-in variants instead.
- **A single "secure" variant covering both SEV and TDX** — rejected: SEV-SNP and
  TDX differ in boot, AP bringup, and attestation; one config cannot serve both
  correctly. Two cells, each minimal and documented.
- **Foreign-named firmware/initrd paths** — rejected (CLAUDE.md §1): the section
  name `qboot` is kept (it names a minimal firmware stage), but all paths around the
  blobs use substrate-native names.

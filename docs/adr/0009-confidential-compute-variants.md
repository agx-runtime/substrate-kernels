# ADR 0009 — Remove the former confidential-compute variants

- **Status:** Superseded (variants removed 2026-07-20)
- **Date:** 2026-05-27; superseded 2026-07-20
- **Context doc:** [../architecture.md](../architecture.md) §4;
  [ADR 0008](0008-kernel-capability-surface-vs-vmm-scope.md)

## Context

The repository used to carry four confidential-compute patches, full `sev` and
`tdx` configs, and reserved bundle IDs. The patches covered restricted-memory DMA,
SEV AP reset, command-line secret retrieval, and encrypted-guest CPUID behavior.

That was inventory, not a working kernel product. substrate has no SEV-SNP or TDX
machine model, attestation contract, confidential-memory mapping path, or loader
wiring for these modes. The kernel variants also had no pinned qboot firmware or
initrd, so the Makefile could not produce an end-to-end bootable artifact. Applying
and compiling those files would not validate confidential boot.

## Decision

1. Remove `patches-tee/`, `config-sev_x86_64`, `config-tdx_x86_64`, and their build
   matrix cells.
2. Forbid the related kernel config symbols in the supported cells so they cannot
   return accidentally through `olddefconfig`.
3. Preserve the v1 bundle header layout. Variant numbers `1` and `2`, and the
   `qboot`/`initrd` offset fields, remain ABI-reserved; no current Makefile target
   produces such a bundle.
4. Require a new ADR and a real substrate boot/attestation test before adding a
   confidential-compute variant again.

## Consequences

- The supported matrix is honest: base/debug on x86_64 and arm64, plus the carried
  x86_64 windows config.
- Three patches per kernel line are built and tested; there is no second hidden
  patch stack.
- Reintroduction is larger than restoring files. It must define the substrate
  machine model, firmware provenance, guest-memory semantics, attestation and
  secret delivery, and automated boot validation.

## Alternatives considered

- **Keep compile-only patches “for later”** — rejected because every kernel bump
  would pay an audit/rebase cost without proving a supported feature.
- **Enable confidential-guest code in base** — rejected because substrate cannot
  exercise it and every guest would inherit the extra surface.
- **Call a successful kernel compile validation** — rejected: confidential boot is
  a VMM/firmware/memory/attestation contract, not a compiler property.

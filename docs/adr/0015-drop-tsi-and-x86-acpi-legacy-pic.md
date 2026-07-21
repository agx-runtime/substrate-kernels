# ADR 0015 — Drop the TSI patches and the x86 ACPI legacy_pic patch

- **Status:** Accepted
- **Date:** 2026-07-05
- **Context doc:** [../design/patches.md](../design/patches.md) (the carried series +
  keep/drop rationale); [ADR 0007](0007-patch-management-policy.md) (minimize
  original patches — they are the standing maintenance cost);
  [ADR 0008](0008-kernel-capability-surface-vs-vmm-scope.md) (the carried-capability
  set this amends)

## Context

The patch series is the highest standing maintenance cost in the repo: every
original (downstream) patch is re-validated at each pin bump and is source surface a
reviewer must audit ([ADR 0007](0007-patch-management-policy.md)). Two carried
originals are the largest / most-fragile of that set:

- **TSI** (`0009-Transparent-Socket-Impersonation-implementation`,
  `0010-tsi-allow-hijacking-sockets-tsi_hijack`) — a new `net/tsi/` address-family
  driver (`af_tsi.c/.h`) plus a `CONFIG_TSI` symbol and the opt-in socket-hijack
  path, routing guest `AF_INET`/`AF_INET6`/`AF_UNIX` sockets transparently over vsock
  to a host proxy. It is **the largest single downstream source addition**, and it
  touches shared, security-sensitive files (`net/socket.c`, `include/linux/socket.h`,
  `security/selinux/hooks.c`, `security/selinux/include/classmap.h`) — so it is both
  the biggest rebase hazard and the biggest source-audit burden in the series.
- **The x86 ACPI `legacy_pic` fix** (`0101-x86-acpi-keep-legacy_pic-in-HW_REDUCED`)
  — a downstream original that keeps `legacy_pic` populated under HW_REDUCED ACPI on
  the 64-bit direct-boot x86 path.

We are trimming the downstream surface to reduce that maintenance and audit cost.

## Decision

1. **Drop the two TSI patches and the `legacy_pic` patch** from `patches/`:
   `0009`, `0010`, `0101`. The then-current series kept those gaps and still
   applied at `-p1` with zero fuzz. The later 2026-07-20 audit removed the unused
   TEE and DGRAM series and renumbered the three surviving patches contiguously.

2. **Remove `CONFIG_TSI` everywhere it was referenced.** It is stripped from all
   configs (it was `=y` in every cell) and from `scripts/config-invariant.py`
   (`REQUIRED_COMMON`), since the symbol no longer exists once the patch is gone.
   `CONFIG_TSI` has no `select` (only `depends on INET`), so removal has no config
   cascade — the stripped configs are byte-for-byte what `olddefconfig` produces on
   the TSI-free tree (verified on x86_64 + aarch64 base).

3. **This amends [ADR 0008](0008-kernel-capability-surface-vs-vmm-scope.md).** ADR
   0008 listed the kernel-side TSI driver as *required* by substrate's net contract
   and part of the carried set; it no longer is. substrate must not rely on kernel-
   side TSI. If a consumer reappears, TSI is re-added via a new ADR (per
   [ADR 0007](0007-patch-management-policy.md) — a carried patch must cite a live
   contract).

4. **Only the `legacy_pic` half of the x86 ACPI fixes is dropped.**
   The ACPICA `PCI_CONFIG` guard is **kept**, re-derived as current patch `0002` —
   it is a smaller, still-needed fix for the PCI-off ACPI path.

## Consequences

- **Smaller, cheaper series.** No `net/tsi/`, no SELinux TSI hooks/classmap change, a
  smaller `net/socket.c` + `include/linux/socket.h` delta, and one fewer config
  symbol. Three fewer patches to re-validate at every pin bump.
- **No kernel-side TSI in the guest.** Transparent socket interception over vsock is
  gone from the guest kernel; any substrate feature that depended on it must be
  served another way (e.g. real in-guest networking — the netfilter/bridge/NAT
  surface of [ADR 0014](0014-container-runtime-networking.md) — or a host-side
  mechanism). This is the substantive capability change and the reason ADR 0008 is
  amended.
- **The former latent x86-boot risk is now closed by a real gate.** Both LTS lines
  boot through substrate's 64-bit HW_REDUCED/PCI-off machine on AMD and Intel,
  reach `ACPI: Interpreter enabled`, and probe their DSDT-enumerated virtio
  devices without `legacy_pic`. This is stronger than the old early-banner QEMU
  check and is the removal evidence for `0101`.
- **Build + static gates unaffected.** base x86_64 and aarch64 compile clean without
  the dropped patches; `applies-clean` covers the reduced series; `config-invariant`
  no longer requires `CONFIG_TSI`; the bundle format is unchanged.

## Alternatives considered

- **Keep TSI** — rejected: it is the largest downstream original patch and its
  standing rebase + source-audit cost is exactly what this trims; no consumer is
  being maintained against it here.
- **Disable TSI via config instead of dropping the patch** — rejected: `CONFIG_TSI`
  is *defined by* the patch (`net/tsi/Kconfig`); a config-off would still carry the
  source and its maintenance cost — the cost we are removing.
- **Keep `0101`** — rejected: it is part of the same downstream-trim; the risk is
  latent and explicitly recorded, and it can be restored in one line if substrate's
  x86 boot needs it.
- **Drop the ACPICA guard too** — rejected: a same-tree negative boot without it
  reports `AE_BAD_PARAMETER` and probes no virtio device; only the `legacy_pic`
  half is unnecessary.
- **Squash TSI removal into a config-only change** — rejected: the patch series is
  the source of truth ([ADR 0007](0007-patch-management-policy.md)); dropping the
  capability means dropping the patches, the config symbol, and the gate together.

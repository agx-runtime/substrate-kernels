# ADR 0008 — Kernel capability surface vs VMM device scope

- **Status:** Accepted (revised 2026-07-20)
- **Date:** 2026-05-27
- **Context doc:** [../architecture.md](../architecture.md) §5; CLAUDE.md §1;
  [ADR 0015](0015-drop-tsi-and-x86-acpi-legacy-pic.md)

## Context

A guest kernel ships drivers; a VMM instantiates devices. Those are different
scopes. An uninstantiated built-in driver cannot reach the host, but it still costs
image size and adds guest attack surface, so “the VMM does not expose it” is not by
itself a reason to carry it.

The 2026-07-20 audit checked the kernel against substrate's current machine model:

- substrate instantiates virtio block, net, vsock, console, rng, balloon, and
  optional virtio-fs devices;
- its vsock device advertises the experimental DGRAM bit and retains a public
  backend seam, but no shipped real backend or guest control path consumes it;
  stock Linux declines that unknown bit while stream vsock remains functional;
- virtio-fs has no DAX shared-memory window, so the non-DAX FUSE driver is enough;
- arm64 gets wall time from PL031; x86 boots from ACPI and uses its normal KVM
  clock/timekeeping path;
- substrate has no virtio-RTC, TSI, PCI device model, GPU, SEV-SNP machine model,
  or TDX machine model.

## Decision

1. **substrate controls host exposure, and the kernel carries only exercised
   capabilities.** A device is host-reachable only when substrate creates its
   MMIO transport, queues, interrupts, and backend. Separately, every built-in
   kernel driver needs a current substrate consumer or boot-contract rationale.

2. **The current guest device set is explicit.** Base and debug kernels carry
   virtio block/net/stream-vsock/console/rng/balloon and non-DAX virtio-fs. arm64
   carries PL031. x86 carries ACPICA because substrate describes its virtio-mmio
   devices in AML; `CONFIG_PCI` remains off. GPU/DRM, DAX, virtio-RTC, TSI, and
   TEE support are absent.

3. **There is no bundle capability bitset.** A bundle's line/architecture/variant
   selects a reviewed, fixed feature set. Adding or removing a capability changes
   the configs or patches and the matching substrate implementation together.

4. **Compile-only inventory is not a supported feature.** The former SEV/TDX
   configs and patch quarantine were removed ([ADR 0009](0009-confidential-compute-variants.md)).
   A future optional device or confidential-compute mode returns only with a real
   substrate machine model and an end-to-end boot test.

## Consequences

- The host boundary is still determined by devices substrate instantiates.
- The kernel surface is smaller than the old “maybe substrate will wire it” set.
- virtio-fs volumes remain supported without carrying an unusable DAX path.
- The ACPICA patch remains because a same-tree negative boot proves it is required.
  The six DGRAM RFC patches were removed because there is no production consumer;
  real stream tests pass on stock 6.12.96 and 6.18.39 when bit 3 is declined.

## Alternatives considered

- **Keep every plausibly useful driver because an unwired driver is inert** —
  rejected: it ignores image-size, maintenance, and in-guest security costs.
- **Advertise individual capabilities in the fixed bundle header** — rejected:
  supported cells have reviewed fixed configs, and changing the v1 producer/
  consumer ABI adds negotiation without solving a current problem.
- **One build variant per optional driver** — rejected as needless matrix growth.

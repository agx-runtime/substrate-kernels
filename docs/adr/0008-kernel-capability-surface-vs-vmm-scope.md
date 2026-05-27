# ADR 0008 — Kernel capability surface vs VMM device scope

- **Status:** Accepted
- **Date:** 2026-05-27
- **Context doc:** [../architecture.md](../architecture.md) §5 (the capability
  surface); CLAUDE.md §1 (scope IN/OUT); [ADR 0009](0009-confidential-compute-variants.md)
  (the TEE variants)

## Context

A guest kernel ships *drivers*; a VMM *instantiates devices*. These are different
scopes, and conflating them produces two opposite errors: a kernel too lean to
support a substrate feature (a missing driver = a feature substrate cannot offer),
or a worry that a kernel carrying a driver substrate doesn't wire somehow widens
the guest→host attack surface.

This matters because the carried driver set is broader than substrate's
*minimal* device set. Cross-checking against substrate's
own architecture.md §1 feature contract:

- **virtio block / net / vsock / console / rng** — substrate's core devices. In
  scope on both sides; no tension.
- **TSI (transparent socket interception)** — substrate's net contract explicitly
  includes "TSI … coexisting with virtio-net, and a per-connect JSON egress
  policy" (substrate architecture.md §1.3). The kernel-side TSI driver is *required*
  for that feature. **In scope.**
- **vsock datagrams** — substrate's vsock muxer (substrate ADR 0015) is the host
  side; datagram support is a kernel capability that broadens what the muxer can
  carry. In scope.
- **virtio-fs / DAX** — substrate keeps virtiofs "only for explicit user `--volume`
  bind mounts, and is optional" and **never as rootfs**. The kernel-side
  virtio-fs/DAX driver is needed for those optional mounts. **In scope.**
- **virtio-rtc** — a guest timekeeping capability with no host security exposure;
  carried so substrate *may* wire it.
- **TEE / SEV / TDX** — carried only behind the sev/tdx variants (ADR 0009), not in
  a base build.
- **GPU / virtio-gpu / DRM** — cut on both sides (user: "just not GPUs").

The bundle header carries **no capability-advertisement field**: substrate wires
devices from its own configuration against the kernel's fixed per-variant feature
set. We still need a principle that makes a carried-but-unwired driver safe.

## Decision

1. **The kernel provides capability; substrate controls exposure.** The kernel may
   build in a driver substrate does not instantiate in a given configuration. The
   guest→host security boundary is enforced by **substrate not creating the
   device** (no virtqueue, no MMIO region, no backend), **not** by the kernel
   lacking the driver. A driver with no backing device is inert: it probes nothing
   and exposes nothing to the host.

2. **The carried set is the base feature set.** Concretely: block,
   net (with TSI), vsock (with datagrams), console, rng, virtio-fs/DAX, and
   virtio-rtc. Each is justified in [design/patches.md](../design/patches.md) /
   [design/kernel-config.md](../design/kernel-config.md) against the substrate
   feature it serves. GPU is cut (CLAUDE.md §1); CAN is dropped (no substrate
   consumer, [design/patches.md](../design/patches.md)).

3. **There is no capability-advertisement field; substrate knows the carried set
   implicitly.** The bundle header carries no `capability_flags`. Because a base bundle always
   carries the same feature set (it is a single, versioned artifact), substrate
   wires devices from its own configuration and relies on that fixed set. Adding or removing a capability is a deliberate, reviewed change to
   the kernel config/patches *and* the matching substrate wiring — not something the
   header negotiates at run time.

4. **TEE lives behind the sev/tdx variants** (ADR 0009): the confidential-compute
   drivers, patches, and (eventually) firmware are present only in those variants,
   not in a base build. The bundle's `variant` field tells substrate which it is.

5. **A carried driver still pays a cost.** Extra built-in drivers add image size
   (architecture.md §6 budget) and in-*guest* attack surface. Each carried
   driver is justified per-feature (CLAUDE.md §1), and the size budget + the
   per-patch keep/drop rationale ([design/patches.md](../design/patches.md)) are the
   backstop against creep.

## Consequences

- The kernel supports substrate's full feature contract (including TSI and optional
  virtio-fs mounts) without substrate-kernel tracking which devices a given
  substrate build happens to wire.
- A carried-but-unwired driver cannot widen the *host* attack surface, because the
  host surface is the set of *devices substrate instantiates*, which the embedder
  controls — the principle in Decision §1.
- The header carries no capability field, so substrate's loader stays a thin,
  fixed contract.
- The size/attack-surface cost of carried drivers is real and is governed by
  the per-feature justification + the size budget, not waved away.

## Alternatives considered

- **Advertise capabilities via a `capability_flags` header field** — rejected: the
  header is a fixed, versioned contract and substrate reads specific field offsets
  (ADR 0003), so adding a bitset would break the consumer for no gain. substrate
  relies on the fixed per-variant feature set instead.
- **Make the kernel exactly substrate's minimal device set, nothing more** —
  rejected: it would drop TSI and virtio-fs, which substrate's feature contract
  *requires*.
- **Gate every optional driver behind its own build variant** — rejected as
  over-fragmentation: an inert built-in driver costs only image size, which the
  budget governs. The variants we carry are sev/tdx/windows.

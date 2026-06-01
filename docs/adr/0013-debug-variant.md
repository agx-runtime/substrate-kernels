# ADR 0013 — The debug variant

- **Status:** Accepted
- **Date:** 2026-06-01
- **Context doc:** [../architecture.md](../architecture.md) §4 (the variant
  matrix); [../design/kernel-config.md](../design/kernel-config.md) (the
  per-variant config + the debug deltas);
  [ADR 0006](0006-kernel-config-strategy.md) (config-over-patch + curated
  minimal); [ADR 0008](0008-kernel-capability-surface-vs-vmm-scope.md)
  (capability surface vs device scope)

## Context

The base kernel is **curated-minimal** — monolithic, virtio-only, no tracing
infrastructure, no debug info. That is the right shape for production: a fast
boot, the smallest in-guest attack surface, and the smallest image to inject
into guest RAM ([architecture.md §6](../architecture.md)).

It is the wrong shape for **debugging a guest**. A user who needs to attach
`ftrace`/`trace-cmd`, run a `bpftrace` script with kprobes, profile with
`perf record` against kernel tracepoints, do CO-RE BPF with BTF, or
source-step the kernel under GDB cannot do any of that against the base
bundle — those capabilities depend on `CONFIG_FTRACE`, `CONFIG_KPROBES`,
`CONFIG_BPF_EVENTS`, `CONFIG_DEBUG_INFO_BTF`, `CONFIG_DEBUG_INFO_DWARF5`,
and `CONFIG_GDB_SCRIPTS`, all of which are absent from base.

Two ways to give debugging users what they need:

1. **Carry the debug surface in base.** Drops the curated-minimal posture
   for everyone, all the time — ~170 KB ftrace tables on every production
   boot, MB of DWARF/BTF in every bundle. The boot-time budget
   ([architecture.md §6](../architecture.md)) is a review signal, not a
   gate, but it would slide every release.
2. **A separate debug variant.** Ships the same kernel source + patch
   series, with a `.config` that adds the tracing/debug surface. Production
   boots base; a developer who needs the debug surface fetches the matching
   debug bundle.

This ADR records the second path.

## Decision

1. **A new `debug` variant cell, for x86_64 and aarch64.** It is the substrate
   guest model in every respect base is (same patches, same boot contract, same
   bundle format) **plus** the tracing/debug surface. riscv64, windows, sev,
   and tdx do **not** carry a debug variant — they are not substrate boot
   targets ([ADR 0002](0002-target-architectures.md)) or are special-purpose
   variants ([ADR 0009](0009-confidential-compute-variants.md)).

2. **The debug deltas, on top of `config-base_<arch>`** ([design/kernel-config.md](../design/kernel-config.md)):
   - **Tracing:** `CONFIG_FTRACE=y`, `CONFIG_FUNCTION_TRACER=y`,
     `CONFIG_FUNCTION_GRAPH_TRACER=y`, `CONFIG_DYNAMIC_FTRACE=y`,
     `CONFIG_FTRACE_SYSCALLS=y`, `CONFIG_STACK_TRACER=y`.
   - **Probes:** `CONFIG_KPROBES=y`, `CONFIG_KPROBE_EVENTS=y`,
     `CONFIG_UPROBE_EVENTS=y` (x86: also `CONFIG_OPTPROBES=y`).
   - **BPF tracing:** `CONFIG_BPF_EVENTS=y`, `CONFIG_BPF_JIT=y`,
     `CONFIG_BPF_JIT_ALWAYS_ON=y` (JIT belongs in debug — it's a performance
     prerequisite for serious BPF observability, not just a debug aid).
   - **Source-level debug:** `CONFIG_DEBUG_INFO=y`,
     `CONFIG_DEBUG_INFO_DWARF5=y`, `CONFIG_DEBUG_INFO_BTF=y`,
     `CONFIG_GDB_SCRIPTS=y`.
   - **`CONFIG_PERF_EVENTS=y`** — already on in base, asserted explicitly here.
   The cuts in base ([design/kernel-config.md](../design/kernel-config.md)) —
   `BTRFS_FS`, `SOUND`, `FAT_FS`/NLS chain — stay cut in debug too. The debug
   variant is for debugging, not for re-enabling everything we cut.

3. **The config-invariant gate enforces the debug-required set per cell.**
   `scripts/config-invariant.py` adds a debug branch that requires the
   tracing + kprobes + BPF-events symbols. Forbidden lists are shared with
   base except `CONFIG_FTRACE` is in `required` for debug (instead of
   `forbidden`).

4. **The bundle header records the variant explicitly.** `variant = 4 = debug`
   (in addition to `0=base`, `1=sev`, `2=tdx`, `3=windows`). Substrate +
   any attestation tooling can distinguish a debug bundle from a base bundle
   without parsing the kernel ([ADR 0003 §2](0003-kernel-bundle-format.md)).

5. **CI gates the debug variant the same way base is gated**
   ([testing/strategy.md](../testing/strategy.md)). The
   `config-invariant`, `build`, `boot-smoke`, and `repro-check` matrices each
   carry `(arch, variant)` cells for both `base` and `debug` on x86_64 and
   aarch64. `applies-clean` is the same patch series so it isn't duplicated.

6. **release.yml publishes the debug bundles alongside base.** A release
   carries four `.kernel` artifacts (`linux-<version>-{base,debug}-{x86_64,aarch64}.kernel`)
   in the GitHub Release, in the version-scoped `SHA256SUMS`, and to the R2
   bucket served at `kernels.substrate.loopholelabs.io` /
   `kernels.agx.so`. The download proxy ([ADR 0011](0011-download-proxy-with-analytics.md)) routes
   the new filenames unchanged — its variant regex already accepted `[a-z]+`.

7. **The debug bundle is not the production default.** Substrate loads
   whichever bundle it is given; the contract is "ask for the debug variant
   when you intend to debug." The carried base remains the recommended
   production kernel.

## Consequences

- **Debuggability is reachable without rebuilding.** Anyone hitting a problem
  on the production guest can drop in the matching-version debug bundle,
  reproduce, and attach ftrace / bpftrace / GDB without doing a custom build.
- **Production boots stay lean.** Base keeps its ~170 KB ftrace-table savings
  and its much smaller image (no DWARF5/BTF); the boot-time budget
  ([architecture.md §6](../architecture.md)) is unaffected.
- **The build matrix doubles for x86_64 + aarch64.** Two more cells through
  config-invariant, build, boot-smoke, and repro-check. Acceptable cost: the
  per-cell build is bounded by the cache, and the matrix is fail-fast off in
  CI / fail-fast on in release.
- **The bundle format gains one variant id.** No header layout change; the
  `variant` field already encodes per-variant identity (a forward-compatible
  4-bit subset is plenty for the matrix we carry).
- **An extra release artifact set.** The four-bundle release is denser to
  page through; the listing page ([../design/download-proxy.md](../design/download-proxy.md))
  orders base before debug within each (version, arch).

## Alternatives considered

- **Ship a single bundle with debug on by default** — rejected: forces every
  production boot to pay the tracing/DWARF/BTF cost (boot time, image size,
  in-guest attack surface) for a capability used by a small minority of boots.
- **Ship debug as a build-flag that produces the same bundle name** —
  rejected: a release would carry "linux-…-base-x86_64.kernel" with
  silently different bytes depending on the build flag, defeating the
  content-addressable identity that the byte-reproducible build
  ([ADR 0005](0005-build-environment-and-reproducibility.md)) gives us.
- **Put debug inside `sev`/`tdx` as a sub-flag** — rejected: orthogonal
  concerns (confidential compute vs developer debugging), each with its own
  patch quarantine, config delta, distribution audience.
- **A "fragment" merged onto base at build time** (instead of a full
  `config-debug_*` per cell) — rejected for the same reasons base / sev /
  tdx use full per-cell configs ([ADR 0006 §5](0006-kernel-config-strategy.md)):
  the per-cell diff is reviewable as a plain file, and the build stays a
  copy + `olddefconfig`.
- **Generate debug-arch bundles for riscv64 / windows / sev / tdx** —
  rejected: riscv64 and windows aren't substrate boot targets, and
  sev/tdx debugging needs a separate decision (debug instrumentation
  inside an attested domain has its own threat model). Revisit if a
  concrete consumer appears.

# Substrate Kernel

**substrate-kernel** is the build system that produces the `.kernel` artifact —
the Linux guest kernel that **substrate** (our embedded microVM monitor) loads
into a guest. It is *not* the hypervisor and *not* a library: it pins a Linux
source tree, applies a curated patch set, builds it with a minimal monolithic
config, and packages the result into a single self-contained **kernel bundle**
that substrate mmaps and injects into guest memory. The sole consumer of the
artifact is substrate.

This document is the constitution. It is binding. If a rule here conflicts with
something you read elsewhere, this wins.

---

## 0. Prime Directive

**Every patch, every config line, every byte of the bundle is understood,
documented, and tested.** Three gates, no exceptions:

1. **Understood** — you can explain *why* it exists in terms of the contract it
   satisfies: a hardware/boot protocol, a kernel UAPI, the substrate feature it
   enables, or a guest-correctness bug it fixes. "that's how it's done elsewhere"
   is not understanding. A carried patch you cannot justify is a patch to drop.
2. **Documented** — a `why:`-style header on every patch (intent + upstream
   provenance + spec citation), rustdoc-grade prose on the bundle format and the
   packer, and an ADR for every architectural decision (§7).
3. **Tested** — by the right gate for the failure class (§8): patches apply
   clean, the config holds its required invariants, the bundle layout is golden,
   the build is byte-reproducible, and a real guest boots under substrate.

We are rebuilding a guest kernel image from scratch: **all the capability, none
of the cruft.** The capability is a fast-booting, virtio-only kernel that
substrate can inject and enter directly. The cruft is every driver, subsystem,
and boot path a microVM never touches.

---

## 1. Provenance & Build Discipline

substrate-kernel does not fork Linux; it maintains a **minimal, ordered patch
series** and a **curated per-(arch, variant) config** against a pinned upstream
tree (§4, [ADR 0007](docs/adr/0007-patch-management-policy.md)). Every divergence
from stock Linux earns its place against §0 and records its provenance.

The discipline for each piece of the build:

- **Cite the contract.** Patch headers and docs cite the upstream Linux commit (or
  the originating series), the boot protocol
  (`Documentation/arch/{x86,arm64}/booting.rst`, the x86/64 `boot.rst`), the virtio
  spec section, or the substrate feature the change enables. A patch whose header
  cannot state a contract is a patch to drop — if you can't cite the contract, you
  don't understand the patch yet.
- **Substrate-native naming everywhere.** File names, the bundle magic, tooling
  names, patch titles, config comments, and prose all use our own names: the
  artifact is a *kernel bundle*, the magic is `SUBK`, the packer is `pack-kernel`,
  the producer is *substrate-kernel*, the consumer is *substrate*. No foreign
  project's names leak into the tree.
- **One patch, one purpose, applied clean.** Each patch has a single stateable
  change, a why-header (intent + provenance + citation), and applies at `-p1` with
  zero fuzz and zero offset against the pinned tree (§6). Prefer config over patch,
  and a backport over an original change.

### Scope — what the kernel must contain (IN)

- **A fast-booting, monolithic, virtio-only kernel** for the substrate guest.
- **Architectures: x86_64 and aarch64** ([ADR 0002](docs/adr/0002-target-architectures.md)).
- **The device drivers substrate's feature contract needs** — virtio block, net,
  vsock (incl. datagrams), console, rng, plus TSI (transparent socket
  interception, in substrate's net contract) and virtio-fs/DAX (substrate's
  optional `--volume` mounts) — a fixed per-variant feature set
  ([ADR 0008](docs/adr/0008-kernel-capability-surface-vs-vmm-scope.md)).
- **Orderly shutdown when the guest entrypoint (PID 1) exits** — a microVM reboots
  cleanly, it does not panic ([design/patches.md](docs/design/patches.md)).
- **The pre-flattened kernel bundle** substrate mmaps and enters directly
  ([ADR 0004](docs/adr/0004-boot-contract-with-substrate.md)).
- **Byte-reproducible builds** ([ADR 0005](docs/adr/0005-build-environment-and-reproducibility.md)).

### Scope — what the kernel must not contain (OUT)

GPU / virtio-gpu / DRM (explicitly cut — substrate has no display path), virtio-CAN
(no substrate consumer), loadable modules, and every driver class a microVM never
sees (USB, sound, most PCI). Confidential-compute (**TEE / SEV / TDX**) is *out of
the base kernel* and lives only behind opt-in build variants
([ADR 0009](docs/adr/0009-confidential-compute-variants.md)); base substrate does
not consume it. The boundary between "capability the kernel carries" and "device
substrate exposes" is [ADR 0008](docs/adr/0008-kernel-capability-surface-vs-vmm-scope.md).

The **riscv64 and windows** configs *are* carried
([ADR 0002](docs/adr/0002-target-architectures.md)) — they are buildable
and golden-tested artifacts, but are **not** substrate boot targets, so CI and
boot-smoke gate only x86_64 + aarch64.

### The patch set — re-derive the deltas, not the world

We do not maintain a kernel fork; we maintain a **minimal, ordered patch series**
against a pinned upstream tree ([ADR 0007](docs/adr/0007-patch-management-policy.md)).
Every patch earns its place against §0: it enables a substrate feature, satisfies
a boot/hardware contract, or fixes a guest-correctness bug. Prefer **config over
patch** (a `CONFIG_*` toggle is auditable and rebases for free; a source patch is
maintenance debt and a rebase hazard). Patches we carry, patches we drop, and the
*why* for each are enumerated in [design/patches.md](docs/design/patches.md).

---

## 2. The Artifact Contract

substrate-kernel produces exactly one kind of artifact: a **kernel bundle**, a
flat binary file substrate consumes with no kernel-image parser of its own. That
dictates the shape:

- **Pre-flattened, header-described.** The build flattens the kernel into a raw
  load image and prepends a fixed-size header carrying the magic, format version,
  abi version, architecture, variant, page size, `load_addr`, `entry_addr`, and the
  byte ranges of the kernel (and optional qboot / initrd) sections
  ([ADR 0003](docs/adr/0003-kernel-bundle-format.md)). substrate mmaps the file,
  reads the header, copies the payload to `load_addr`, and enters at `entry_addr`.
- **The bundle removes image *parsing*, not boot-data *setup*.** substrate still
  builds the architecture's boot data (x86 `boot_params` zero-page / aarch64 FDT +
  ACPI + the kernel command line) and points the entry registers at it. The bundle's
  job is to eliminate the ELF/bzImage/Image parser from the hypervisor's attack
  surface ([ADR 0004](docs/adr/0004-boot-contract-with-substrate.md)).
- **No host-format assumptions.** Sections are 64 KiB-aligned so the same bundle
  maps cleanly under any 4 K / 16 K / 64 K host page size.
- **substrate owns the runtime; the bundle is inert.** No relocation logic, no
  decompression at runtime, no self-extraction — the build does that work once so
  the boot path is a copy and a jump.

---

## 3. Reproducibility Is The Point

A guest kernel that two builds disagree on is a kernel you cannot trust, attest,
or debug. The build is therefore **fully reproducible**: the same pinned source,
patch series, and config produce a **byte-identical** `.kernel` on any host.
These are laws, not aspirations ([ADR 0005](docs/adr/0005-build-environment-and-reproducibility.md)).

- **Pinned source.** The kernel tarball is fetched at a pinned version and
  verified against a checked-in sha256 (`scripts/kernel-pin.env`). A bump is an
  explicit, reviewed change, never a silent "latest."
- **Pinned toolchain.** The compiler, binutils, and build utilities live in a
  digest-pinned container (`tools/build/Dockerfile`). Kernel output is sensitive
  to the toolchain; an unpinned host toolchain makes "reproducible" meaningless.
- **Fixed build metadata.** `KBUILD_BUILD_TIMESTAMP`, `KBUILD_BUILD_USER`, and
  `KBUILD_BUILD_HOST` are fixed constants, and the config disables embedded build
  IDs / timestamps wherever it can, so nothing host- or wall-clock-dependent
  leaks into the image.
- **A reproducibility gate.** `make repro-check` rebuilds from the pin and asserts
  byte-identity with a committed digest of the artifact; divergence fails the
  build. This is the build-system analogue of substrate's determinism law.
- **A pinned upgrade path, not drift.** A drift lane surfaces the newest stable
  point release on the pinned LTS line for explicit opt-in
  ([ADR 0001](docs/adr/0001-kernel-source-pin-and-update-lifecycle.md)); it is
  never adopted automatically.

---

## 4. Architecture Principles

- **The pin is ground truth.** We build a specific upstream release, not a moving
  branch. The version + sha256 are the root of every reproducibility claim.
- **Config over patch.** A capability that a `CONFIG_*` toggle can switch on is
  configured, never patched. Source patches are reserved for changes the config
  cannot express ([ADR 0006](docs/adr/0006-kernel-config-strategy.md),
  [ADR 0007](docs/adr/0007-patch-management-policy.md)).
- **One config per (arch, variant).** x86_64 / aarch64 × base / sev / tdx, each a
  full `.config` normalized by `make olddefconfig`, with the deltas between them
  documented ([design/kernel-config.md](docs/design/kernel-config.md)).
- **The bundle header is the producer↔consumer seam.** It is the one contract
  shared with substrate; it is versioned, size-locked, and golden-tested
  ([ADR 0003](docs/adr/0003-kernel-bundle-format.md),
  [testing/bundle-golden.md](docs/testing/bundle-golden.md)).
- **Capability the kernel carries ≠ device substrate exposes.** The kernel may
  ship a driver substrate does not instantiate; the guest→host security boundary
  is enforced by substrate not creating the device, not by the kernel lacking the
  driver ([ADR 0008](docs/adr/0008-kernel-capability-surface-vs-vmm-scope.md)).

The full pipeline — download → extract → patch → config → compile → pack — its
components, the architecture × variant matrix, and the build-order roadmap live in
[`docs/architecture.md`](docs/architecture.md).

---

## 5. Style law (TigerStyle, adapted to a build system)

Adapted from TigerBeetle's TigerStyle. Priority order, always: **Safety →
Reproducibility → Developer Experience.** ([TIGER_STYLE.md](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md))

### Patches

- **One patch does one thing.** A patch has a single, stateable purpose; if the
  title needs an "and," it is two patches.
- **Surgical and minimal.** Touch the fewest source lines that satisfy the
  contract. A patch that also reformats, renames, or "tidies" is a rebase hazard
  and a review burden — split the incidental change out or drop it.
- **Ordered and clean.** The series applies at `-p1` with **zero fuzz and zero
  offset** against the pinned tree. Fuzz means the patch and the tree have
  drifted — re-derive it, don't let `patch` guess.
- **Every patch carries a why-header** — intent, upstream provenance (commit or
  series), and the contract/spec it satisfies. No identifiers that rot (no plan
  steps, phases, or slice numbers — §below).

### Config

- **Every non-default `CONFIG_*` is deliberate and justified.** The config is
  curated, not inherited from a distro `defconfig`. A toggle whose rationale
  nobody can state is a toggle to revert to default.
- **Disable by default; enable by need.** Start from the smallest bootable kernel
  and add only what substrate's feature contract requires. No modules
  (`CONFIG_MODULES=n`) — a microVM image is monolithic.
- **Bounded resources are named constants.** `CONFIG_NR_CPUS` and similar caps are
  set to substrate's actual limits, not left at distro maxima that bloat the image.

### Tooling (Makefile / scripts / packer)

- **Simple, explicit, bounded.** The Makefile has one obvious path per target; the
  packer is a small, readable script with no hidden state.
- **The packer asserts its own layout.** The header struct size is asserted
  against its declared size at startup (`struct.calcsize(...) == HEADER_SIZE`),
  section offsets are asserted page-aligned and non-overlapping, and a payload
  that would overlap the next section is a hard error, never a silent truncation.
- **No magic numbers.** The magic, version, arch/variant IDs, page-alignment, and
  load addresses are named constants with a citation, not literals sprinkled
  through the code.

### Naming & comments

- **Precise, no abbreviations, substrate-native names.** `kernel_offset`,
  `entry_addr`, `page_size` — not `koff`, `ent`, `psz`.
- **Explain *why*, never the *what*.** A config comment states the substrate
  feature or contract a toggle serves; a patch header states the bug or capability
  it addresses. The *what* is in the diff.
- **No plan-step, task, PR, milestone, phase, or build-order identifiers** — in
  patches, config comments, scripts, *or* docs (`T4-1`, `PR-2`, `Phase 3`,
  `slice 4`, "since slice 3"). They rot. **Name the thing instead** — the feature,
  the contract, the spec section, the ADR. The build-order roadmap
  ([architecture.md](docs/architecture.md) §7) is the *one* place that enumerates
  build steps, and it names them by deliverable.

### Zero technical debt

A patch that "mostly applies," a config toggle "we'll explain later," a TODO in
the packer — solve it now (§9). An hour of curation saves a day of rebase.

---

## 6. Patch Discipline

A guest kernel's patch series is the highest-leverage and highest-risk surface in
this repo: a bad patch is a guest that miscomputes, a boot that hangs, or a
security regression the host inherits. So:

- **The series is the source of truth, the tree is derived.** We check in the
  ordered patches and the pin, never a forked kernel tree. The build reconstructs
  the patched tree from `pin + patches`.
- **Every patch applies clean and is justified** (§5). Provenance is recorded: an
  upstream backport cites its mainline commit; an original change cites the
  contract it satisfies and is written to be upstreamable in spirit.
- **Prefer backports and config to original patches.** An original source patch is
  a standing maintenance cost across every version bump; minimize the count.
- **A version bump re-validates the whole series.** Bumping the pin
  ([ADR 0001](docs/adr/0001-kernel-source-pin-and-update-lifecycle.md)) means
  re-deriving any patch that no longer applies clean — never forcing it with fuzz.
- **TEE patches are quarantined.** The confidential-compute series is a separate,
  opt-in set that never touches a base build
  ([ADR 0009](docs/adr/0009-confidential-compute-variants.md)).

The carried series, grouped by theme with a keep/drop rationale for each, is
[design/patches.md](docs/design/patches.md).

---

## 7. Documentation Requirements

Documentation is part of the work, not an afterthought — *the design is how it
builds.*

- **Architecture Decision Records** in `docs/adr/` ([index](docs/adr/README.md)),
  named `NNNN-title.md`, one per significant decision: **context → decision →
  consequences → alternatives considered**, with a `Status` / `Date` / `Context
  doc` header. The accepted ADRs fix the source pin, the architectures, the bundle
  format, the boot contract, reproducibility, the config strategy, the patch
  policy, the capability/scope boundary, the TEE variants, and the doc-loading
  manifest — read them before revisiting those.
- **Design documents** in `docs/design/` ([index](docs/design/README.md)): each
  build component (the pipeline, the bundle format, the config, the patch series,
  the initramfs, reproducibility) carries a doc that records
  the subtle/security-critical details, and states our design and its
  verification — written *before* the corresponding build code lands.
- **Spec / upstream citations** inline wherever a patch or config implements a
  contract.
- **Docs evolve with the build — in the same change.** When a patch is added or
  dropped, a config toggle flipped, the pin bumped, or the bundle format revised,
  the matching doc and any ADR it realizes or revises change in the same PR. A doc
  that no longer matches the build is a bug.

---

## 8. Verification

Pick the gate that catches the failure class. A kernel *build* fails differently
from a Rust library, so the gates are build-shaped — but the philosophy
(assertion-dense, deterministic, no silent skips) is substrate's. The
authoritative plan is [`docs/testing/strategy.md`](docs/testing/strategy.md).

- **Patches apply clean** — the series applies at `-p1` with zero fuzz against the
  pin; a fuzzed or rejected hunk fails the build (not a manual fix-up).
- **Config invariants** — required `CONFIG_*` are present and forbidden ones
  absent after `make olddefconfig`, asserted per (arch, variant)
  ([testing/strategy.md](docs/testing/strategy.md)). A silent `olddefconfig` drop
  of a required option is caught here, not at guest boot.
- **Bundle golden** — the header layout and field encoding are golden-tested so
  format drift fails the build ([testing/bundle-golden.md](docs/testing/bundle-golden.md)).
- **Reproducibility** — `make repro-check` proves byte-identical rebuilds (§3).
- **Boots under substrate** — the irreducible remainder: a real guest boots from
  the produced `.kernel` under substrate on KVM (Linux) and HVF (macOS), reaching
  userspace and exercising the wired virtio devices
  ([testing/boot-smoke.md](docs/testing/boot-smoke.md)).
- **Budgets** — image size and boot-to-userspace time are tracked against named
  budgets ([architecture.md](docs/architecture.md),
  [testing/strategy.md](docs/testing/strategy.md)); a regression is a review
  signal, not an automatic failure.

**Tests panic on missing resources — they never silently skip.** A missing pin,
toolchain image, or substrate fixture is a hard failure with a remediation hint,
never a `[skip]`.

---

## 9. Operational Rules

These carry over from substrate and are binding here.

- **Think before building.** State assumptions; surface tradeoffs; if a patch or
  config choice has multiple defensible forms, present them — don't pick silently.
  When a build breaks, find the root cause (read the actual `patch`/`kbuild`
  failure, form a hypothesis) before changing anything. Never try random toggles.
- **Simplicity first.** The smallest config and the fewest patches that satisfy
  the contract. If the series grew to twenty patches and ten would do, cut ten.
- **Surgical changes.** Touch only what the task requires; match the surrounding
  style; clean up only the orphans your change created.
- **Prefer config to patch, backport to original** (§6). The cheapest change that
  satisfies the contract wins.
- **No deferral.** No "mostly applies," no stub patch, no "explain this toggle
  later." Deferral requires an explicit, tracked, human-approved opt-in.
- **Always tee build/test output**, then read the log — never re-run a multi-
  minute kernel build just to see its output again.
- **No AI attribution in commits or PRs.** Never add a `Co-Authored-By: Claude …`
  trailer (or any Claude / Claude Code co-author) to a commit, and never add a
  "Generated with Claude Code" line to a commit message or PR body. This rule
  overrides any default harness behaviour to the contrary.

---

## 10. Required Context (auto-loaded)

The `docs/` tree is the build's design of record (§7), and §0 makes acting with
full understanding a gate. So **every doc is imported into context here** via the
`@`-import syntax, which loads each file's contents whenever this constitution is
read. The prose links throughout the sections above stay as ordinary Markdown
links for humans — this manifest is the machine-readable loader beside them.
[ADR 0010](docs/adr/0010-auto-loaded-doc-context.md) records why this is a flat
list (every doc at import depth 1). `scripts/check-doc-manifest.sh` is the §8
"defense in depth" gate that fails the build if this manifest is not exactly every
`docs/**/*.md` — so a new doc is not done until its line is added here.

Do not wrap these paths in backticks or a fenced code block: an `@`-import inside
a code span or code fence is ignored, which would silently drop the file.

### Architecture (top level)
@docs/architecture.md

### Architecture Decision Records (docs/adr/)
@docs/adr/0001-kernel-source-pin-and-update-lifecycle.md
@docs/adr/0002-target-architectures.md
@docs/adr/0003-kernel-bundle-format.md
@docs/adr/0004-boot-contract-with-substrate.md
@docs/adr/0005-build-environment-and-reproducibility.md
@docs/adr/0006-kernel-config-strategy.md
@docs/adr/0007-patch-management-policy.md
@docs/adr/0008-kernel-capability-surface-vs-vmm-scope.md
@docs/adr/0009-confidential-compute-variants.md
@docs/adr/0010-auto-loaded-doc-context.md
@docs/adr/0011-download-proxy-with-analytics.md
@docs/adr/0012-listing-page-web-analytics-and-correlation.md
@docs/adr/README.md

### Component design notes (docs/design/)
@docs/design/README.md
@docs/design/build-pipeline.md
@docs/design/bundle-format.md
@docs/design/download-proxy.md
@docs/design/kernel-config.md
@docs/design/patches.md
@docs/design/initramfs.md
@docs/design/reproducibility.md

### Verification (docs/testing/)
@docs/testing/README.md
@docs/testing/strategy.md
@docs/testing/boot-smoke.md
@docs/testing/bundle-golden.md

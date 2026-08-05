# Substrate Kernels

**substrate-kernels** is the build system that produces the `.kernel` artifact —
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

substrate-kernels does not fork Linux; it maintains a **minimal, ordered patch
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
  the producer is *substrate-kernels*, the consumer is *substrate*. No foreign
  project's names leak into the tree.
- **One patch, one purpose, applied clean.** Each patch has a single stateable
  change, a why-header (intent + provenance + citation), and applies at `-p1` with
  zero fuzz and zero offset against the pinned tree (§6). Prefer config over patch,
  and a backport over an original change.

### Scope — what the kernel must contain (IN)

- **A fast-booting, monolithic, virtio-only kernel** for the substrate guest.
- **Architectures: x86_64 and aarch64** ([ADR 0002](docs/adr/0002-target-architectures.md)).
- **The device drivers substrate's feature contract needs** — virtio block, net,
  vsock streams, console, rng, and DAX-less virtio-fs (substrate's
  optional volume mounts) — a fixed per-variant feature set
  ([ADR 0008](docs/adr/0008-kernel-capability-surface-vs-vmm-scope.md)). (Kernel-side
  TSI was carried but has since been dropped — [ADR 0015](docs/adr/0015-drop-tsi-and-x86-acpi-legacy-pic.md).)
- **Orderly shutdown through `init.substrate`** — the default mode keeps the
  supervisor as PID 1, reaps the entrypoint, reports its status, and invokes
  `reboot(2)`; stock Linux PID-1 panic semantics remain intact for direct-exec
  systemd-style guests ([design/patches.md](docs/design/patches.md)).
- **The pre-flattened kernel bundle** substrate mmaps and enters directly
  ([ADR 0004](docs/adr/0004-boot-contract-with-substrate.md)).
- **Byte-reproducible builds** ([ADR 0005](docs/adr/0005-build-environment-and-reproducibility.md)).

### Scope — what the kernel must not contain (OUT)

GPU / virtio-gpu / DRM (explicitly cut — substrate has no display path), virtio-CAN
(no substrate consumer), virtio-fs DAX (substrate exposes no shared-memory window),
virtio-RTC (substrate exposes PL031 on arm64 and architectural clocks), loadable
modules, and every driver class a microVM never sees (USB, sound, most PCI).
Confidential-compute (**TEE / SEV / TDX**) is out: substrate has no corresponding
machine model, and the old deferred variants were never releasable
([ADR 0009](docs/adr/0009-confidential-compute-variants.md)). The boundary between
"capability the kernel carries" and "device
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

substrate-kernels produces exactly one kind of artifact: a **kernel bundle**, a
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
  verified against a checked-in sha256 (`scripts/kernel-pins/<line>.env`). A bump is an
  explicit, reviewed change, never a silent "latest."
- **Pinned toolchain.** The compiler, binutils, and build utilities are Nix store
  paths fixed by `flake.lock`, and the compile runs in the Nix sandbox, which
  admits only declared inputs ([ADR 0005](docs/adr/0005-build-environment-and-reproducibility.md)).
  Kernel output is sensitive to the toolchain; an unpinned host toolchain makes
  "reproducible" meaningless.
- **Fixed build metadata.** `KBUILD_BUILD_TIMESTAMP`, `KBUILD_BUILD_USER`, and
  `KBUILD_BUILD_HOST` are fixed constants, and the config disables embedded build
  IDs / timestamps wherever it can, so nothing host- or wall-clock-dependent
  leaks into the image.
- **A reproducibility gate.** `just repro-check` realizes a cell — by substitution
  when the org cache holds it — and `nix build --rebuild` then compiles it locally
  and fails if a single byte differs, so on a substituted path the gate also proves
  the cache serves exactly what this commit's source builds. This is the
  build-system analogue of substrate's determinism law.
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
- **One config per (arch, variant).** x86_64 / aarch64 × base / debug, each a
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

### Tooling (flake / Justfile / scripts / packer)

- **Simple, explicit, bounded.** The flake declares one derivation per pipeline
  output, every `just` verb is a thin alias over a flake output
  ([ADR 0017](docs/adr/0017-nix-build-and-flake-interface.md)), and the packer is a
  small, readable script with no hidden state.
- **The packer asserts its own layout.** The header struct size is asserted
  against its declared size at startup (`struct.calcsize(...) == HEADER_SIZE`),
  section offsets are asserted page-aligned and non-overlapping, and a payload
  that would overlap the next section is a hard error, never a silent truncation.
- **No magic numbers.** The magic, version, arch/variant IDs, page-alignment, and
  load addresses are named constants with a citation, not literals sprinkled
  through the code.

### Names

Precise, unabbreviated, substrate-native: `kernel_offset`, `entry_addr`, `page_size`,
never `koff`, `ent`, `psz`. The vocabulary is the build's own: the pin, the patch
series, the config file, the bundle, the packer, the variant.

### Comments, documentation, and commit messages

Comments explain why the change is the way it is; the diff and the config line already
say what changed. State the contract, invariant, or hazard the change answers, and cite
the spec section, upstream commit, or ADR it comes from.

Write for one specific reader: an engineer who has not read your reasoning, was not in
your session, and arrives in six months with a bug and no context. That reader is the
audience for every comment, patch header, doc, and commit message here. An agent
reading it back later is a secondary audience, and writing for that agent at this
reader's expense is a defect, in the same way an unjustified patch is a defect.

The failure to avoid is not verbosity. It is compression that removes the part the
reader needed. A sentence can be short, correctly punctuated, grammatical, and still
useless, because it asserts that something is true without saying how or why. Length is
not the constraint. Completeness is.

**Run these seven tests on every explanatory sentence you write. They take seconds and
they are not optional.**

**1. The mechanism test.** For each sentence that makes a claim, point at the words that
say *how* or *why*. Those words are usually "because", "so", "which means", "by doing
X", or the name of a specific artifact, symbol, or value. If no such words are present,
you have written a conclusion and withheld the reason, which is the part the reader did
not already have. Write the longer sentence.

    Fails:  CONFIG_MODULES is disabled.
    Passes: CONFIG_MODULES=n, because substrate injects one immutable image and offers
            no runtime code-loading path, so a module loader would be dead code in
            every guest and an attack surface nothing legitimate uses.

**2. The short-sentence test.** This one applies to sentences that make a claim about
how something works. Short instructions are fine and often clearer than long ones:
"Reject it." and "Read the header." need no expansion. The test is for the claim that is
short, balanced, and quotable, and that names nothing concrete. If a claim runs under
about twelve words and contains no identifier, no number, and no "because", "so", or
"which", it is almost certainly an aphorism standing in for an explanation. Aphorisms
feel like insight while you write them and carry a fraction of the information. Expand
it into the explanation.

    Fails:  The pin is ground truth.
    Passes: Every build starts from the exact tarball scripts/kernel-pins/<line>.env
            names, verified against its recorded sha256 before extraction, so two
            builds of the same commit cannot begin from different sources.

    Fails:  Zero fuzz is a law.
    Passes: `patch` accepts a drifted hunk by guessing an offset, and the guess can
            land a change in the wrong place while still reporting success, so the
            build refuses any fuzz or offset and a stale patch is re-derived by a
            person rather than placed by a guess.

**3. The actor test.** The subject of the sentence must be something that acts. Guests,
drivers, scripts, build stages, gates, and people act; separations, disciplines,
considerations, and reproducibility do not. If the subject is an abstraction, find the
thing that is actually doing something and start the sentence there.

    Fails:  Reproducibility is the whole trust story.
    Passes: `just repro-check` rebuilds the bundle from the pin and compares its bytes
            against the first build's, so a host dependency that leaked into the
            image fails the gate on any machine other than the author's.

**4. The grammar test.** Three checks on the shape of the sentence. Each one silently
removes an actor or a fact.

- **Actions stay verbs.** If an action appears as a noun, turn it back into a verb or a
  gerund and reattach whoever performs it. "The header assertion is what catches format
  drift" becomes "the packer asserting its header size at startup is what catches
  format drift before a byte is written". A nominalisation is how a sentence loses its
  actor without looking wrong.
- **A new fact gets its own subject.** Do not hang it off a `which` that refers to the
  previous clause, and do not turn the actor into something that is being acted upon.
  "verifies the sha256 first, which prevents building from a tampered tarball" becomes
  "verifies the sha256 first, and a tampered tarball therefore fails before
  extraction". A chain of subordinated facts produces a sentence the reader parses
  instead of follows.
- **The connective states the relation.** Use "because", "so", or "therefore" where the
  relation is causal, and reserve "then" for sequence. "The build then rejects the
  patch" loses the reason; "the build therefore rejects the patch" keeps it.

**5. The naming test.** Once you have named a thing or an action, use that name every
time. If sentence one says the packer "asserts the layout", sentence two does not say
"the sanity pass validates the shape": the reader has to work out that these are the
same event, and paying that cost repeatedly is what makes a paragraph exhausting.
Varying your vocabulary is a habit from prose where repetition is a fault. In technical
writing repetition is correct.

Attach the actor to the noun as well. "The config" is ambiguous in this repo, because
the curated `.config` file, the `just configured` gate, and the configure stage of the
pipeline are all called that; write "the config file" or "the config gate". "The build"
is ambiguous between one compile stage and the whole pipeline. A bare noun where the
reader has to supply the actor is the same defect as a missing mechanism.

**6. The precision tests.** Three habits that cost facts rather than clarity, so they
matter more than any of the surface rules:

- **Get the causation right.** "Allows", "lets", and "removes the reason for" are
  different claims from "makes", "forces", and "causes". Bumping the pin does not force
  a patch to be re-derived; it makes any patch that no longer applies clean fail the
  build, and that failure is what forces the re-derivation. Overstated causation is the
  kind of error a reader who knows the subsystem will catch, and it costs you their
  trust in the rest of the text.
- **Finish the path.** If a value moves, say where it ends up. "Copies the payload"
  gives an action; "copies the payload to `load_addr` in guest memory" names the
  destination. If you are claiming something was observed all the way through, say so:
  "end to end".
- **Keep the word that separates reported from observed.** This is the exception to
  cutting intensifiers. "The options actually present after `olddefconfig`" is not
  emphasis, because normalization silently drops a symbol whose dependencies are
  unmet, so the config we wrote and the config that survives are different objects.
  When "actually", "really", or "after normalization" marks the difference between a
  claim and a measurement, it is carrying the point of the sentence.

**7. The article test.** A definite article promises the reader that the noun has been
introduced. "The series applies clean" on first mention promises an antecedent that
does not exist, and the sentence reads as a continuation of a thought the reader never
heard. Write "each per-line patch series under `patches/<line>/` applies clean" first,
then "the series" once it exists.

Four more rules about words, which follow from the same principle:

- **Introduce a term before you lean on it, or use ordinary words instead.** "The
  seam", "the cell", and "the drift lane" mean something only to whoever coined them.
  Write "the header format substrate and the packer share" until the shorter name has
  been defined in the file. Once a term is defined, repeat it exactly rather than
  varying it for interest.
- **Repeat the full noun phrase.** Never give one thing two names, and do not clip a
  noun when the short form is ambiguous. Write "the patch series", "the config gate",
  and "the repro gate" rather than "the series", "the gate", and "the check" wherever
  a reader could mistake which one you mean.
- **Qualify a claim that is not absolute.** "Most carried patches" rather than "the
  patches". A reader who can name one counterexample to an overstated claim stops
  trusting the rest of the text.
- **Say what is true rather than contrasting it with what is not.** "X, not Y" and "it
  isn't A, it's B" are rhetoric carrying half the information of a direct statement.
  At most one such contrast per document, and only where it corrects a specific
  misunderstanding you have named.

Four rules about form, in one place because they matter less than the seven tests. They
apply to prose; a table cell and a heading are legitimately not sentences:

- Write complete sentences, including in comments. No verbless fragments.
- No arrow chains such as `patch → config → fails` in prose, no slash-stacks, and no
  hyphen-stacked compounds invented to avoid writing a clause. A pipeline diagram in a
  doc is a diagram; a sentence is not.
- No bold or italics inside a sentence, and no capital letters for emphasis.
  `CONFIG_MODULES` and `SUBK` are identifiers and stay as they are; writing `NEVER` or
  `ZERO FUZZ` for emphasis is shouting. If a point needs emphasis, give it a short
  sentence of its own.
- One idea per sentence, and a topic sentence at the front of each paragraph. Two
  claims joined by "and" or "so" are two sentences. A paragraph past five sentences is
  two topics.

**The stranger pass, required before you finish.** Reread every sentence you wrote and
ask four questions about each one.

1. Could a reader without your context tell *how* this works from this sentence alone?
2. Would they have to read it twice?
3. Does every action in it still have the actor attached, and is every action still a
   verb?
4. Have I called anything by a second name since the last sentence?

Where the answer to the first is no, or any of the others is yes, rewrite the sentence.
This pass is part of writing the comment, in the same way that running the gate is part
of writing the patch. The evidence that you ran it is the rewritten sentence in the
diff, not a sentence in the pull request claiming you did.

**Do not imitate the prose style of this file.** The constitution is a rulebook written
to be scanned quickly, and much of it was written before these rules existed. Its
density is not the target, and matching its voice is how this failure keeps
reproducing.

**When you edit a paragraph, fix its prose.** If you touch a doc, a patch header, or a
comment, the paragraphs you touch come out obeying the rules above, even when the prose
was not what you were there to change. This is the exception to the surgical-change
rule in §9, and it exists because §10 loads every one of these documents into every
session: as long as the old register is in the context, it keeps being reproduced.

A config comment that meets the bar:

```
# why: olddefconfig resolves every unspecified symbol to its default and silently
# drops a symbol whose dependencies are unmet, so a required option can vanish from
# the config file without any error. config-invariant.py re-asserts the required and
# forbidden sets after normalization, because the failure it catches would otherwise
# surface as a guest that boots without a device substrate expects (§8).
```

A patch why-header that meets the bar:

```
why: a container entrypoint that exits leaves stock Linux panicking over a dead PID 1,
and substrate would read that panic as a guest fault rather than a clean exit.
init.substrate stays PID 1, reaps the entrypoint, reports its exit status to the
supervisor, and then invokes reboot(2), so substrate observes an orderly shutdown
carrying the status the workload actually returned. Stock PID-1 panic semantics are
preserved for direct-exec guests that boot systemd (docs/design/patches.md, ADR 0008).
```

Also forbidden in comments, patch headers, and commit messages: any plan-step, task,
pull request, milestone, phase, or build-order identifier (`T4-1`, `PR-2`, `Phase 3`,
`slice 4`, "since slice 3"). They rot, because once the work has landed "phase 3" is a
meaningless label and a reader six months out cannot recover what it meant. Name the
feature, the contract, the spec section, or the ADR instead.

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
- **Unsupported patches do not live here as inventory.** The old confidential-
  compute series was removed because substrate has no matching SEV-SNP/TDX
  machine model or boot path ([ADR 0009](docs/adr/0009-confidential-compute-variants.md)).
  Reintroducing it requires a bootable end-to-end feature, not compile-only files.

The carried series, grouped by theme with a keep/drop rationale for each, is
[design/patches.md](docs/design/patches.md).

---

## 7. Documentation Requirements

Documentation is part of the work. A change is not done until the doc that describes
the affected component matches the build again, because §10 loads these documents into
every session and a stale doc misleads every session that follows.

**The documentation is written for people.** The seven tests and the stranger pass in
§5 apply to every doc under `docs/`, every patch why-header, every config comment, and
every commit message. Length is not the constraint: a doc may be long where the reader
needs the detail, and may not be compressed to the point where the reader has to
reconstruct the reasoning behind it.

A doc that only its author can read has failed §7 even when every fact in it is
correct, because the purpose of the design of record is to let another engineer act
without rebuilding the context that produced it.

- **Architecture Decision Records** in `docs/adr/` ([index](docs/adr/README.md)),
  named `NNNN-title.md`, one per significant decision: **context → decision →
  consequences → alternatives considered**, with a `Status` / `Date` / `Context
  doc` header. The accepted ADRs fix the source pin, the architectures, the bundle
  format, the boot contract, reproducibility, the config strategy, the patch
  policy, the capability/scope boundary, the removal of the former TEE variants,
  and the doc-loading manifest — read them before revisiting those.
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
- **Reproducibility** — `just repro-check` proves byte-identical rebuilds (§3).
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
- **Run the stranger pass before you ship prose.** Take each sentence in a patch
  header, config comment, doc, or commit message and check it against the seven
  tests in §5. A sentence that states a conclusion without its mechanism is not a
  style preference to weigh; it is incomplete, and it is finished the same way a
  patch that does not apply is finished.
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
@docs/adr/0013-debug-variant.md
@docs/adr/0014-container-runtime-networking.md
@docs/adr/0015-drop-tsi-and-x86-acpi-legacy-pic.md
@docs/adr/0016-release-provenance-attestation.md
@docs/adr/0017-nix-build-and-flake-interface.md
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

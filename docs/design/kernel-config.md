# Design: the kernel config

The curated, monolithic, virtio-only `.config` per (arch, variant)
([ADR 0006](../adr/0006-kernel-config-strategy.md)). This doc records *what* is
enabled/disabled and *why*, and the deltas between cells. It is the place a
reviewer confirms the image is the smallest thing that supports substrate's feature
contract.

## Background

The per-arch configs (`config-{base,debug}_{x86_64,aarch64}` plus carried
riscv64-base and x86_64-windows cells) are monolithic (`CONFIG_MODULES=n`). They
enable only substrate's virtio device set, ext4/overlay/tmpfs boot support,
DAX-less virtio-fs, bounded CPU topology, and the networking surface needed by a
container guest. The removed SEV/TDX configs, virtio-RTC, virtio-fs DAX, GPU, CAN,
and emulation-only arm64 TSO controls are explicit forbidden invariants rather
than dormant promises.

## Subtle details & gotchas

| Detail | Convention | Our handling | Gate |
|---|---|---|---|
| **`olddefconfig` resolves changed deps silently** — a required option can vanish at a version bump | runs `olddefconfig` | run it, then assert the required/forbidden set per cell | config-invariant gate |
| **`NR_CPUS` left high = image bloat** | bounded (left high by default) | set to substrate's max vCPU count, with the number cited | config-invariant gate (exact value) |
| **PCI policy** — disabling PCI entirely breaks some x86 ACPI paths | PCI disabled; ACPI patched to cope ([patches.md](patches.md) ACPI fixes) | match: PCI off where possible + the x86 ACPI hypervisor patches; document the coupling | boot-smoke (x86) |
| **DRM/framebuffer pulls in a large subsystem** | GPU configs enabled | **disabled** — GPU is cut (CLAUDE.md §1) | config-invariant gate (forbidden set) |
| **Reproducibility-hostile config** — embedded build IDs/timestamps | (relies on `KBUILD_BUILD_*`) | also disable embedded IDs/timestamps in config where possible ([ADR 0005](../adr/0005-build-environment-and-reproducibility.md)) | `make repro-check` |
| **Unsupported features must not look releasable** | inherited configs carried deferred features | SEV/TDX, virtio-RTC, FUSE DAX, and emulation-only arm64 ACTLR state are forbidden in every current release cell | config-invariant forbidden set |
| **Container-runtime netfilter must survive `olddefconfig`** — a container engine programs a broad netfilter/bridge set; a dropped `xt_addrtype` or masquerade target makes dockerd fail to register its bridge driver | (ungated) | assert the Docker-required netfilter/bridge/NAT set on `base`/`debug`; note `BRIDGE_VLAN_FILTERING` *depends on* `VLAN_8021Q` and `IP6_NF_TARGET_MASQUERADE` *depends on* `IP6_NF_NAT` (enable each dep in the same pass) ([ADR 0014](../adr/0014-container-runtime-networking.md)) | config-invariant gate |

## Our design

**Enabled (the substrate device set + supporting subsystems):**

- **Virtio core + transport:** `VIRTIO`, `VIRTIO_MMIO` (the transport substrate's
  `mmio` crate drives).
- **Devices substrate wires:** `VIRTIO_BLK`, `VIRTIO_NET`, `VIRTIO_VSOCKETS`,
  `VIRTIO_CONSOLE`, `HW_RANDOM_VIRTIO` (rng), `VIRTIO_BALLOON` (dynamic guest memory
  reclaim / overcommit, selecting `MEMORY_BALLOON`; paired with `PAGE_REPORTING` so
  the guest reports free pages back to the host). (Kernel-side `TSI` was carried via
  its patch's config symbol but has since been dropped —
  [ADR 0015](../adr/0015-drop-tsi-and-x86-acpi-legacy-pic.md).)
- **Optional substrate capabilities:** `FUSE_FS` + `VIRTIO_FS` for `--volume`
  mounts, never rootfs. substrate exposes no shared-memory window and rejects
  FUSE mapping requests, so `FUSE_DAX=n`. Timekeeping comes from PL031 on arm64
  and KVM clock/ACPI on x86; substrate has no virtio-RTC device.
- **Filesystems / boot essentials:** `OVERLAY_FS`, `TMPFS`, `DEVTMPFS` (+ auto
  mount), `EXT4_FS` (the production rootfs is a sparse ext4 disk — substrate
  architecture.md §1). `BLK_DEV_INITRD` is **enabled** in every variant — base
  bundles still ship no baked initrd (the bundle's initrd section is absent), but
  the kernel keeps the initrd boot path available so substrate can hand it one at
  run time when needed (e.g. for early userspace before the ext4 rootfs is
  mounted).
- **CPU:** `HOTPLUG_CPU`; `NR_CPUS` bounded to substrate's max (value cited in the
  config comment).
- **Guest-side KVM (every variant):** `VIRTUALIZATION` + `KVM` (x86_64 adds both
  vendor backends, `KVM_INTEL` + `KVM_AMD`; aarch64/riscv64 use the arch-native
  `KVM`), so a substrate guest can itself host KVM VMs when the host exposes
  virtualization extensions to the guest (nested virtualization). Inert without
  that exposure — with no VMX/SVM/EL2 available, KVM's init finds no hardware
  support and provides no `/dev/kvm`, the same carried-capability principle as an
  unwired virtio driver ([ADR 0008](../adr/0008-kernel-capability-surface-vs-vmm-scope.md)).
  Dependent sub-options take the pin's `olddefconfig` defaults (`KVM_SMM`/
  `KVM_HYPERV` on, `KVM_XEN`/`KVM_WERROR` off, `KVM_MAX_NR_VCPUS=1024` on x86).

**Disabled (microVM-irrelevant or cut):**

- **`MODULES=n`** — monolithic image.
- **GPU/DRM/framebuffer** — cut (CLAUDE.md §1).
- **USB, sound, most PCI, audit, legacy input** — a microVM never sees these.
  `CONFIG_SOUND` is cut explicitly; with no sound device wired, the core would
  initialize for nothing.
- **GPU/CAN, virtio-RTC, and FUSE DAX** — no substrate device or shared-memory
  contract exists for them ([design/patches.md](patches.md)).
- **SEV/TDX guest support and arm64 ACTLR memory-model controls** — substrate has
  neither a confidential-compute machine model nor a cross-architecture emulator.
- **Btrfs** — `CONFIG_BTRFS_FS=n`. The substrate rootfs is ext4 and
  CoW/snapshotting is the VMM's responsibility (substrate architecture.md §1);
  Btrfs adds image size + an `lib/raid6/` boot-time benchmark for no live
  consumer.
- **FAT / VFAT / MSDOS + NLS** — `CONFIG_FAT_FS=n` and `CONFIG_VFAT_FS=n`. No
  FAT mount path exists (rootfs is ext4, optional mounts are virtio-fs); the
  whole NLS codepage chain (CP437, …) is dropped with the FAT cuts.
- **ftrace family** — `CONFIG_FTRACE=n` in base. Tracing/probing/BPF-events
  lives in the **debug variant** ([ADR 0013](../adr/0013-debug-variant.md));
  base stays curated-minimal so production boots do not pay the ~170 KB
  dyn_ftrace tables + boot-time scan.
- **CMA** — `CONFIG_CMA=n` (including on aarch64, where it had been set to
  64 MiB). A virtio-only guest has no contiguous-DMA consumer; reserving the
  pool is wasted guest RAM.
- **EROFS** — `CONFIG_EROFS_FS=n` everywhere. The substrate rootfs is ext4;
  EROFS adds an unused read-only-fs codepath (including the optional zip/zstd
  decompressors when `EROFS_FS_ZIP=y`).
- **CRYPTO_USER family** — `CONFIG_CRYPTO_USER=n` and the entire
  `CONFIG_CRYPTO_USER_API*` family (hash, skcipher, rng, aead, the obsolete
  algos toggle). The netlink crypto management surface and the AF_ALG
  userspace crypto API have no substrate-guest consumer; algorithms are still
  available to the kernel via the in-kernel crypto API.
- **aarch64 board ballast** — `CONFIG_I2C`, the platform-specific GPIO
  drivers (`GPIO_AGGREGATOR`/`PCA*`/`MAX*`/etc., keeping only `GPIOLIB`,
  `GPIOLIB_IRQCHIP`, `GPIO_PL061` for the gpio-keys restart-button path),
  `CONFIG_MTD` + the NAND/CFI chain, the `CONFIG_MFD_*` PMIC driver tree,
  `CONFIG_RMI4_*` (Synaptics touchpad), and the `CONFIG_BATTERY_*` charger
  drivers. A microVM guest has no bus controllers, flash, PMIC, touchpad, or
  battery; these are pure inherited board-config drift. Same set applies to
  riscv64 base.

**Per-cell deltas** (documented so duplication stays legible —
[ADR 0006](../adr/0006-kernel-config-strategy.md) §5):

- **x86_64 vs aarch64 vs riscv64:** arch core options; the x86 ACPI options
  (`CONFIG_PVH=y` is carried as a kernel capability, but the boot path is the 64-bit
  `boot_params` entry, not PVH — [ADR 0004](../adr/0004-boot-contract-with-substrate.md));
  the aarch64 timer/GIC/PL031 options. The old Apple TSO/memory-model additions
  were removed with their patches ([patches.md](patches.md)).
- **base vs windows (x86 only):** the windows cell adds Hyper-V enlightenments
  (`CONFIG_HYPERV*`) and is packed at 4 KiB
  ([ADR 0002](../adr/0002-target-architectures.md)). SEV/TDX are not cells.
- **base vs debug** (x86_64, aarch64 — [ADR 0013](../adr/0013-debug-variant.md)):
  the debug cell adds tracing (`CONFIG_FTRACE`, `CONFIG_FUNCTION_TRACER`,
  `CONFIG_FUNCTION_GRAPH_TRACER`, `CONFIG_DYNAMIC_FTRACE`,
  `CONFIG_FTRACE_SYSCALLS`, `CONFIG_STACK_TRACER`), probes (`CONFIG_KPROBES`,
  `CONFIG_KPROBE_EVENTS`, `CONFIG_UPROBE_EVENTS`; x86 also `CONFIG_OPTPROBES`),
  BPF tracing (`CONFIG_BPF_EVENTS`, `CONFIG_BPF_JIT`,
  `CONFIG_BPF_JIT_ALWAYS_ON`), and source-level debug
  (`CONFIG_DEBUG_INFO_DWARF5`, `CONFIG_DEBUG_INFO_BTF`, `CONFIG_GDB_SCRIPTS`).
  The cuts above (Btrfs, SOUND, FAT/NLS, CMA on aarch64) stay cut in debug.
- **guest-model cells vs windows:** the container-runtime networking surface
  (netfilter/bridge/NAT — see below) is carried on `base`/`debug` (x86_64, aarch64)
  and `base` (riscv64), and is **absent** on the windows variant
  ([ADR 0014](../adr/0014-container-runtime-networking.md)).

**eBPF + XDP guarantees** (every variant; the gate enforces them):

- `CONFIG_BPF=y`, `CONFIG_BPF_SYSCALL=y`, `CONFIG_CGROUP_BPF=y` everywhere — so
  BPF programs load and attach to cgroups in every variant.
- `CONFIG_XDP_SOCKETS=y` in the variants that ship as the substrate guest
  model (`base`, `debug`) — so userspace can attach XDP programs to
  virtio-net. windows does not require XDP.
- `CONFIG_BPF_JIT=y` is in **debug** only — JIT depends on tracing surface
  the base variant does not carry, and the BPF interpreter is sufficient for
  base's expected workloads.

**BPF parity additions** (every variant): `CONFIG_BPF_PRELOAD=y` and
`CONFIG_BPF_PRELOAD_UMD=y` (kernel BPF program preloading via the userspace
helper), `CONFIG_BPF_STREAM_PARSER=y` (BPF sockmap stream parser),
`CONFIG_BPF_UNPRIV_DEFAULT_OFF=y` (hardening: defaults
`kernel.unprivileged_bpf_disabled=1`). These match Firecracker's guest-kernel
posture. `CONFIG_BPFILTER` was removed from upstream Linux before our 6.12
pin so it is no longer a valid symbol.

**Container-runtime networking (netfilter / bridge / NAT)** — carried on the
guest-model cells (`base`/`debug` on x86_64 & aarch64, plus `base` on riscv64), so a
substrate guest can run a container engine (`dockerd`/`containerd`) with its default
bridge network ([ADR 0014](../adr/0014-container-runtime-networking.md)). The
config-invariant gate enforces the core set on these cells; windows does **not**
carry it.

- **The `xt` matches an engine's rules need.** Modern container images run
  `iptables-nft`, which routes classic matches through `nft_compat` — that in turn
  needs the built-in `xt` modules: `CONFIG_NETFILTER_XT_MATCH_ADDRTYPE` (whose absence
  was the concrete failure — dockerd's bridge driver reporting *"addrtype revision 0
  not supported"*), plus `_STATE`, `_MARK`, `_MULTIPORT`.
- **Bridge + NAT through nftables.** `CONFIG_BRIDGE` (+`BRIDGE_NETFILTER`) and
  `CONFIG_VETH` provide the container topology; `NFT_MASQ`, `NFT_REJECT`,
  `NFT_NAT`, and `NF_NAT` provide SNAT/reject behavior. The `xt` matches and
  targets used by `NFT_COMPAT` remain built in, but Linux's separately selectable
  legacy IPv4/IPv6 iptables evaluators are disabled and forbidden. Modern
  `iptables-nft` therefore works without carrying two rule engines.
- **Network drivers.** `CONFIG_VXLAN` (overlay networks), `CONFIG_MACVLAN`,
  `CONFIG_IPVLAN`, `CONFIG_BRIDGE_VLAN_FILTERING`, plus the nft bridge/ebtables path
  (`CONFIG_NF_TABLES_BRIDGE`, `CONFIG_NF_TABLES_NETDEV`, `CONFIG_BRIDGE_NF_EBTABLES`).
- **Dependency notes** (each would be silently dropped by `olddefconfig` otherwise):
  `BRIDGE_VLAN_FILTERING` *depends on* `CONFIG_VLAN_8021Q`, and
  `IP6_NF_TARGET_MASQUERADE` *depends on* `IP6_NF_NAT` — both enabled in the same pass.
- **Scope held.** These are carried capabilities, inert without host wiring
  ([ADR 0008](../adr/0008-kernel-capability-surface-vs-vmm-scope.md)). `CONFIG_IP_VS`
  (Swarm/IPVS service load-balancing) and `CONFIG_IP_SET` stay **off** — no substrate
  consumer; the Docker-optional tc controllers (`NET_SCHED`/`NET_CLS_CGROUP`/
  `CGROUP_NET_PRIO`) likewise stay off.

The authoritative enabled/forbidden sets per cell live as the config-invariant
gate's data ([testing/strategy.md](../testing/strategy.md)); this doc is the prose
rationale.

## Verification

The config-invariant gate asserts the required-present / forbidden-absent set per
(arch, variant) after `olddefconfig`; boot-smoke proves the enabled set actually
boots a guest and drives the wired devices; `make repro-check` proves the config
(plus fixed metadata) yields byte-identical images
([testing/strategy.md](../testing/strategy.md)).

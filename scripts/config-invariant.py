#!/usr/bin/env python3
"""Config-invariant gate (ADR 0006, testing/strategy.md).

After `make olddefconfig`, assert the required `CONFIG_*` are present (with the
right value) and the forbidden ones are absent, per (arch, variant). `olddefconfig`
can silently drop a required option whose dependency changed across a version bump;
this gate turns that into a build-time failure instead of a guest-boot mystery.

Usage: config-invariant.py --arch x86_64 --variant base --config path/to/.config
"""

import argparse
import sys

# Required common to every (arch, variant): the monolithic, virtio-only core +
# substrate's device set (kernel-config.md). Value "y" means CONFIG_X=y.
REQUIRED_COMMON = {
    "CONFIG_NR_CPUS": "16",            # bounded to substrate's max vCPU count
    "CONFIG_VIRTIO": "y",
    "CONFIG_VIRTIO_MMIO": "y",         # the transport substrate's mmio crate drives
    "CONFIG_VIRTIO_BLK": "y",
    "CONFIG_VIRTIO_NET": "y",
    "CONFIG_VIRTIO_CONSOLE": "y",
    "CONFIG_VIRTIO_VSOCKETS": "y",
    "CONFIG_VIRTIO_BALLOON": "y",      # dynamic guest memory reclaim
    "CONFIG_PAGE_REPORTING": "y",      # free-page reporting to the host (pairs w/ balloon)
    "CONFIG_HW_RANDOM_VIRTIO": "y",    # rng
    "CONFIG_VIRTIO_FS": "y",           # optional --volume mounts
    "CONFIG_FUSE_FS": "y",
    "CONFIG_OVERLAY_FS": "y",
    "CONFIG_EXT4_FS": "y",             # the production rootfs is a sparse ext4 disk
    "CONFIG_TMPFS": "y",
    "CONFIG_DEVTMPFS": "y",
    "CONFIG_BLK_DEV_INITRD": "y",      # initrd path available in every variant
    # eBPF: must work in every guest (XDP, cgroup/TC programs, BPF syscall).
    "CONFIG_BPF": "y",
    "CONFIG_BPF_SYSCALL": "y",
    "CONFIG_CGROUP_BPF": "y",
    # Guest-side KVM: a substrate guest can host its own VMs when the host
    # exposes virtualization extensions; inert without them (ADR 0008).
    "CONFIG_KVM": "y",
}

# Arch-specific required additions.
REQUIRED_ARCH = {
    "x86_64": {"CONFIG_PVH": "y",
               # both x86 vendor backends for guest-side KVM
               "CONFIG_KVM_INTEL": "y", "CONFIG_KVM_AMD": "y"},
    "aarch64": {},
    "riscv64": {},  # carried, not CI-gated; only the common set is asserted
}

# Variants that boot the substrate guest model directly: must carry XDP_SOCKETS
# (`AF_XDP`) so guest userspace can attach XDP programs to virtio-net.
# windows is carried/special-purpose and out of scope for XDP.
XDP_VARIANTS = {"base", "debug"}

# Container-runtime networking (in-guest Docker/dockerd — ADR 0014). The variants
# that ship as the substrate guest model carry the netfilter/bridge/NAT surface a
# container engine needs: iptables-nft goes through nft_compat, which requires the
# built-in xt matches (ADDRTYPE was the symbol whose absence broke dockerd's bridge
# driver), and container outbound NAT needs the MASQUERADE targets. Scoped like
# XDP_VARIANTS; windows is out of scope. olddefconfig can silently drop any
# of these if a dependency changes across a pin bump, so the gate pins them.
DOCKER_VARIANTS = {"base", "debug"}
DOCKER_REQUIRED = {
    "CONFIG_NETFILTER": "y",
    "CONFIG_NETFILTER_ADVANCED": "y",
    "CONFIG_NF_CONNTRACK": "y",
    "CONFIG_NF_NAT": "y",
    "CONFIG_NF_NAT_MASQUERADE": "y",   # container outbound NAT (auto-selected)
    "CONFIG_NF_TABLES": "y",
    "CONFIG_NFT_COMPAT": "y",          # iptables-nft translates xt matches via this
    "CONFIG_NFT_MASQ": "y",
    "CONFIG_NETFILTER_XT_MATCH_ADDRTYPE": "y",   # the symbol that broke dockerd
    "CONFIG_NETFILTER_XT_MATCH_CONNTRACK": "y",
    "CONFIG_NETFILTER_XT_TARGET_MASQUERADE": "y",
    "CONFIG_IP_NF_IPTABLES": "y",
    "CONFIG_IP6_NF_IPTABLES": "y",     # docker configures ip6tables by default
    "CONFIG_BRIDGE": "y",              # the default docker0 bridge network
    "CONFIG_BRIDGE_NETFILTER": "y",
    "CONFIG_VETH": "y",               # container ↔ bridge veth pairs
    "CONFIG_VXLAN": "y",              # overlay networks
    "CONFIG_MACVLAN": "y",           # macvlan driver
    "CONFIG_IPVLAN": "y",            # ipvlan driver
}

# Forbidden anywhere: monolithic image (no modules), cut driver classes,
# microVM-irrelevant subsystems (kernel-config.md).
FORBIDDEN_COMMON = {
    "CONFIG_MODULES",          # monolithic — must be unset (=y forbidden)
    "CONFIG_CAN",              # dropped (no substrate consumer)
    "CONFIG_DRM",              # GPU cut
    "CONFIG_VIRTIO_GPU",       # GPU cut
    "CONFIG_SOUND",            # no sound device in the substrate device set
    "CONFIG_BTRFS_FS",         # rootfs is ext4; snapshotting is the VMM's job
    "CONFIG_FAT_FS",           # no FAT mount path (drops the VFAT/MSDOS/NLS chain)
    "CONFIG_PCI",              # substrate enumerates virtio-mmio, never PCI
    "CONFIG_FUSE_DAX",         # substrate's virtio-fs device has no DAX window
    "CONFIG_VIRTIO_RTC",       # substrate exposes PL031 (arm64) / KVM clock (x86)
    "CONFIG_ARM64_ACTLR_STATE", # no cross-architecture emulation/Apple TSO contract
    # Linux 6.18 split the old iptables evaluator from the xtables API used by
    # iptables-nft. substrate guests use iptables-nft; keep the legacy evaluator
    # out while retaining NFT_COMPAT and the built-in xt match/target set above.
    "CONFIG_NETFILTER_XTABLES_LEGACY",
    "CONFIG_IP_NF_IPTABLES_LEGACY",
    "CONFIG_IP6_NF_IPTABLES_LEGACY",
}
# We enforce only the master toggle of each cut subsystem. Sub-options that depend
# on the master (e.g. CONFIG_SND_*, CONFIG_BTRFS_FS_*, CONFIG_VFAT_FS,
# CONFIG_FUNCTION_TRACER) may remain in the .config as harmless orphans after
# olddefconfig — kbuild compiles them as 'n' because the master is 'n'.

# TEE symbols are forbidden: substrate has no SEV/TDX machine model.
TEE_SYMBOLS = ("CONFIG_SEV_GUEST", "CONFIG_INTEL_TDX_GUEST", "CONFIG_CMDLINE_SECRET")

# Master tracing toggle: forbidden in base/windows (curated-minimal),
# required in the debug variant (the whole point of that variant).
TRACING_MASTER = "CONFIG_FTRACE"


def parse_config(path):
    """Return (set_values: {name: value}, not_set: set(names))."""
    set_values, not_set = {}, set()
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("# CONFIG_") and line.endswith(" is not set"):
                    not_set.add(line[len("# "):-len(" is not set")])
                elif line.startswith("CONFIG_") and "=" in line:
                    name, _, value = line.partition("=")
                    set_values[name] = value
    except FileNotFoundError:
        sys.exit(f"[config-invariant] FATAL: config not found: {path} "
                 f"(run the build first, or check the pin/patches)")
    return set_values, not_set


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--arch", required=True, choices=("x86_64", "aarch64", "riscv64"))
    p.add_argument("--variant", required=True,
                   choices=("base", "debug", "windows"))
    p.add_argument("--config", required=True)
    args = p.parse_args()

    values, not_set = parse_config(args.config)
    errors = []

    required = dict(REQUIRED_COMMON)
    # windows is a carried, not-CI-gated reference variant with its own driver set;
    # assert only the monolithic/virtio-only common core, not the x86 arch extras.
    if args.variant != "windows":
        required.update(REQUIRED_ARCH.get(args.arch, {}))

    # XDP_SOCKETS required for variants that ship as the substrate guest model.
    if args.variant in XDP_VARIANTS:
        required["CONFIG_XDP_SOCKETS"] = "y"

    # Container-runtime networking required for the guest-model variants (ADR 0014).
    if args.variant in DOCKER_VARIANTS:
        required.update(DOCKER_REQUIRED)

    # Debug variant carries the tracing/debugging surface; require the master
    # tracing toggle + the specific tracers + kprobes + bpf_events explicitly so the
    # variant cannot silently lose its raison d'être.
    if args.variant == "debug":
        required[TRACING_MASTER] = "y"
        required["CONFIG_FUNCTION_TRACER"] = "y"
        required["CONFIG_KPROBES"] = "y"
        required["CONFIG_PERF_EVENTS"] = "y"
        required["CONFIG_BPF_EVENTS"] = "y"

    for name, want in required.items():
        got = values.get(name)
        if got != want:
            errors.append(f"required {name}={want} but got "
                          f"{name+'='+got if got else 'UNSET'}")

    forbidden_enabled = set(FORBIDDEN_COMMON)
    forbidden_enabled.update(TEE_SYMBOLS)

    # Master tracing toggle is forbidden everywhere except the debug variant.
    if args.variant != "debug":
        forbidden_enabled.add(TRACING_MASTER)

    for name in forbidden_enabled:
        if values.get(name) in ("y", "m"):
            errors.append(f"forbidden {name}={values[name]} (must be unset for "
                          f"{args.arch}/{args.variant})")

    if errors:
        print(f"[config-invariant] FAIL ({args.arch}/{args.variant}):", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)

    print(f"[config-invariant] {args.arch}/{args.variant}: "
          f"{len(required)} required present, {len(forbidden_enabled)} forbidden absent")


if __name__ == "__main__":
    main()

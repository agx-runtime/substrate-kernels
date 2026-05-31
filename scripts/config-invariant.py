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
    "CONFIG_HW_RANDOM_VIRTIO": "y",    # rng
    "CONFIG_VIRTIO_FS": "y",           # optional --volume mounts
    "CONFIG_FUSE_FS": "y",
    "CONFIG_OVERLAY_FS": "y",
    "CONFIG_EXT4_FS": "y",             # the production rootfs is a sparse ext4 disk
    "CONFIG_TMPFS": "y",
    "CONFIG_DEVTMPFS": "y",
    "CONFIG_TSI": "y",                 # substrate's net contract (transparent sockets)
    "CONFIG_BLK_DEV_INITRD": "y",      # initrd path available in every variant
}

# Arch-specific required additions.
REQUIRED_ARCH = {
    "x86_64": {"CONFIG_PVH": "y", "CONFIG_FUSE_DAX": "y", "CONFIG_VIRTIO_RTC": "y"},
    "aarch64": {"CONFIG_FUSE_DAX": "y", "CONFIG_VIRTIO_RTC": "y"},
    "riscv64": {},  # carried, not CI-gated; only the common set is asserted
}

# Forbidden anywhere: monolithic image (no modules), cut driver classes.
FORBIDDEN_COMMON = {
    "CONFIG_MODULES",     # monolithic — must be unset (=y forbidden)
    "CONFIG_CAN",         # dropped (no substrate consumer)
    "CONFIG_DRM",         # GPU cut
    "CONFIG_VIRTIO_GPU",  # GPU cut
}

# TEE symbols: forbidden in base/windows, required in sev/tdx.
TEE_SYMBOLS = ("CONFIG_SEV_GUEST", "CONFIG_INTEL_TDX_GUEST", "CONFIG_CMDLINE_SECRET")


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
                   choices=("base", "sev", "tdx", "windows"))
    p.add_argument("--config", required=True)
    args = p.parse_args()

    values, not_set = parse_config(args.config)
    errors = []

    required = dict(REQUIRED_COMMON)
    # windows is a carried, not-CI-gated reference variant with its own driver set;
    # assert only the monolithic/virtio-only common core, not the x86 arch extras.
    if args.variant != "windows":
        required.update(REQUIRED_ARCH.get(args.arch, {}))

    for name, want in required.items():
        got = values.get(name)
        if got != want:
            errors.append(f"required {name}={want} but got "
                          f"{name+'='+got if got else 'UNSET'}")

    forbidden_enabled = set(FORBIDDEN_COMMON)
    if args.variant in ("base", "windows"):
        # Base/windows: no TEE symbols.
        forbidden_enabled.update(TEE_SYMBOLS)
    else:
        # sev/tdx: the variant's TEE symbol is required.
        tee_req = {"sev": "CONFIG_SEV_GUEST", "tdx": "CONFIG_INTEL_TDX_GUEST"}[args.variant]
        if values.get(tee_req) != "y":
            errors.append(f"required {tee_req}=y for variant {args.variant}")

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

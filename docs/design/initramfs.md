# Design: initramfs and root filesystem

Current release bundles contain a kernel only. Their optional qboot and initrd
header ranges are zero. substrate supplies userspace at VM creation time instead
of coupling it to a kernel release.

## Current paths

- The production root filesystem is an ext4 disk exposed through virtio-blk.
  virtio-fs is reserved for optional volume mounts and is never the root device.
- substrate may construct and supply a per-VM initramfs, for example to place
  `init.substrate` and configuration in early userspace before pivoting to ext4.
- `CONFIG_BLK_DEV_INITRD=y` keeps that runtime path available even though the
  `.kernel` bundle itself has no baked initrd.
- The `SUBK` format and packer retain optional qboot/initrd fields for format
  compatibility, but no current Makefile variant populates them.

The removed SEV/TDX variants had planned prebuilt firmware and secret-retrieval
initrds, but those assets were never wired into releasable bundles and substrate
has no corresponding confidential-compute machine model. They are not a current
initramfs path ([ADR 0009](../adr/0009-confidential-compute-variants.md)).

## Verification

The bundle golden asserts absent optional sections are encoded as zero ranges.
Substrate KVM smokes boot both the ext4-root path and a runtime-supplied
`init.substrate` initramfs, reach userspace, pivot to the block root, and shut down
cleanly. The initramfs bytes are a substrate VM input, not a hidden input to kernel
bundle reproducibility.

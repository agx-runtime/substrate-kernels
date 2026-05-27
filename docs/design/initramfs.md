# Design: the initramfs

What the guest runs before the rootfs is available, and how (and whether) it is
packed into the bundle. The story differs by variant: a **base** bundle carries no
initramfs — substrate supplies the boot filesystem (an ext4 disk) at run time —
while a **TEE** bundle vendors the prebuilt secret-retrieval initrd
blob (TEE wiring is deferred — [ADR 0009](../adr/0009-confidential-compute-variants.md)).

## Background

The TEE `initrd/` (a small gzip cpio with a minimal init) is bundled only
for the TEE variants via the packer's `--initrd`; the base variant ships no baked
initrd and relies on the VMM to supply the boot filesystem. The bundle header
carries `initrd_offset`/`initrd_size` (zero when absent).

## Subtle details & gotchas

| Detail | Convention | Our handling | Gate |
|---|---|---|---|
| **Base rootfs comes from the VMM, not the bundle** | base bundles ship no initrd | base bundle `initrd_offset/size = 0`; substrate supplies a sparse ext4 disk as rootfs via virtio-blk at run time (base leaves `BLK_DEV_INITRD` unset by default; CLAUDE.md §5b — never virtiofs as rootfs) | boot-smoke (base) |
| **TEE needs early userspace before rootfs** — secrets/measurement must happen inside the encrypted domain before trusting a disk | bundles a prebuilt initrd blob into the bundle | TEE bundle vendors the prebuilt secret-retrieval initrd; packed via the bundle's initrd section ([ADR 0009](../adr/0009-confidential-compute-variants.md)) | TEE attestation/boot check |
| **A vendored initrd blob is reproducibility-sensitive** — it must be pinned, not regenerated | ships a prebuilt blob | the TEE initrd is the prebuilt blob, **vendored + pinned by sha256** (not built by us — it ships prebuilt with no source), so the bundle stays byte-reproducible ([ADR 0005](../adr/0005-build-environment-and-reproducibility.md)) | `make repro-check` (TEE) |

## Our design

- **Base variant — no baked initramfs.** The bundle's initrd section is absent
  (`offset/size = 0`). substrate provides the boot filesystem at run time: a
  **sparse ext4 disk from the OCI pipeline** mounted as rootfs via virtio-blk. The
  base config enables `EXT4_FS` and leaves `BLK_DEV_INITRD` **unset** (matching the
  reference base — [kernel-config.md](kernel-config.md)). This keeps the bundle
  small and lets substrate own the rootfs supply chain (CoW / dirty tracking /
  snapshot chains — substrate architecture.md §1).
- **TEE variants — a vendored prebuilt initrd.** The sev/tdx bundles carry a small
  initrd whose init runs *inside* the encrypted/attested domain to retrieve secrets
  and complete measurement before any external disk is trusted. It ships
  this initrd as a prebuilt blob (no source); we **vendor that blob, pinned by
  sha256**, and pack it into the bundle's initrd section. The TEE configs enable
  `BLK_DEV_INITRD`. TEE wiring (and thus the actual blob vendoring) is deferred
  ([ADR 0009](../adr/0009-confidential-compute-variants.md)).
- **The boot handoff is substrate's.** Whichever path supplies userspace, control
  reaches the substrate guest supervisor; the kernel's orderly-init-death behavior
  ([patches.md](patches.md)) ensures that supervisor exiting cleanly shuts the VM
  down rather than panicking.

## Verification

boot-smoke ([testing/boot-smoke.md](../testing/boot-smoke.md)) covers the base path
(substrate supplies an ext4 disk / initramfs and the guest reaches userspace);
`make repro-check` covers the TEE initramfs's deterministic build; the TEE
variants' attestation/measurement is verified on their own (separate) lane
([ADR 0009](../adr/0009-confidential-compute-variants.md)).

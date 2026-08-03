#!/usr/bin/env python3
"""Make every GNU build-id in the kernel a function of the final content, so a bundle is reproducible.

why: ld computes a `--build-id=sha1` over the object it has just linked, and later build stages then
rewrite that object in place — `sorttable` (CONFIG_BUILDTIME_TABLE_SORT) reorders __ex_table in the main
vmlinux, and objcopy strips the debug sections out of each vDSO before it is embedded as a `raw_data[]`
array (vdso-image-*.c). So each build-id hashes bytes the finished file no longer contains, and the
symptom is a cross-machine repro-check that fails on exactly the 20-byte build-id descriptors while every
other byte is identical. A kernel carries more than one: the main vmlinux `.note.gnu.build-id`, plus one
inside every embedded vDSO's `.note`.

The rewrite zeroes every build-id descriptor, hashes the whole file once, and sets each descriptor to
sha256 of that hash and the descriptor's own offset. Two machines that produced identical content (which
is the case here — only the descriptors ever differ) therefore zero to the identical file, hash to the
identical base, and write identical descriptors, with no dependence on locating the vDSOs or on any
ordering. The offset keeps the vmlinux and vDSO ids distinct. The kernel's config and functional bytes
are untouched: only the build-ids, which were already non-deterministic, change value.

Usage: normalize-build-id.py <vmlinux> [<packed-kernel-binary> ...]
The first argument is the ELF whose descriptors are recomputed. Any further argument is a file (a raw
arm64 Image) carrying copies of those same descriptors; each old descriptor is rewritten to its new value
there so the packed artifact matches. Passing the vmlinux again (x86_64, where the packed binary is the
vmlinux) is harmless — the second pass finds nothing left to replace.
"""
import hashlib
import os
import struct
import sys

# An NT_GNU_BUILD_ID note is namesz=4, descsz=20, type=3, then the name "GNU\0", then the 20-byte id.
BUILD_ID_NOTE_HEADER = struct.pack("<III", 4, 20, 3) + b"GNU\x00"
BUILD_ID_LEN = 20
_DEBUG = bool(os.environ.get("NORMALIZE_DEBUG"))


def build_id_descriptors(buf):
    """Return the absolute offset of every build-id descriptor in buf, in file order."""
    offsets = []
    at = buf.find(BUILD_ID_NOTE_HEADER)
    while at >= 0:
        offsets.append(at + len(BUILD_ID_NOTE_HEADER))
        at = buf.find(BUILD_ID_NOTE_HEADER, at + len(BUILD_ID_NOTE_HEADER))
    return offsets


def replace_all(buf, old, new):
    at = buf.find(old)
    while at >= 0:
        buf[at:at + len(new)] = new
        at = buf.find(old, at + len(new))


def main():
    if len(sys.argv) < 2:
        print("normalize-build-id: usage: normalize-build-id.py <vmlinux> [<file> ...]", file=sys.stderr)
        return 2
    vmlinux_path = sys.argv[1]
    targets = list(dict.fromkeys(sys.argv[1:]))  # dedup, preserve order

    vmlinux = bytearray(open(vmlinux_path, "rb").read())
    descs = build_id_descriptors(vmlinux)
    if not descs:
        print(f"normalize-build-id: no GNU build-id note in {vmlinux_path}; nothing to do")
        return 0

    # The base is sha256 of the whole file with every descriptor zeroed. It is identical across machines
    # exactly when the non-descriptor bytes are, which is the property this whole fix depends on.
    zeroed = bytearray(vmlinux)
    for d in descs:
        zeroed[d:d + BUILD_ID_LEN] = b"\x00" * BUILD_ID_LEN
    base = hashlib.sha256(bytes(zeroed)).digest()
    if _DEBUG:
        print(f"normalize-build-id[debug]: file={vmlinux_path} len={len(vmlinux)} "
              f"descs={[hex(d) for d in descs]} base={base.hex()}", file=sys.stderr)

    mapping = {}
    for d in descs:
        new = hashlib.sha256(base + struct.pack("<Q", d)).digest()[:BUILD_ID_LEN]
        old = bytes(vmlinux[d:d + BUILD_ID_LEN])
        vmlinux[d:d + BUILD_ID_LEN] = new
        mapping[old] = new
        print(f"normalize-build-id: build-id @0x{d:x} -> {new.hex()}")

    with open(vmlinux_path, "wb") as f:
        f.write(vmlinux)

    for path in targets[1:]:
        buf = bytearray(open(path, "rb").read())
        for old, new in mapping.items():
            replace_all(buf, old, new)
        with open(path, "wb") as f:
            f.write(buf)
        print(f"normalize-build-id: rewrote build-id copies in {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

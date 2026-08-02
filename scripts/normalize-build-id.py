#!/usr/bin/env python3
"""Recompute the vmlinux GNU build-id from the final content, so it is reproducible across machines.

why: link-vmlinux.sh links vmlinux and lets ld compute the .note.gnu.build-id, and only afterwards runs
sorttable (CONFIG_BUILDTIME_TABLE_SORT), which sorts __ex_table and the other runtime tables in place —
after the build-id is already fixed. The order those tables have before sorttable varies from one build
machine to the next, while the sorted result does not, so every byte of the final vmlinux is
reproducible except the build-id, which ld hashed over the pre-sort state that no longer exists in the
file. The symptom is a repro-check that fails on exactly the 20-byte build-id (twice: the note and the
.rodata copy the kernel keeps for /sys/kernel/notes) with every other byte identical.

The fix is to recompute the build-id here, after all post-link processing, as sha256 of the final
vmlinux with the build-id zeroed. That value is a function only of the deterministic final content, so
it is identical across machines, and it stays a real content hash rather than a stripped or fixed
placeholder. The same 20-byte descriptor is rewritten wherever it appears — the ELF note and the .rodata
copy in vmlinux, and the .rodata copy that survives objcopy into a raw arm64 Image — so every artifact
the packer consumes carries the deterministic id.

Usage: normalize-build-id.py <vmlinux> [<packed-kernel-binary> ...]
The first argument is the ELF the build-id note is read from; the rest are additional files (a raw Image)
whose embedded copy of the same id is rewritten. Passing a file twice is harmless (the second pass finds
nothing to replace), so the caller may pass vmlinux as both.
"""
import hashlib
import struct
import sys


def replace_all(buf: bytearray, old: bytes, new: bytes) -> int:
    """Replace every occurrence of old with new (same length) in buf, returning the count."""
    assert len(old) == len(new), "the replacement must be the same length as the descriptor"
    count = 0
    at = buf.find(old)
    while at >= 0:
        buf[at:at + len(new)] = new
        at = buf.find(old, at + len(new))
        count += 1
    return count


def main() -> int:
    if len(sys.argv) < 2:
        print("normalize-build-id: usage: normalize-build-id.py <vmlinux> [<file> ...]", file=sys.stderr)
        return 2

    vmlinux_path = sys.argv[1]
    # Deduplicate while preserving order, so `<vmlinux> <vmlinux>` (x86_64, where the packed binary is
    # the vmlinux itself) processes the file once.
    targets = list(dict.fromkeys(sys.argv[1:]))

    vmlinux = bytearray(open(vmlinux_path, "rb").read())

    # An NT_GNU_BUILD_ID note is namesz=4, descsz=20, type=3, then the name "GNU\0", then the 20-byte id.
    note_header = struct.pack("<III", 4, 20, 3) + b"GNU\x00"
    header_at = vmlinux.find(note_header)
    if header_at < 0:
        print(f"normalize-build-id: no GNU build-id note in {vmlinux_path}; nothing to do")
        return 0
    desc_at = header_at + len(note_header)
    old_id = bytes(vmlinux[desc_at:desc_at + 20])

    # The deterministic id is sha256 of the final vmlinux with every copy of the current id zeroed, so it
    # depends only on the reproducible content and not on the value ld happened to compute.
    zeroed = bytearray(vmlinux)
    replace_all(zeroed, old_id, b"\x00" * 20)
    new_id = hashlib.sha256(bytes(zeroed)).digest()[:20]

    for path in targets:
        buf = vmlinux if path == vmlinux_path else bytearray(open(path, "rb").read())
        replaced = replace_all(buf, old_id, new_id)
        with open(path, "wb") as handle:
            handle.write(buf)
        print(f"normalize-build-id: {path}: rewrote {replaced} build-id copies -> {new_id.hex()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

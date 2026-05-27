#!/usr/bin/env python3
"""Golden test for the bundle header layout (testing/bundle-golden.md).

Locks the packed 96-byte header bytes from fixed synthetic inputs so any field
reorder, width change, magic typo, or alignment slip fails the build. Also checks
the alignment / non-overlap / page_size invariants over the packer's output. Runs
without a kernel build (synthetic payloads), so it is fast and host-independent.

A deliberate format change bumps `format_version` and updates these goldens in the
same change (testing/bundle-golden.md). An accidental change fails here with a diff.
"""

import importlib.util
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_spec = importlib.util.spec_from_file_location("pack_kernel", os.path.join(ROOT, "scripts", "pack-kernel.py"))
pk = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pk)

# Committed golden header bytes (the contract). Each fixture pairs fixed packer
# inputs with the exact 96-byte header hex they must produce; a mismatch fails.
_FIXTURES = [
    ("base x86_64", dict(arch="x86_64", variant="base", abi_version=1, page_size=65536,
                          kernel_payload=b"\xAB" * 65536, load_addr=0x1000000,
                          entry_addr=0x1000000, qboot_payload=None, initrd_payload=None),
     "5355424b0100000001000000010000000000000000000100000000010000000000000001000000000000010000000000000001000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000"),
    ("windows x86_64", dict(arch="x86_64", variant="windows", abi_version=1, page_size=4096,
                            kernel_payload=b"\xCD" * 4096, load_addr=0x1000000,
                            entry_addr=0x1000000, qboot_payload=None, initrd_payload=None),
     "5355424b0100000001000000010000000300000000100000000000010000000000000001000000000010000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000"),
]


def fail(msg):
    print(f"[bundle-golden] FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def check_header_struct():
    if struct.calcsize(pk.HEADER_STRUCT) != pk.HEADER_SIZE:
        fail(f"HEADER_STRUCT calcsize {struct.calcsize(pk.HEADER_STRUCT)} != {pk.HEADER_SIZE}")
    if pk.HEADER_SIZE != 96:
        fail(f"HEADER_SIZE {pk.HEADER_SIZE} != 96")
    if pk.MAGIC != b"SUBK":
        fail(f"magic {pk.MAGIC!r} != b'SUBK'")


def check_golden():
    for name, kw, golden_hex in _FIXTURES:
        header = pk.build_bundle(**kw)[:96]
        if header.hex() != golden_hex:
            fail(f"{name}: header bytes drifted\n  got    {header.hex()}\n  golden {golden_hex}")
        # Decode + sanity-check key fields.
        magic, fmt, abi, arch, variant, page_size = struct.unpack("<4sIIIII", header[:24])
        if magic != b"SUBK":
            fail(f"{name}: magic {magic!r}")
        if header[88:96] != struct.pack("<Q", 96):
            fail(f"{name}: header_size field != 96")
        if page_size != kw["page_size"]:
            fail(f"{name}: page_size field {page_size} != {kw['page_size']}")
    print(f"[bundle-golden] golden header bytes locked for {len(_FIXTURES)} fixtures")


def check_invariants():
    # A representative TEE-like bundle with all three sections present.
    page = 65536
    bundle = pk.build_bundle(
        arch="x86_64", variant="sev", abi_version=1, page_size=page,
        kernel_payload=b"\x01" * (page * 2),
        load_addr=0x1000000, entry_addr=0x1000000,
        qboot_payload=b"\x02" * page,
        initrd_payload=b"\x03" * (page * 3),
    )
    (ko, ks, qo, qs, io_, is_) = struct.unpack("<QQQQQQ", bundle[40:88])
    sections = [("kernel", ko, ks), ("qboot", qo, qs), ("initrd", io_, is_)]
    # Offsets page-aligned.
    for nm, off, sz in sections:
        if off % page != 0:
            fail(f"{nm} offset {off:#x} not {page}-aligned")
    # Non-overlap (present sections, sorted by offset).
    present = sorted([(off, sz, nm) for nm, off, sz in sections if sz != 0])
    for (o1, s1, n1), (o2, _s2, n2) in zip(present, present[1:]):
        if o1 + s1 > o2:
            fail(f"{n1} overlaps {n2}: {o1:#x}+{s1:#x} > {o2:#x}")
    # The packed file is exactly as long as the last section's end.
    last_off, last_sz, _ = present[-1]
    if len(bundle) != last_off + last_sz:
        fail(f"bundle length {len(bundle)} != last section end {last_off + last_sz}")
    # Absent base sections must be 0/0.
    base = pk.build_bundle(arch="aarch64", variant="base", abi_version=1, page_size=page,
                           kernel_payload=b"\x00" * page, load_addr=0x80000000,
                           entry_addr=0x80000000, qboot_payload=None, initrd_payload=None)
    (_, _, qo, qs, io_, is_) = struct.unpack("<QQQQQQ", base[40:88])
    if (qo, qs, io_, is_) != (0, 0, 0, 0):
        fail(f"absent sections not zeroed: {(qo, qs, io_, is_)}")
    print("[bundle-golden] alignment / non-overlap / absent-section invariants hold")


def main():
    check_header_struct()
    check_golden()
    check_invariants()
    print("[bundle-golden] PASS")


if __name__ == "__main__":
    main()

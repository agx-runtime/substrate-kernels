#!/usr/bin/env python3
"""Unit checks for pack-kernel's address extraction (bundle-format.md).

Locks the two highest-risk packer details against silent regression:
  * x86_64 ELF: `entry_addr` = raw ELF `e_entry` (NOT masked, NOT a PVH note),
    `load_addr` = first PT_LOAD `p_vaddr & 0xFFFFFFF`, with inter-segment gaps
    zero-padded and overlaps hard-erroring (ADR 0004 / CLAUDE.md §5).
  * aarch64 / riscv64 raw Image: `load_addr` = `entry_addr` = 0x80000000, payload
    page-padded.

Needs pyelftools (the packer's ELF dependency). A missing dependency is a hard
failure with a remediation hint, never a skip (CLAUDE.md §8).
"""

import importlib.util
import os
import struct
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_spec = importlib.util.spec_from_file_location("pack_kernel", os.path.join(ROOT, "scripts", "pack-kernel.py"))
pk = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pk)


def fail(msg):
    print(f"[pack-unit] FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def require_pyelftools():
    try:
        import elftools  # noqa: F401
    except ImportError:
        fail("pyelftools missing — run inside the build container, or "
             "`python3 -m venv venv && venv/bin/pip install pyelftools`")


PT_LOAD = 1
ET_EXEC = 2
EM_X86_64 = 62


def build_elf(e_entry, segments):
    """segments: list of (p_vaddr, p_paddr, filesz, fill_byte). Returns ELF bytes."""
    ehsize = 64
    phentsize = 56
    phnum = len(segments)
    phoff = ehsize
    data_start = phoff + phnum * phentsize
    # Page-align the first segment's file offset for realism.
    data_start = (data_start + 0xFFF) & ~0xFFF

    phdrs = b""
    blobs = b""
    cur = data_start
    for (p_vaddr, p_paddr, filesz, fill) in segments:
        p_offset = cur
        phdrs += struct.pack("<IIQQQQQQ",
                             PT_LOAD, 0x5,            # type, flags (R+X)
                             p_offset, p_vaddr, p_paddr,
                             filesz, filesz, 0x200000)  # filesz, memsz, align
        blobs += bytes([fill]) * filesz
        cur += filesz

    e_ident = b"\x7fELF" + bytes([2, 1, 1, 0]) + b"\x00" * 8  # 64-bit, LE, SysV
    ehdr = e_ident + struct.pack("<HHIQQQIHHHHHH",
                                 ET_EXEC, EM_X86_64, 1, e_entry,
                                 phoff, 0, 0, ehsize, phentsize, phnum, 0, 0, 0)
    out = bytearray(ehdr + phdrs)
    out += b"\x00" * (data_start - len(out))
    out += blobs
    return bytes(out)


def test_elf_entry_and_load():
    e_entry = 0xFFFFFFFF81000000  # high virtual startup_64 — must be recorded RAW
    # Two PT_LOAD with a 0x1000 gap to exercise gap padding.
    segs = [
        (0xFFFFFFFF81000000, 0x1000000, 0x1000, 0xAA),
        (0xFFFFFFFF81002000, 0x1002000, 0x0800, 0xBB),  # gap of 0x1000 after first
    ]
    with tempfile.NamedTemporaryFile(suffix=".elf") as f:
        f.write(build_elf(e_entry, segs))
        f.flush()
        load_addr, entry_addr, payload = pk.flatten_elf(f.name, pk.PAGE_SIZE_DEFAULT)

    if entry_addr != e_entry:
        fail(f"entry_addr {entry_addr:#x} != raw e_entry {e_entry:#x} (must not mask/transform)")
    if load_addr != (0xFFFFFFFF81000000 & 0xFFFFFFF):
        fail(f"load_addr {load_addr:#x} != p_vaddr & 0xFFFFFFF")
    if load_addr != 0x1000000:
        fail(f"load_addr {load_addr:#x} != 0x1000000")
    # Payload: seg1 (0x1000 of 0xAA) + gap (0x1000 of 0x00) + seg2 (0x800 of 0xBB),
    # page-padded to 64 KiB.
    if len(payload) != pk.PAGE_SIZE_DEFAULT:
        fail(f"payload len {len(payload):#x} != one 64KiB page")
    if payload[0:0x1000] != b"\xAA" * 0x1000:
        fail("seg1 bytes wrong")
    if payload[0x1000:0x2000] != b"\x00" * 0x1000:
        fail("inter-segment gap not zero-padded")
    if payload[0x2000:0x2800] != b"\xBB" * 0x800:
        fail("seg2 bytes wrong")
    print("[pack-unit] x86_64 e_entry/load_addr + gap padding OK")


def test_elf_overlap_errors():
    # seg2.p_paddr inside seg1 → overlap → hard error.
    segs = [
        (0xFFFFFFFF81000000, 0x1000000, 0x1000, 0xAA),
        (0xFFFFFFFF81000800, 0x1000800, 0x0800, 0xBB),  # overlaps seg1
    ]
    with tempfile.NamedTemporaryFile(suffix=".elf") as f:
        f.write(build_elf(0x1000000, segs))
        f.flush()
        try:
            pk.flatten_elf(f.name, pk.PAGE_SIZE_DEFAULT)
        except ValueError:
            print("[pack-unit] PT_LOAD overlap hard-errors OK")
            return
    fail("overlapping PT_LOAD segments did not raise (silent truncation risk)")


def test_raw_image():
    data = b"\x5a" * 1234
    with tempfile.NamedTemporaryFile(suffix=".img") as f:
        f.write(data)
        f.flush()
        payload = pk.flatten_raw(f.name, pk.PAGE_SIZE_DEFAULT)
    if len(payload) != pk.PAGE_SIZE_DEFAULT:
        fail(f"raw payload not page-padded: {len(payload):#x}")
    if payload[:1234] != data or payload[1234:] != b"\x00" * (pk.PAGE_SIZE_DEFAULT - 1234):
        fail("raw payload content/padding wrong")
    # The aarch64/riscv64 address path is the hardcoded base.
    if pk.RAW_LOAD_ADDR != 0x80000000:
        fail(f"RAW_LOAD_ADDR {pk.RAW_LOAD_ADDR:#x} != 0x80000000")
    print("[pack-unit] raw Image padding + 0x80000000 base OK")


def main():
    require_pyelftools()
    test_elf_entry_and_load()
    test_elf_overlap_errors()
    test_raw_image()
    print("[pack-unit] PASS")


if __name__ == "__main__":
    main()

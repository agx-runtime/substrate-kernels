#!/usr/bin/env python3
"""Label every differing byte between two vmlinux ELFs by section, descending into embedded ELFs.

Temporary diagnostic for the cross-machine reproducibility investigation. `readelf` cannot run
cross-arch on the machine doing the analysis, and its column layout varies, so this parses the ELF
section headers directly with the struct module instead. For any differing byte that falls inside a
`raw_data` symbol — the kernel embeds each vDSO image as a `raw_data[]` array (vdso-image-*.c) — it also
parses that embedded ELF and reports which vDSO section the byte is in, because the vDSO carries its own
`--build-id` note and its own `.eh_frame_hdr`, and telling a vDSO build-id apart from real vDSO content
is the whole question. It prints every differing offset, not a truncated sample, so no run of differences
is missed.

Usage: diff-elf.py <vmlinuxA> <vmlinuxB>
"""
import struct
import sys
from collections import Counter


def elf_sections(buf, base=0):
    """Return [(name, file_off, size, vaddr)] for the ELF64 starting at buf[base:]."""
    e_shoff = struct.unpack_from("<Q", buf, base + 0x28)[0]
    e_shentsize = struct.unpack_from("<H", buf, base + 0x3A)[0]
    e_shnum = struct.unpack_from("<H", buf, base + 0x3C)[0]
    e_shstrndx = struct.unpack_from("<H", buf, base + 0x3E)[0]
    raw = []
    for i in range(e_shnum):
        o = base + e_shoff + i * e_shentsize
        name, _typ, _flags, addr, off, size, link, _info, _al, _ent = struct.unpack_from(
            "<IIQQQQIIQQ", buf, o)
        raw.append((name, off, size, addr, link))
    stroff = base + raw[e_shstrndx][1]

    def nm(n):
        end = buf.index(b"\0", stroff + n)
        return buf[stroff + n:end].decode("latin1")

    return [(nm(r[0]), r[1], r[2], r[3]) for r in raw], raw, stroff


def raw_data_symbols(buf):
    """Return [(vaddr, size)] for every symbol named raw_data (the embedded vDSO images)."""
    named, raw, _ = elf_sections(buf)
    symtab = next((r for r in raw if _sec_name(buf, r) == ".symtab"), None)
    if not symtab:
        return []
    stros = raw[symtab[4]][1]

    def snm(n):
        end = buf.index(b"\0", stros + n)
        return buf[stros + n:end].decode("latin1")

    out = []
    off, size = symtab[1], symtab[2]
    for o in range(off, off + size, 24):
        st_name, _info, _other, _shndx, st_value, st_size = struct.unpack_from("<IBBHQQ", buf, o)
        if st_value and snm(st_name) == "raw_data":
            out.append((st_value, st_size))
    return out


def _sec_name(buf, raw_row):
    named, _, _ = elf_sections(buf)
    # raw_row is a header tuple from elf_sections' second return; find its name by matching offset.
    for n, off, size, addr in named:
        if off == raw_row[1] and size == raw_row[2] and addr == raw_row[3]:
            return n
    return ""


def vaddr_to_off(sections, vaddr):
    for name, off, size, addr in sections:
        if size and addr and addr <= vaddr < addr + size:
            return off + (vaddr - addr)
    return None


def label(sections, embedded, offset):
    """Return 'vmlinuxSection' or 'vmlinuxSection > vDSO(file@x)Section' for a file offset."""
    outer = "(no section)"
    for name, off, size, addr in sections:
        if size and off <= offset < off + size:
            outer = name
            break
    for base, size, vsecs in embedded:
        if base <= offset < base + size:
            inner_off = offset - base
            inner = "(vDSO header/gap)"
            for n, o, s, _a in vsecs:
                if s and o <= inner_off < o + s:
                    inner = n
                    break
            return f"{outer} > vDSO@{hex(base)} {inner}"
    return outer


def main():
    if len(sys.argv) != 3:
        print("usage: diff-elf.py <vmlinuxA> <vmlinuxB>", file=sys.stderr)
        return 2
    a = open(sys.argv[1], "rb").read()
    b = open(sys.argv[2], "rb").read()
    sections, _, _ = elf_sections(a)

    # Locate each embedded vDSO (raw_data) and parse its own section table once.
    embedded = []
    for vaddr, size in raw_data_symbols(a):
        foff = vaddr_to_off(sections, vaddr)
        if foff is not None and a[foff:foff + 4] == b"\x7fELF":
            vsecs, _, _ = elf_sections(a, foff)
            embedded.append((foff, size, vsecs))
    print(f"embedded vDSO images found: {len(embedded)} at "
          f"{[hex(e[0]) for e in embedded]}")

    n = min(len(a), len(b))
    if len(a) != len(b):
        print(f"NOTE: file sizes differ (A={len(a)} B={len(b)}); comparing first {n} bytes")
    per_label = Counter()
    offsets = []
    for i in range(n):
        if a[i] != b[i]:
            offsets.append(i)
            per_label[label(sections, embedded, i)] += 1
    print(f"total differing bytes: {len(offsets)}")
    print("differing bytes by section:")
    for lab, c in per_label.most_common():
        print(f"  {c:>6}  {lab}")
    print("all differing file offsets (hex):", [hex(o) for o in offsets])
    return 0


if __name__ == "__main__":
    sys.exit(main())

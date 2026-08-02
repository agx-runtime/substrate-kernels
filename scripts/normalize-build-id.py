#!/usr/bin/env python3
"""Recompute every GNU build-id in the kernel from its final content, so a bundle is reproducible.

why: ld computes a `--build-id=sha1` over the object it has just linked, and later build stages then
rewrite that object in place — `sorttable` (CONFIG_BUILDTIME_TABLE_SORT) reorders __ex_table in the main
vmlinux, and objcopy strips the debug sections out of each vDSO before it is embedded as a `raw_data[]`
array (vdso-image-*.c). So each build-id is a hash of bytes the finished file no longer contains, and the
symptom is a cross-machine repro-check that fails on exactly the 20-byte build-id descriptors while every
other byte is identical. A kernel carries more than one: the main vmlinux has its own `.note.gnu.build-id`,
and every embedded vDSO ELF carries a second one inside `.rodata`.

The fix recomputes each descriptor as sha256 of the object that contains it, with that descriptor zeroed,
so the id becomes a function only of the deterministic final content. The embedded vDSO ids are recomputed
first, because the main vmlinux hash then covers the vDSO ids and must see their fixed values; if it ran
first it would hash the still-varying vDSO ids and stay non-deterministic itself. The kernel's config and
functional bytes are untouched: only the build-ids, which were already non-deterministic, change value.

Usage: normalize-build-id.py <vmlinux> [<packed-kernel-binary> ...]
The first argument is the ELF whose build-ids are recomputed. Any further argument is a file (a raw arm64
Image) that carries its own copies of those same descriptors; each old descriptor is rewritten to its new
value there so the packed artifact matches. Passing the vmlinux again (x86_64, where the packed binary is
the vmlinux) is harmless — the second pass finds nothing left to replace.
"""
import hashlib
import struct
import sys

# An NT_GNU_BUILD_ID note is namesz=4, descsz=20, type=3, then the name "GNU\0", then the 20-byte id.
BUILD_ID_NOTE_HEADER = struct.pack("<III", 4, 20, 3) + b"GNU\x00"
BUILD_ID_LEN = 20


def elf_section_headers(buf, base=0):
    """Return (headers, shstrtab_off) for the ELF64 at buf[base:]; headers are raw field tuples."""
    e_shoff = struct.unpack_from("<Q", buf, base + 0x28)[0]
    e_shentsize = struct.unpack_from("<H", buf, base + 0x3A)[0]
    e_shnum = struct.unpack_from("<H", buf, base + 0x3C)[0]
    e_shstrndx = struct.unpack_from("<H", buf, base + 0x3E)[0]
    headers = []
    for i in range(e_shnum):
        o = base + e_shoff + i * e_shentsize
        headers.append(struct.unpack_from("<IIQQQQIIQQ", buf, o))  # name,type,flags,addr,off,size,...
    return headers, base + headers[e_shstrndx][4]


def section_named(buf, name):
    """Return (file_off, size) of the named section in the vmlinux, or None."""
    headers, shstr = elf_section_headers(buf)
    for h in headers:
        end = buf.index(b"\0", shstr + h[0])
        if buf[shstr + h[0]:end] == name:
            return h[4], h[5]
    return None


def vaddr_to_off(buf, vaddr):
    headers, _ = elf_section_headers(buf)
    for _n, _t, _f, addr, off, size, *_ in headers:
        if size and addr and addr <= vaddr < addr + size:
            return off + (vaddr - addr)
    return None


def embedded_vdso_ranges(buf):
    """Return [(file_off, size)] for every raw_data symbol whose bytes start with an ELF header."""
    symtab = section_named(buf, b".symtab")
    if symtab is None:
        return []
    headers, _ = elf_section_headers(buf)
    # .symtab's sh_link names the string table section index.
    sym_hdr = next(h for h in headers if h[4] == symtab[0] and h[5] == symtab[1])
    strtab_off = headers[sym_hdr[6]][4]

    def name(n):
        end = buf.index(b"\0", strtab_off + n)
        return buf[strtab_off + n:end]

    ranges = []
    off, size = symtab
    for o in range(off, off + size, 24):
        st_name, _info, _other, _shndx, st_value, st_size = struct.unpack_from("<IBBHQQ", buf, o)
        if st_value and st_size and name(st_name) == b"raw_data":
            foff = vaddr_to_off(buf, st_value)
            if foff is not None and buf[foff:foff + 4] == b"\x7fELF":
                ranges.append((foff, st_size))
    return ranges


def build_id_descriptors(buf, start, end):
    """Return the absolute offsets of every build-id descriptor within buf[start:end]."""
    offsets = []
    at = buf.find(BUILD_ID_NOTE_HEADER, start, end)
    while at >= 0:
        offsets.append(at + len(BUILD_ID_NOTE_HEADER))
        at = buf.find(BUILD_ID_NOTE_HEADER, at + len(BUILD_ID_NOTE_HEADER), end)
    return offsets


def recompute(buf, desc_off, scope_start, scope_end):
    """Set the descriptor at desc_off to sha256 of buf[scope_start:scope_end] with it zeroed."""
    scope = bytearray(buf[scope_start:scope_end])
    rel = desc_off - scope_start
    scope[rel:rel + BUILD_ID_LEN] = b"\x00" * BUILD_ID_LEN
    new = hashlib.sha256(bytes(scope)).digest()[:BUILD_ID_LEN]
    old = bytes(buf[desc_off:desc_off + BUILD_ID_LEN])
    buf[desc_off:desc_off + BUILD_ID_LEN] = new
    return old, new


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
    all_descs = build_id_descriptors(vmlinux, 0, len(vmlinux))
    if not all_descs:
        print(f"normalize-build-id: no GNU build-id note in {vmlinux_path}; nothing to do")
        return 0

    vdsos = embedded_vdso_ranges(vmlinux)
    mapping = {}  # old descriptor bytes -> new descriptor bytes, for rewriting the packed copies

    # Recompute each embedded vDSO's build-id over that vDSO's own final bytes, before the main one.
    for desc in all_descs:
        owner = next(((b, b + sz) for (b, sz) in vdsos if b <= desc < b + sz), None)
        if owner is not None:
            old, new = recompute(vmlinux, desc, owner[0], owner[1])
            mapping[old] = new
            print(f"normalize-build-id: vDSO build-id @0x{desc:x} -> {new.hex()}")

    # Then the main vmlinux build-id, over the whole file now carrying the fixed vDSO ids.
    for desc in all_descs:
        if not any(b <= desc < b + sz for (b, sz) in vdsos):
            old, new = recompute(vmlinux, desc, 0, len(vmlinux))
            mapping[old] = new
            print(f"normalize-build-id: vmlinux build-id @0x{desc:x} -> {new.hex()}")

    with open(vmlinux_path, "wb") as f:
        f.write(vmlinux)

    # Rewrite the same descriptors wherever they survive into a separate packed binary (arm64 Image).
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

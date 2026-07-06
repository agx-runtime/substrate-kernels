"""
Build a flat `.kernel` bundle from a Linux kernel binary (and optional qboot /
initrd for TEE variants). substrate mmaps the output, reads the fixed 96-byte
header, copies the payload to `load_addr`, and enters at `entry_addr` — with no
kernel-image parser of its own (ADR 0004).

The bundle's 4-byte magic is the substrate-native `SUBK` (CLAUDE.md §1). The
header layout is a fixed, versioned struct; the ELF flattening, the raw-Image path,
the address math, and the section alignment are all standard.

Header (little-endian, ADR 0003):

    Offset  Size  Field
    0       4     magic            "SUBK"
    4       4     format_version   u32, currently 1
    8       4     abi_version      u32, the bundle ABI version
    12      4     arch             u32: 1=x86_64, 2=aarch64, 3=riscv64
    16      4     variant          u32: 0=base, 1=sev, 2=tdx, 3=windows, 4=debug
    20      4     page_size        u32: section alignment (65536, or 4096 for windows)
    24      8     load_addr        u64
    32      8     entry_addr       u64
    40      8     kernel_offset    u64
    48      8     kernel_size      u64
    56      8     qboot_offset     u64 (0 if absent)
    64      8     qboot_size       u64
    72      8     initrd_offset    u64 (0 if absent)
    80      8     initrd_size      u64
    88      8     header_size      u64 (96 for v1)
    96..    pad to page_size
            kernel bytes (page-aligned size)
            pad to page_size
            qboot bytes (if present, page-aligned size)
            pad to page_size
            initrd bytes (if present, page-aligned size)
"""

import argparse
import struct
import sys

# 64 KiB covers 4 K / 16 K / 64 K Linux host page sizes; windows uses 4 KiB to
# match the Windows Hypervisor Platform page granularity (ADR 0002/0003).
PAGE_SIZE_DEFAULT = 65536
PAGE_SIZE_WINDOWS = 4096

# Raw-Image load+entry bases (ADR 0004): the kernel is loaded at the start of the
# consumer's guest RAM, so each base IS that machine model's DRAM base.
#   aarch64: substrate bases guest DRAM at 1 GiB (devices live below it); loading
#     anywhere else re-creates the boot floor ADR 0004 records.
#   riscv64: the QEMU-virt riscv memory map bases DRAM at 2 GiB (carried, not a
#     substrate boot target — ADR 0002).
RAW_LOAD_ADDR_AARCH64 = 0x40000000
RAW_LOAD_ADDR_RISCV64 = 0x80000000

# arm64 Image header (Documentation/arch/arm64/booting.rst): the image is placed at
# a 2 MiB-aligned base + text_offset, with text_offset read from the header (bytes
# 8..16, little-endian) — 0 on modern kernels including the pinned 6.12, but read,
# never assumed. The magic at bytes 56..60 ("ARM\x64") identifies an arm64 Image.
ARM64_IMAGE_MAGIC = 0x644D5241
ARM64_IMAGE_HEADER_SIZE = 64
ARM64_LOAD_ALIGN = 0x200000

MAGIC = b"SUBK"
FORMAT_VERSION = 1
HEADER_SIZE = 96
HEADER_STRUCT = "<4sIIIIIQQQQQQQQQ"
assert struct.calcsize(HEADER_STRUCT) == HEADER_SIZE

ARCH_IDS = {"x86_64": 1, "aarch64": 2, "riscv64": 3}
VARIANT_IDS = {"base": 0, "sev": 1, "tdx": 2, "windows": 3, "debug": 4}


def _import_elffile():
    # Lazy: aarch64 / riscv64 builds use a raw Image and don't need pyelftools.
    from elftools.elf.elffile import ELFFile
    return ELFFile


def align_up(n, a):
    return (n + a - 1) // a * a


def flatten_elf(path, page_size):
    """Flatten an x86_64 vmlinux ELF into a contiguous, page-padded byte image.
    Returns (load_addr, entry_addr, payload_bytes). `load_addr` is the first
    PT_LOAD's `p_vaddr & 0xFFFFFFF` (the low bits that recover the physical load
    base from the kernel virtual address); `entry_addr` is the ELF `e_entry` (the
    64-bit `startup_64`, entered with a boot_params zero-page — ADR 0004)."""
    ELFFile = _import_elffile()
    with open(path, "rb") as f:
        elffile = ELFFile(f)
        entry_addr = elffile["e_entry"]

        load_segments = [
            s for s in elffile.iter_segments() if s["p_type"] == "PT_LOAD"
        ]

        chunks = []
        total_size = 0
        load_addr = None
        prev_paddr = None
        prev_filesz = None

        for segment in load_segments:
            if prev_paddr is None:
                load_addr = segment["p_vaddr"] & 0xFFFFFFF
            else:
                pad = segment["p_paddr"] - prev_paddr - prev_filesz
                if pad < 0:
                    raise ValueError(
                        f"PT_LOAD overlap: paddr={segment['p_paddr']:#x} "
                        f"prev_paddr={prev_paddr:#x} prev_filesz={prev_filesz:#x}"
                    )
                chunks.append(b"\x00" * pad)
                total_size += pad

            assert segment["p_paddr"] - load_addr == total_size, (
                f"PT_LOAD layout mismatch: paddr={segment['p_paddr']:#x} "
                f"load_addr={load_addr:#x} total_size={total_size:#x}"
            )

            data = segment.data()
            chunks.append(data)
            prev_paddr = segment["p_paddr"]
            prev_filesz = segment["p_filesz"]
            total_size += prev_filesz

        rounded = align_up(total_size, page_size)
        if rounded > total_size:
            chunks.append(b"\x00" * (rounded - total_size))

        return load_addr, entry_addr, b"".join(chunks)


def flatten_raw(path, page_size):
    """Read a raw kernel/qboot/initrd file and pad to a page boundary."""
    with open(path, "rb") as f:
        data = f.read()
    rounded = align_up(len(data), page_size)
    if rounded > len(data):
        data += b"\x00" * (rounded - len(data))
    return data


def arm64_load_addr(image):
    """Guest-physical load base for an arm64 Image: the consumer's DRAM base plus
    the header's text_offset (Documentation/arch/arm64/booting.rst — the image is
    placed at a 2 MiB-aligned base + text_offset, and entered at its start).
    Validates the Image magic so packing the wrong file is a hard error, never a
    silently mis-addressed bundle (CLAUDE.md §5)."""
    if len(image) < ARM64_IMAGE_HEADER_SIZE:
        raise ValueError(
            f"arm64 Image shorter than its {ARM64_IMAGE_HEADER_SIZE}-byte header: "
            f"{len(image)} bytes")
    magic = struct.unpack_from("<I", image, 56)[0]
    if magic != ARM64_IMAGE_MAGIC:
        raise ValueError(
            f"arm64 Image magic mismatch at offset 56: {magic:#010x} != "
            f"{ARM64_IMAGE_MAGIC:#010x} — not an arm64 Image")
    text_offset = struct.unpack_from("<Q", image, 8)[0]
    base = RAW_LOAD_ADDR_AARCH64
    assert base % ARM64_LOAD_ALIGN == 0, (
        f"aarch64 load base {base:#x} not 2 MiB-aligned (booting.rst)")
    return base + text_offset


def build_bundle(arch, variant, abi_version, page_size, kernel_payload, load_addr,
                 entry_addr, qboot_payload, initrd_payload):
    """Assemble header + page_size-aligned payloads into one bytes object.
    Asserts section offsets are page-aligned and non-overlapping (CLAUDE.md §5)."""
    arch_id = ARCH_IDS[arch]
    variant_id = VARIANT_IDS[variant]

    kernel_offset = align_up(HEADER_SIZE, page_size)
    kernel_size = len(kernel_payload)
    after_kernel = kernel_offset + kernel_size

    if qboot_payload is not None:
        qboot_offset = align_up(after_kernel, page_size)
        qboot_size = len(qboot_payload)
        after_qboot = qboot_offset + qboot_size
    else:
        qboot_offset = 0
        qboot_size = 0
        after_qboot = after_kernel

    if initrd_payload is not None:
        initrd_offset = align_up(after_qboot, page_size)
        initrd_size = len(initrd_payload)
    else:
        initrd_offset = 0
        initrd_size = 0

    # Layout self-asserts: every present section is page-aligned and the payload
    # sizes are already page-multiples, so sections cannot overlap.
    for off in (kernel_offset, qboot_offset, initrd_offset):
        assert off % page_size == 0, f"section offset {off:#x} not {page_size}-aligned"
    assert kernel_size % page_size == 0, "kernel payload not page-padded"

    header = struct.pack(
        HEADER_STRUCT,
        MAGIC,
        FORMAT_VERSION,
        abi_version,
        arch_id,
        variant_id,
        page_size,
        load_addr,
        entry_addr,
        kernel_offset,
        kernel_size,
        qboot_offset,
        qboot_size,
        initrd_offset,
        initrd_size,
        HEADER_SIZE,
    )

    chunks = [header]
    cursor = HEADER_SIZE

    chunks.append(b"\x00" * (kernel_offset - cursor))
    chunks.append(kernel_payload)
    cursor = kernel_offset + kernel_size

    if qboot_payload is not None:
        chunks.append(b"\x00" * (qboot_offset - cursor))
        chunks.append(qboot_payload)
        cursor = qboot_offset + qboot_size

    if initrd_payload is not None:
        chunks.append(b"\x00" * (initrd_offset - cursor))
        chunks.append(initrd_payload)
        cursor = initrd_offset + initrd_size

    return b"".join(chunks)


def pack(arch, variant, abi_version, kernel, qboot=None, initrd=None):
    """Pure-function packer used by the CLI and the golden/unit tests."""
    page_size = PAGE_SIZE_WINDOWS if variant == "windows" else PAGE_SIZE_DEFAULT

    if arch == "x86_64":
        load_addr, entry_addr, kernel_payload = flatten_elf(kernel, page_size)
    elif arch == "aarch64":
        kernel_payload = flatten_raw(kernel, page_size)
        load_addr = entry_addr = arm64_load_addr(kernel_payload)
    else:
        kernel_payload = flatten_raw(kernel, page_size)
        load_addr = entry_addr = RAW_LOAD_ADDR_RISCV64

    qboot_payload = flatten_raw(qboot, page_size) if qboot else None
    initrd_payload = flatten_raw(initrd, page_size) if initrd else None

    return build_bundle(
        arch=arch,
        variant=variant,
        abi_version=abi_version,
        page_size=page_size,
        kernel_payload=kernel_payload,
        load_addr=load_addr,
        entry_addr=entry_addr,
        qboot_payload=qboot_payload,
        initrd_payload=initrd_payload,
    )


def main():
    p = argparse.ArgumentParser(
        description="Build a flat .kernel bundle for substrate")
    p.add_argument("--arch", required=True, choices=sorted(ARCH_IDS.keys()))
    p.add_argument("--variant", required=True, choices=sorted(VARIANT_IDS.keys()))
    p.add_argument("--abi-version", type=int, required=True)
    p.add_argument("--kernel", required=True,
                   help="vmlinux (x86_64) or Image (aarch64/riscv64)")
    p.add_argument("--qboot", default=None, help="qboot firmware (TEE variants only)")
    p.add_argument("--initrd", default=None, help="initrd (TEE variants only)")
    p.add_argument("--output", required=True)
    args = p.parse_args()

    if args.variant in ("base", "windows") and (args.qboot or args.initrd):
        print("warning: --qboot/--initrd provided for a non-TEE variant",
              file=sys.stderr)

    bundle = pack(
        arch=args.arch,
        variant=args.variant,
        abi_version=args.abi_version,
        kernel=args.kernel,
        qboot=args.qboot,
        initrd=args.initrd,
    )

    with open(args.output, "wb") as f:
        f.write(bundle)

    page_size = PAGE_SIZE_WINDOWS if args.variant == "windows" else PAGE_SIZE_DEFAULT
    print(
        f"wrote {args.output}: arch={args.arch} variant={args.variant} "
        f"abi={args.abi_version} page_size={page_size} total={len(bundle)}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

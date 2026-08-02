#!/usr/bin/env python3
"""Map differing bytes between two ELF files to the sections they fall in.

Temporary diagnostic for the cross-machine reproducibility investigation. It takes the output of
`readelf -SW <fileA>` (the section header table, whose Off and Size columns are file offsets in hex) and
the output of `cmp -l <fileA> <fileB>` (one line per differing byte, the first column a 1-based decimal
file offset), and reports how many differing bytes fall in each section. That names the actual source of
a non-deterministic build instead of leaving it to be guessed from a raw byte count.

Usage: diff-sections.py <sections-from-readelf-SW> <diffs-from-cmp-l>
"""
import re
import sys
from collections import Counter


def parse_sections(path):
    """Return [(start, end, name)] file-offset ranges from `readelf -SW` output."""
    ranges = []
    # [Nr] Name Type Address Off Size ES Flg Lk Inf Al — Address, Off, Size are hex without 0x.
    row = re.compile(r"\s*\[\s*\d+\]\s+(\S+)\s+\S+\s+[0-9a-fA-F]+\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)")
    for line in open(path):
        m = row.match(line)
        if not m:
            continue
        name, off, size = m.group(1), int(m.group(2), 16), int(m.group(3), 16)
        if size:
            ranges.append((off, off + size, name))
    return ranges


def section_of(ranges, offset):
    for start, end, name in ranges:
        if start <= offset < end:
            return name
    return "(elf header / gap / not in any section)"


def main():
    if len(sys.argv) != 3:
        print("usage: diff-sections.py <readelf-SW-output> <cmp-l-output>", file=sys.stderr)
        return 2
    ranges = parse_sections(sys.argv[1])
    per_section = Counter()
    samples = []
    for line in open(sys.argv[2]):
        parts = line.split()
        if not parts:
            continue
        # cmp -l offsets are 1-based decimal; the byte values are octal.
        offset = int(parts[0]) - 1
        name = section_of(ranges, offset)
        per_section[name] += 1
        if len(samples) < 16:
            samples.append((hex(offset), name, parts[1] if len(parts) > 1 else "?",
                            parts[2] if len(parts) > 2 else "?"))
    print("differing bytes per ELF section:")
    for name, count in per_section.most_common():
        print(f"  {count:>8}  {name}")
    print("first differing bytes (file-offset-hex, section, octalA, octalB):")
    for s in samples:
        print("  ", s)
    return 0


if __name__ == "__main__":
    sys.exit(main())

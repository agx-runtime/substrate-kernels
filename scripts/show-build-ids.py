#!/usr/bin/env python3
"""Print each GNU build-id in a vmlinux next to what it would be under each recompute scope.

Temporary diagnostic. `normalize-build-id.py` recomputes an embedded vDSO's build-id over the vDSO's own
bytes and the main build-id over the whole file. If two machines disagree about where a vDSO is — because
`embedded_vdso_ranges` found it on one and not the other — the same descriptor gets hashed under a
different scope and the "normalized" ids diverge even though the bodies are identical. This shows, per
descriptor, the current value and both candidate recomputes, so a scope mismatch is visible directly.

Usage: show-build-ids.py <vmlinux>
"""
import hashlib
import importlib.util
import os
import sys

_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("nrm", os.path.join(_here, "normalize-build-id.py"))
nrm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(nrm)


def sha20(data):
    return hashlib.sha256(bytes(data)).digest()[:20].hex()


def main():
    buf = bytearray(open(sys.argv[1], "rb").read())
    descs = nrm.build_id_descriptors(buf, 0, len(buf))
    vdsos = nrm.embedded_vdso_ranges(buf)
    print(f"{sys.argv[1]}: {len(descs)} build-id notes, {len(vdsos)} embedded vDSOs at "
          f"{[hex(b) for b, _ in vdsos]}")
    for d in descs:
        cur = bytes(buf[d:d + 20]).hex()
        whole = bytearray(buf)
        whole[d:d + 20] = b"\x00" * 20
        whole_rc = sha20(whole)
        owner = next(((b, b + s) for (b, s) in vdsos if b <= d < b + s), None)
        if owner:
            reg = bytearray(buf[owner[0]:owner[1]])
            reg[d - owner[0]:d - owner[0] + 20] = b"\x00" * 20
            vdso_rc = sha20(reg)
        else:
            vdso_rc = "(not in a vDSO)"
        tag = "vDSO-scope" if cur == (vdso_rc if owner else "") else \
              "whole-vmlinux-scope" if cur == whole_rc else "MATCHES NEITHER (unnormalized ld id?)"
        print(f"  @0x{d:x} cur={cur}")
        print(f"           vdso_scope_recompute ={vdso_rc}")
        print(f"           whole_scope_recompute={whole_rc}   => current matches: {tag}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

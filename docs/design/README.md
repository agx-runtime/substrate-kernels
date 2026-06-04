# Design documents

A **design document gates every build component.** substrate-kernels builds a guest
kernel from a pinned upstream tree (CLAUDE.md §1) rather than inheriting a distro
kernel or a forked tree. The risk is that a from-scratch build silently drops a
subtle correctness/boot detail — a config dependency, a boot-protocol field, a
patch's real precondition. So the discipline mirrors substrate's:

> **Write the design doc → implement.** Before building a component, capture its
> subtle/security-critical details here — what the contract is, where the
> hazards are, and how *our* build handles each — and only then write the Makefile
> target / patch / config / packer code. A built component that lacks its design
> doc, or whose code diverges from it, is a bug.

Each doc follows the template: **Background** → **Subtle details & gotchas** (a
table: *detail · convention · our handling · the locking gate*) → **Our design** →
**Verification**.

## Component → design-doc map

| Component | Approach | Design doc |
|---|---|---|
| The build pipeline | Makefile targets | [build-pipeline.md](build-pipeline.md) |
| The kernel bundle | substrate-native header + packer (`SUBK`) | [bundle-format.md](bundle-format.md) |
| The kernel config | curated per (arch, variant) | [kernel-config.md](kernel-config.md) |
| The patch series | ordered, justified series | [patches.md](patches.md) |
| The initramfs | base: substrate-supplied ext4; TEE: vendored blob | [initramfs.md](initramfs.md) |
| Reproducibility | pinned container + fixed metadata | [reproducibility.md](reproducibility.md) |
| The download proxy | CF Worker over R2, with one analytics event per download | [download-proxy.md](download-proxy.md) |

## Naming ([CLAUDE.md](../../CLAUDE.md) §1)

Every design doc, like every patch and config comment, is **substrate-native**: the
bundle magic is `SUBK` and the packer is `pack-kernel`, both substrate's own names;
the producer is substrate-kernels, the consumer is substrate.

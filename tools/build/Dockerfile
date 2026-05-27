# Pinned toolchain container for the Linux-only build stages (ADR 0005).
#
# Kernel output is sensitive to the compiler/binutils/build utilities, so the
# whole toolchain is pinned: the base image by sha256 digest below, and the build
# packages by the distro's pinned point release (bookworm). On a macOS dev host the
# Linux stages run inside this image; on Linux CI they run in the same image. Both
# paths must produce byte-identical bundles (`make repro-check`).
#
# Bumping this image (a new digest) is an explicit, reviewed change that re-runs
# repro-check, exactly like bumping the source pin (ADR 0001).
#
# Digest resolved for docker.io/library/debian:bookworm-slim (multi-arch index),
# so the same FROM line pulls the right manifest on x86_64 and aarch64 hosts.
FROM debian:bookworm-slim@sha256:0104b334637a5f19aa9c983a91b54c89887c0984081f2068983107a6f6c21eeb

# Kernel build dependencies + the ELF library the packer needs. python3-pyelftools
# is required by pack-kernel for x86_64 vmlinux PT_LOAD flattening.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        xz-utils \
        patch \
        make \
        gcc \
        binutils \
        bc \
        bison \
        flex \
        cpio \
        kmod \
        libelf-dev \
        libssl-dev \
        dwarves \
        python3 \
        python3-pyelftools \
        gcc-aarch64-linux-gnu \
        gcc-x86-64-linux-gnu \
        gcc-riscv64-linux-gnu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /work

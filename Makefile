# substrate-kernels — build a pre-flattened .kernel bundle from a pinned Linux tree.
#
# Pipeline (architecture.md §2): pin → tarball (verify sha256) → source → patched →
# configured (olddefconfig + invariant gate) → compiled → bundle (pack-kernel).
# Each stage is a Makefile target; see docs/design/build-pipeline.md.
#
# Usage:
#   make                       # build base for the host arch
#   make ARCH=aarch64          # build base for aarch64
#   make VARIANT=windows       # build the windows variant (x86_64 only)
#   make ci                    # run the static gates
# On macOS the Linux-only stages run inside the pinned container automatically.

# ---- pin (ADR 0001) --------------------------------------------------------
include scripts/kernel-pin.env
export KERNEL_VERSION KERNEL_SHA256 KERNEL_URL

# ---- fixed build metadata (ADR 0005) ---------------------------------------
# Fixed constants so nothing wall-clock- or host-dependent leaks into the image.
ABI_VERSION         ?= 1
# Parallel compile jobs. Defaults to all cores; lower it (e.g. JOBS=4) where the
# build environment's RAM is the constraint rather than CPU.
JOBS                ?= $(shell nproc 2>/dev/null || echo 4)
KBUILD_BUILD_TIMESTAMP ?= Fri May  8 14:25:15 CEST 2026
KBUILD_BUILD_USER   ?= root
# Frozen at the historical name deliberately: this string is baked into every
# kernel image (LINUX_COMPILE_HOST), so renaming it changes the bytes — and the
# sha256 — of a rebuild of an already-released version (ADR 0005 / CLAUDE.md §3).
# Rename to substrate-kernels at the next pin bump, when the bytes change anyway.
KBUILD_BUILD_HOST   ?= substrate-kernel
export KBUILD_BUILD_TIMESTAMP KBUILD_BUILD_USER KBUILD_BUILD_HOST

# ---- variant + arch selection (ADR 0002) -----------------------------------
VARIANT  ?= base
HOSTARCH := $(shell uname -m)
ARCH     ?= $(HOSTARCH)
# Normalize arch aliases to the substrate-kernels arch id.
ifeq ($(ARCH),arm64)
  GUESTARCH := aarch64
else ifeq ($(ARCH),riscv)
  GUESTARCH := riscv64
else
  GUESTARCH := $(ARCH)
endif

# windows / sev / tdx are x86_64-only variants.
ifneq ($(filter $(VARIANT),sev tdx windows),)
  ifneq ($(GUESTARCH),x86_64)
    $(error VARIANT=$(VARIANT) is x86_64-only (got arch=$(GUESTARCH)))
  endif
endif

# Kernel Kbuild ARCH + a fixed cross toolchain (used for ALL arches so the
# compiler is host-arch-independent — better reproducibility, ADR 0005).
KERNEL_ARCH_x86_64  := x86
KERNEL_ARCH_aarch64 := arm64
KERNEL_ARCH_riscv64 := riscv
CROSS_x86_64  := x86_64-linux-gnu-
CROSS_aarch64 := aarch64-linux-gnu-
CROSS_riscv64 := riscv64-linux-gnu-
KERNEL_ARCH   := $(KERNEL_ARCH_$(GUESTARCH))
CROSS_COMPILE := $(CROSS_$(GUESTARCH))

# Per-arch kernel binary the packer consumes (ADR 0004).
KBINARY_x86_64  := vmlinux
KBINARY_aarch64 := arch/arm64/boot/Image
KBINARY_riscv64 := arch/riscv/boot/Image
KERNEL_BINARY   := $(KBINARY_$(GUESTARCH))

# ---- paths -----------------------------------------------------------------
TARBALL := tarballs/linux-$(KERNEL_VERSION).tar.xz
BUILD   := build/$(VARIANT)-$(GUESTARCH)
SRC     := $(BUILD)/linux-$(KERNEL_VERSION)
CONFIG  := config-$(VARIANT)_$(GUESTARCH)
BUNDLE  := linux-$(KERNEL_VERSION)-$(VARIANT)-$(GUESTARCH).kernel
PREFIX  ?= /usr/local

# Patch series: base series always; the quarantined TEE series for sev/tdx (ADR 0009).
PATCHES := $(sort $(wildcard patches/*.patch))
ifneq ($(filter $(VARIANT),sev tdx),)
  PATCHES += $(sort $(wildcard patches-tee/*.patch))
endif

IMAGE := substrate-kernels-build
UNAME_S := $(shell uname -s)

.PHONY: all image build install clean ci repro-check \
        applies-clean configured config-invariant bundle-golden pack-unit \
        check-doc-manifest

# ===========================================================================
# macOS: run the Linux build inside the pinned container; Linux: build natively.
# ===========================================================================
ifeq ($(UNAME_S),Darwin)

# Kernel-tree targets need Linux + GNU patch + the pinned toolchain. On macOS,
# transparently re-run them inside the pinned container so the gates behave exactly
# as in CI — notably GNU patch's strict zero-fuzz / zero-offset apply, which BSD
# patch (the macOS host's) silently tolerates.
all applies-clean configured repro-check: image
	docker run --rm -v "$(CURDIR)":/work -w /work $(IMAGE) \
		make $@ ARCH='$(GUESTARCH)' VARIANT='$(VARIANT)' ABI_VERSION='$(ABI_VERSION)' JOBS='$(JOBS)'

else

all: $(BUNDLE)

applies-clean: $(SRC)/.patched
	@echo "applies-clean: series applied with zero fuzz ($(VARIANT)/$(GUESTARCH))"

configured: $(SRC)/.config
	@echo "configured: olddefconfig + config-invariant passed ($(VARIANT)/$(GUESTARCH))"

repro-check:
	$(MAKE) clean
	$(MAKE) $(BUNDLE)
	cp "$(BUNDLE)" "$(BUNDLE).repro1"
	rm -rf build "$(BUNDLE)"
	$(MAKE) $(BUNDLE)
	@cmp "$(BUNDLE)" "$(BUNDLE).repro1" \
		&& echo "repro-check: byte-identical rebuild ($(VARIANT)/$(GUESTARCH))" \
		|| { echo "repro-check: NON-DETERMINISTIC — bundles differ (root-cause, never tolerate — CLAUDE.md §9)"; exit 1; }
	@rm -f "$(BUNDLE).repro1"

endif

image:
	docker build -t $(IMAGE) tools/build

# ---- ① pin → tarball: fetch + verify sha256 BEFORE extraction (ADR 0001) ---
$(TARBALL):
	@mkdir -p tarballs
	curl -fL "$(KERNEL_URL)" -o "$(TARBALL).tmp"
	@echo "$(KERNEL_SHA256)  $(TARBALL).tmp" | sha256sum -c - \
		|| { echo "FATAL: sha256 mismatch for $(TARBALL) — refusing to extract"; rm -f "$(TARBALL).tmp"; exit 1; }
	@mv "$(TARBALL).tmp" "$(TARBALL)"

# ---- ② → ③ extract + apply patches at -p1 with zero fuzz (ADR 0007) --------
# The .patched stamp marks a freshly-extracted tree with the series applied. The
# `applies-clean` gate builds just this (no config, no compile).
$(SRC)/.patched: $(TARBALL) $(PATCHES)
	@rm -rf "$(BUILD)"
	@mkdir -p "$(BUILD)"
	tar -xf "$(TARBALL)" -C "$(BUILD)"
	@set -e; for p in $(PATCHES); do \
		out=$$(patch -p1 -F0 --no-backup-if-mismatch -d "$(SRC)" < "$$p" 2>&1) \
			|| { echo "$$out"; echo "PATCH FAILED: $$p (re-derive, never force — ADR 0007)"; exit 1; }; \
		if echo "$$out" | grep -qiE 'fuzz|offset'; then \
			echo "$$out"; echo "FUZZ/OFFSET in $$p — the patch and tree have drifted (ADR 0007)"; exit 1; \
		fi; \
		echo "applied $$p"; \
	done
	@touch "$(SRC)/.patched"

# ---- ③ → ④ configure: copy the per-cell config, normalize, assert invariants -
$(SRC)/.config: $(SRC)/.patched $(CONFIG)
	cp "$(CONFIG)" "$(SRC)/.config"
	$(MAKE) -C "$(SRC)" ARCH=$(KERNEL_ARCH) CROSS_COMPILE=$(CROSS_COMPILE) olddefconfig
	$(MAKE) config-invariant

# ---- ④ → ⑤ compile (fixed KBUILD_BUILD_* metadata, ADR 0005) ---------------
$(SRC)/$(KERNEL_BINARY): $(SRC)/.config
	cd "$(SRC)" && rm -f .version && \
		$(MAKE) ARCH=$(KERNEL_ARCH) CROSS_COMPILE=$(CROSS_COMPILE) \
			KBUILD_BUILD_TIMESTAMP="$(KBUILD_BUILD_TIMESTAMP)" \
			KBUILD_BUILD_USER="$(KBUILD_BUILD_USER)" \
			KBUILD_BUILD_HOST="$(KBUILD_BUILD_HOST)" \
			-j$(JOBS)

# ---- ⑤ → ⑥ pack the bundle (ADR 0003) --------------------------------------
$(BUNDLE): $(SRC)/$(KERNEL_BINARY)
	python3 scripts/pack-kernel.py \
		--arch $(GUESTARCH) \
		--variant $(VARIANT) \
		--abi-version $(ABI_VERSION) \
		--kernel "$(SRC)/$(KERNEL_BINARY)" \
		--output "$(BUNDLE)"

# `build` is an alias for `all`; both go through the container on macOS.
build: all

# ---- install / clean -------------------------------------------------------
install: all
	install -d "$(DESTDIR)$(PREFIX)/lib/substrate/kernels/"
	install -m 644 "$(BUNDLE)" "$(DESTDIR)$(PREFIX)/lib/substrate/kernels/"

clean:
	rm -rf build *.kernel *.kernel.repro1

# ===========================================================================
# Gates (testing/strategy.md). The pure-Python ones run on any host; the
# kernel-build ones (applies-clean, config-invariant) run in the build env.
# ===========================================================================
ci: check-doc-manifest bundle-golden pack-unit
	@echo "ci: static gates passed"

check-doc-manifest:
	scripts/check-doc-manifest.sh

bundle-golden:
	python3 tests/bundle-golden/run.py

pack-unit:
	python3 tests/pack-kernel/run.py

config-invariant:
	python3 scripts/config-invariant.py --arch $(GUESTARCH) --variant $(VARIANT) --config "$(SRC)/.config"

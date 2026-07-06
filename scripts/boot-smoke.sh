#!/usr/bin/env bash
# Interim QEMU boot smoke (testing/boot-smoke.md). Until substrate's loader lane is
# wired cross-repo, we validate that the *produced kernel boots* by entering it
# under QEMU and watching the console for the kernel's own early-boot banner.
# Seeing "Linux version" proves the image loads and starts (the config, the
# patches, and — for x86 — the entry path are right). A kernel panic AFTER the
# banner (no rootfs) still proves a successful boot.
#
# What this gate does NOT exercise: the bundle's `load_addr`/`entry_addr`. QEMU's
# own `-kernel` loader places the raw binary itself (for arm64, per the Image
# header, relative to the machine's RAM base), so the SUBK header addresses are
# never consulted here — they are locked byte-for-byte by bundle-golden and proven
# live by substrate's real boot-smoke (ADR 0004 §4). Note QEMU virt's DRAM base is
# 0x40000000 — exactly the canonical aarch64 load base of ADR 0004 — so this gate
# boots the same placement substrate uses.
#
# Each kernel is booted at TWO RAM sizes: 512 MiB — the small-RAM case that the old
# 0x80000000 aarch64 load base could never satisfy under a bundle-consuming loader
# (ADR 0004's boot-floor defect; kept small so a regression of that class is loud)
# — and 2048 MiB, the large case that always worked.
#
# This is NOT the real boot-smoke (that boots under substrate and reaches
# userspace); it is the interim stand-in for x86_64 + aarch64. riscv64 / windows
# are not covered.
#
# Usage: boot-smoke.sh --arch {x86_64|aarch64} --kernel <vmlinux|Image> [--timeout S]
set -uo pipefail

ARCH=""; KERNEL=""; TIMEOUT=120
while [ $# -gt 0 ]; do
	case "$1" in
		--arch) ARCH="$2"; shift 2;;
		--kernel) KERNEL="$2"; shift 2;;
		--timeout) TIMEOUT="$2"; shift 2;;
		*) echo "unknown arg: $1" >&2; exit 2;;
	esac
done
[ -n "$ARCH" ] && [ -n "$KERNEL" ] || { echo "usage: boot-smoke.sh --arch A --kernel K" >&2; exit 2; }
[ -f "$KERNEL" ] || { echo "[boot-smoke] FATAL: kernel not found: $KERNEL — run 'make ARCH=$ARCH' first" >&2; exit 1; }

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

# Use KVM when the guest arch matches the host and /dev/kvm is usable (near-native,
# e.g. aarch64 on an arm64 runner); otherwise fall back to TCG emulation. `-cpu host`
# is only valid under KVM, so it is paired with the accelerator.
HOSTARCH="$(uname -m)"
if [ "$ARCH" = "$HOSTARCH" ] && [ -r /dev/kvm ]; then
	accel=kvm; cpu=host
	echo "[boot-smoke] /dev/kvm usable and guest arch == host ($HOSTARCH) — using KVM"
else
	accel=tcg; cpu=max
	echo "[boot-smoke] using TCG (guest=$ARCH host=$HOSTARCH; /dev/kvm $([ -e /dev/kvm ] && echo present || echo absent))"
fi

case "$ARCH" in
	x86_64)
		bin="qemu-system-x86_64"
		machine="q35,accel=$accel"
		append="console=ttyS0 earlyprintk=ttyS0"
		;;
	aarch64)
		bin="qemu-system-aarch64"
		machine="virt,accel=$accel"
		append="console=ttyAMA0 earlycon"
		;;
	*)
		echo "[boot-smoke] FATAL: interim boot covers x86_64 + aarch64 only (got $ARCH)" >&2
		exit 1
		;;
esac

command -v "$bin" >/dev/null || { echo "[boot-smoke] FATAL: $bin not installed" >&2; exit 1; }

MARKER='Linux version|Booting Linux|Kernel command line'

# Boot the kernel with the given RAM size and poll the console for the banner.
# `panic=-1` would reboot; we keep the guest alive briefly and rely on the timeout.
# No rootfs is supplied — the kernel boots, prints its banner, then panics on VFS,
# which is exactly the "kernel ran" signal we want for the interim check. With no
# rootfs the guest just sits after the panic (it never reboots), so we must NOT
# wait for QEMU to exit — we kill it the instant the banner appears. The timeout is
# only the upper bound for a kernel that never reaches the banner (a real failure).
boot_once() {
	ram_mib="$1"
	: >"$log"
	echo "[boot-smoke] booting $ARCH kernel under QEMU ($accel, ${ram_mib} MiB; ${TIMEOUT}s ceiling)..."
	"$bin" -machine "$machine" -cpu "$cpu" -m "$ram_mib" -nographic -no-reboot \
		-kernel "$KERNEL" -append "$append" >"$log" 2>&1 &
	qpid=$!

	ok=0
	deadline=$((SECONDS + TIMEOUT))
	while kill -0 "$qpid" 2>/dev/null; do
		if grep -qiE "$MARKER" "$log"; then ok=1; break; fi
		if [ "$SECONDS" -ge "$deadline" ]; then break; fi
		sleep 1
	done

	kill "$qpid" 2>/dev/null || true
	wait "$qpid" 2>/dev/null || true

	if [ "$ok" -eq 1 ] || grep -qiE "$MARKER" "$log"; then
		echo "[boot-smoke] PASS at ${ram_mib} MiB — kernel booted:"
		grep -iE 'Linux version|Booting Linux' "$log" | head -1
		return 0
	fi

	echo "[boot-smoke] FAIL at ${ram_mib} MiB — no kernel banner within ${TIMEOUT}s. Console tail:" >&2
	tail -30 "$log" >&2
	return 1
}

boot_once 512 || exit 1
boot_once 2048 || exit 1
echo "[boot-smoke] PASS — both RAM cases booted (512 MiB, 2048 MiB)"

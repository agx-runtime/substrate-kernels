#!/usr/bin/env bash
# Interim QEMU boot smoke (testing/boot-smoke.md). substrate's loader does not yet
# consume the SUBK bundle (cross-repo, ADR 0004 §5), so until then we validate that
# the *produced kernel boots* by entering it under QEMU and watching the console for
# the kernel's own early-boot banner. Seeing "Linux version" proves the image loads
# and starts (the config, the patches, and — for x86 — the entry path are right). A
# kernel panic AFTER the banner (no rootfs) still proves a successful boot.
#
# This is NOT the real boot-smoke (that boots under substrate and reaches userspace);
# it is the interim stand-in for x86_64 + aarch64. riscv64 / windows are not covered.
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

# `panic=-1` would reboot; we keep the guest alive briefly and rely on the timeout.
# No rootfs is supplied — the kernel boots, prints its banner, then panics on VFS,
# which is exactly the "kernel ran" signal we want for the interim check.
case "$ARCH" in
	x86_64)
		bin="qemu-system-x86_64"
		args=(-machine q35 -cpu max -m 512 -nographic -no-reboot
		      -kernel "$KERNEL" -append "console=ttyS0 earlyprintk=ttyS0")
		;;
	aarch64)
		bin="qemu-system-aarch64"
		args=(-machine virt -cpu max -m 512 -nographic -no-reboot
		      -kernel "$KERNEL" -append "console=ttyAMA0 earlycon")
		;;
	*)
		echo "[boot-smoke] FATAL: interim boot covers x86_64 + aarch64 only (got $ARCH)" >&2
		exit 1
		;;
esac

command -v "$bin" >/dev/null || { echo "[boot-smoke] FATAL: $bin not installed" >&2; exit 1; }

echo "[boot-smoke] booting $ARCH kernel under QEMU (timeout ${TIMEOUT}s)..."
timeout "${TIMEOUT}" "$bin" "${args[@]}" >"$log" 2>&1 || true

if grep -qiE 'Linux version|Booting Linux|Kernel command line' "$log"; then
	echo "[boot-smoke] PASS — kernel booted (banner observed):"
	grep -iE 'Linux version|Booting Linux' "$log" | head -1
	exit 0
fi

echo "[boot-smoke] FAIL — no kernel banner within ${TIMEOUT}s. Console tail:" >&2
tail -30 "$log" >&2
exit 1

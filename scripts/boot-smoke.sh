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

# `panic=-1` would reboot; we keep the guest alive briefly and rely on the timeout.
# No rootfs is supplied — the kernel boots, prints its banner, then panics on VFS,
# which is exactly the "kernel ran" signal we want for the interim check.
case "$ARCH" in
	x86_64)
		bin="qemu-system-x86_64"
		args=(-machine "q35,accel=$accel" -cpu "$cpu" -m 512 -nographic -no-reboot
		      -kernel "$KERNEL" -append "console=ttyS0 earlyprintk=ttyS0")
		;;
	aarch64)
		bin="qemu-system-aarch64"
		args=(-machine "virt,accel=$accel" -cpu "$cpu" -m 512 -nographic -no-reboot
		      -kernel "$KERNEL" -append "console=ttyAMA0 earlycon")
		;;
	*)
		echo "[boot-smoke] FATAL: interim boot covers x86_64 + aarch64 only (got $ARCH)" >&2
		exit 1
		;;
esac

command -v "$bin" >/dev/null || { echo "[boot-smoke] FATAL: $bin not installed" >&2; exit 1; }

MARKER='Linux version|Booting Linux|Kernel command line'

# Run QEMU in the background and poll its console. With no rootfs the guest panics
# on VFS and just sits there (it never reboots), so we must NOT wait for QEMU to
# exit — we kill it the instant the banner appears. The timeout is only the
# upper bound for a kernel that never reaches the banner (a real boot failure).
echo "[boot-smoke] booting $ARCH kernel under QEMU ($accel; ${TIMEOUT}s ceiling)..."
"$bin" "${args[@]}" >"$log" 2>&1 &
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
	echo "[boot-smoke] PASS — kernel booted (banner observed after ~$((SECONDS - (deadline - TIMEOUT)))s):"
	grep -iE 'Linux version|Booting Linux' "$log" | head -1
	exit 0
fi

echo "[boot-smoke] FAIL — no kernel banner within ${TIMEOUT}s. Console tail:" >&2
tail -30 "$log" >&2
exit 1

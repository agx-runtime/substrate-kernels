# The verbs. Every recipe is a thin alias over a flake output or a checked-in script; logic
# belongs in the flake, never here (ADR 0017). `just` with no arguments lists every verb.
#
# `line` selects the LTS line the same way `make KERNEL_LINE=` used to:
#     just line=6.18 build
# and the guest architecture defaults to this machine's, so `just build` on an Apple Silicon
# laptop builds (or substitutes) the aarch64 base bundle.

line := "6.12"
# Flake attribute names carry the line with an underscore (kernel-6_12-…), because a dot in a
# `.#` fragment splits the attribute path; this translation is why the verbs accept `6.12`.
line_attr := replace(line, ".", "_")
guest_arch := if arch() == "aarch64" { "aarch64" } else { "x86_64" }

default:
    @just --list

# Build one bundle cell into ./result. On a machine already holding what the cache serves,
# this is a download rather than a compile, because CI pushed the same store path to cachet.
build variant="base" garch=guest_arch:
    nix build --print-build-logs '.#kernel-{{ line_attr }}-{{ variant }}-{{ garch }}'

# Every gate for this system: the static gates, applies-clean for both lines, and — on a
# Linux system — each configured gate whose cell builds here.
ci:
    nix flake check --print-build-logs

# The patch series applies at -p1 with zero fuzz and zero offset against the pinned tree.
applies-clean:
    nix build --print-build-logs '.#applies-clean-{{ line_attr }}'

# olddefconfig plus the config-invariant gate for one cell, without compiling.
configured variant="base" garch=guest_arch:
    nix build --print-build-logs '.#configured-{{ line_attr }}-{{ variant }}-{{ garch }}'

# Byte-identical rebuild of one cell. The first build may substitute from the cache; the
# --rebuild then compiles locally and fails if the result differs from what the first build
# produced — so on a substituted path this also verifies the cache serves what the source
# builds (ADR 0005).
repro-check variant="base" garch=guest_arch:
    nix build '.#kernel-{{ line_attr }}-{{ variant }}-{{ garch }}'
    nix build --rebuild --print-build-logs '.#kernel-{{ line_attr }}-{{ variant }}-{{ garch }}'

# Boot the built cell's raw kernel binary under QEMU and wait for the banner
# (testing/boot-smoke.md). QEMU comes from the host, so this verb is for Linux machines and
# the CI smoke lane.
boot-smoke variant="base" garch=guest_arch: (build variant garch)
    bash scripts/boot-smoke.sh --arch {{ garch }} --kernel result/kernel-binary --timeout 240

# Stage the built bundle where substrate looks for it.
install prefix="/usr/local" variant="base" garch=guest_arch: (build variant garch)
    install -d "{{ prefix }}/lib/substrate/kernels/"
    install -m 644 result/*.kernel "{{ prefix }}/lib/substrate/kernels/"

# The Infisical project that holds the shared read token — cachet's workspace, and the same one from any
# repository, because the token lives there regardless of which repo authenticates. Passed explicitly so
# this verb never depends on the copied script's baked-in default staying in sync with cachet's.
cache_infisical_project_id := "7c433b42-4d98-4d30-b3dc-daf7111ef7cc"

# Authenticate this machine to the org binary cache. Host-level and idempotent: one run
# covers every project on the machine (the canonical script lives in the cachet repository).
cache-login *args:
    sh scripts/cache-login.sh --infisical-project-id {{ cache_infisical_project_id }} {{ args }}

clean:
    rm -f result result-*

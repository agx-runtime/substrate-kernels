# The kernel build pipeline as Nix derivations (ADR 0017).
#
# Three constructors, one per gate depth. `bundle` builds a full cell of the matrix — one
# (line, variant, guest architecture) triple — from the pinned tarball to the packed `.kernel`
# file. `appliesClean` and `configured` are the two fast gates that precede a compile: the
# first proves the patch series still fits the pinned tree, and the second proves the
# normalized config still satisfies the invariant gate, so a pull request fails in minutes
# rather than after a forty-minute compile.
#
# why each constructor re-extracts the tarball instead of sharing a patched-tree derivation:
# a patched kernel tree is roughly 1.5 GB, CI pushes every store path it builds to the binary
# cache, and a shared tree derivation would therefore push gigabytes per line to save a
# roughly thirty-second extraction. The tarball itself is deduplicated by its store hash, so
# re-extraction costs time only (ADR 0017).
let
    # Kbuild's ARCH name for each guest architecture.
    kernelArchOf = {
        x86_64 = "x86";
        aarch64 = "arm64";
        riscv64 = "riscv";
    };

    # The make target and the binary the packer consumes (ADR 0004). x86_64 packs the vmlinux
    # ELF, because substrate enters the 64-bit `startup_64` with a boot_params zero-page;
    # aarch64 and riscv64 pack the raw Image. Building the named target rather than `all`
    # skips the compressed images (bzImage, Image.gz) that nothing consumes.
    makeTargetOf = {
        x86_64 = "vmlinux";
        aarch64 = "Image";
        riscv64 = "Image";
    };
    kernelBinaryOf = {
        x86_64 = "vmlinux";
        aarch64 = "arch/arm64/boot/Image";
        riscv64 = "arch/riscv/boot/Image";
    };

    # Fixed build metadata, so nothing wall-clock- or host-dependent reaches the image
    # (ADR 0005). The host name is baked into every kernel image as LINUX_COMPILE_HOST, so
    # changing it changes the bytes of every bundle; the switch from the historical
    # `substrate-kernel` to this name landed with the Nix toolchain, which changed the bytes
    # of every bundle anyway.
    kbuildEnv = {
        KBUILD_BUILD_TIMESTAMP = "Fri May  8 14:25:15 CEST 2026";
        KBUILD_BUILD_USER = "root";
        KBUILD_BUILD_HOST = "substrate-kernels";
    };

    # Apply the series at -p1 with zero fuzz and zero offset, exactly as ADR 0007 demands.
    # GNU patch accepts a drifted hunk by guessing an offset while still exiting zero, so exit
    # status alone cannot enforce the rule; the output is captured and any fuzz or offset
    # report fails the build. The shell glob is sorted (the sandbox locale is C), which is the
    # same order the numbered series intends.
    strictPatchScript = patchDir: ''
        for p in ${patchDir}/*.patch; do
            echo "applying ''${p##*/}"
            if ! patch_output=$(patch -p1 -F0 --no-backup-if-mismatch < "$p" 2>&1); then
                printf '%s\n' "$patch_output"
                echo "PATCH FAILED: $p — re-derive it against the pinned tree, never force it (ADR 0007)" >&2
                exit 1
            fi
            if printf '%s\n' "$patch_output" | grep -qiE 'fuzz|offset'; then
                printf '%s\n' "$patch_output"
                echo "FUZZ/OFFSET in $p — the patch and the pinned tree have drifted (ADR 0007)" >&2
                exit 1
            fi
        done
    '';

    # The pinned source. Nix verifies the sha256 before the derivation may be used, so the
    # fetch source is never part of the trust root: a wrong or tampered mirror fails the same
    # hash check the primary would (ADR 0001). fetchurl tries the URLs in order, which is the
    # kernel.org-then-mirror fallback the Makefile used to implement by hand.
    fetchSource = pkgs: pin:
        pkgs.fetchurl {
            urls = [
                pin.KERNEL_URL
                pin.KERNEL_URL_FALLBACK
            ];
            sha256 = pin.KERNEL_SHA256;
        };

    # Unpack the kernel tarball with bsdtar rather than the stdenv default. GNU tar fails to unpack
    # the tree on some CI runners' build filesystems with "Directory renamed before its status could
    # be extracted", a delay-directory-restore error that persisted even with
    # --no-delay-directory-restore on the amd64 runner. bsdtar from libarchive has no
    # delay-directory-restore step, so it cannot produce that error, and it extracts the same
    # archive on every runner; it auto-detects the xz compression from the archive's magic. The phase
    # cds into the tree itself because overriding unpackPhase skips the stdenv step that would
    # otherwise enter sourceRoot.
    unpackKernelPhase = pkgs: version: ''
        runHook preUnpack
        ${pkgs.libarchive}/bin/bsdtar -xf "$src"
        cd "linux-${version}"
        runHook postUnpack
    '';

    # The toolchain prefix for a cell. x86_64 and aarch64 cells compile natively on their own
    # build system, so the prefix is empty and kbuild uses the package set's own gcc; the
    # riscv64 cell is carried rather than CI-gated (ADR 0002) and cross-compiles from
    # x86_64-linux with the nixpkgs riscv64 cross toolchain.
    crossPrefixOf = pkgs: guestArch: native:
        if native then "" else pkgs.pkgsCross.riscv64.stdenv.cc.targetPrefix;

    # Extra make flags that make the assembler accept the ARMv8 crypto extension on aarch64. The kernel
    # compiles crypto/aegis128-neon-inner.c with -mcpu=generic+crypto, so gcc generates aese/aesmc, but
    # arch/arm64/Makefile passes -Wa,-march=armv8.2-a (its asm-arch) to the assembler, and armv8.2-a
    # omits the crypto extension. gcc normally reconciles the two by emitting an .arch directive; the
    # nixpkgs toolchain does not, so the assembler rejects the instructions the compiler just emitted.
    # A trailing -Wa,-march wins, so KCFLAGS and KAFLAGS raise the assembler to armv8.5-a+crypto — a
    # superset of any asm-arch the config selects, so nothing is downgraded — and the crypto instructions
    # assemble. Only aarch64 has this per-file crypto flag; x86_64 and riscv64 pass nothing.
    cryptoAsmFlags = guestArch:
        if guestArch == "aarch64"
        then "KCFLAGS=-Wa,-march=armv8.5-a+crypto KAFLAGS=-Wa,-march=armv8.5-a+crypto"
        else "";
in
{
    bundle =
        {
            pkgs,
            lib,
            pin,
            line,
            variant,
            guestArch,
            patchDir,
            configFile,
            packScript,
            invariantScript,
            abiVersion ? 1,
        }:
        let
            native = pkgs.stdenv.hostPlatform.parsed.cpu.name == guestArch;
            crossPrefix = crossPrefixOf pkgs guestArch native;
            kernelArch = kernelArchOf.${guestArch};
            bundleFile = "linux-${pin.KERNEL_VERSION}-${variant}-${guestArch}.kernel";
            # pyelftools is the packer's ELF dependency; carried on every arch so the packer
            # environment is one thing rather than three.
            python = pkgs.python3.withPackages (ps: [ ps.pyelftools ]);
        in
        # The only cross-compiled cell is riscv64; every other cell builds natively on its own
        # architecture, so a non-native instantiation of any other guest arch is a wiring
        # mistake in the flake rather than a configuration to support.
        assert native || guestArch == "riscv64";
        pkgs.stdenv.mkDerivation (
            kbuildEnv
            // {
                pname = "kernel-bundle-${variant}-${guestArch}";
                version = pin.KERNEL_VERSION;

                src = fetchSource pkgs pin;
                unpackPhase = unpackKernelPhase pkgs pin.KERNEL_VERSION;

                nativeBuildInputs =
                    [
                        pkgs.bison
                        pkgs.flex
                        pkgs.bc
                        pkgs.perl
                        pkgs.pahole
                        pkgs.cpio
                        pkgs.zstd
                        python
                    ]
                    ++ lib.optionals (!native) [
                        pkgs.pkgsCross.riscv64.buildPackages.gcc
                        pkgs.pkgsCross.riscv64.buildPackages.binutils
                    ];
                # objtool and the other host tools link against libelf and openssl; the target
                # compile is freestanding and needs no libraries at all.
                buildInputs = [
                    pkgs.elfutils
                    pkgs.openssl
                    pkgs.zlib
                ];

                # why: the cc wrapper injects hardening flags (stack protectors, fortify, PIE)
                # into every compile, kbuild owns its own hardening flags, and the two sets
                # conflict — and any wrapper-injected flag would also make the produced bytes
                # depend on nixpkgs' hardening defaults rather than on the config we curated.
                hardeningDisable = [ "all" ];

                patchPhase = ''
                    runHook prePatch
                    ${strictPatchScript patchDir}
                    runHook postPatch
                '';

                configurePhase = ''
                    runHook preConfigure
                    cp ${configFile} .config
                    make ARCH=${kernelArch} CROSS_COMPILE=${crossPrefix} olddefconfig
                    python3 ${invariantScript} --arch ${guestArch} --variant ${variant} --config .config
                    runHook postConfigure
                '';

                buildPhase = ''
                    runHook preBuild
                    make ARCH=${kernelArch} CROSS_COMPILE=${crossPrefix} \
                        ${cryptoAsmFlags guestArch} \
                        -j"$NIX_BUILD_CORES" ${makeTargetOf.${guestArch}}
                    runHook postBuild
                '';

                installPhase = ''
                    runHook preInstall
                    mkdir -p "$out"
                    python3 ${packScript} \
                        --arch ${guestArch} \
                        --variant ${variant} \
                        --abi-version ${toString abiVersion} \
                        --kernel ${kernelBinaryOf.${guestArch}} \
                        --output "$out/${bundleFile}"
                    # The raw kernel binary rides along for the QEMU boot-smoke lane, and the
                    # normalized config rides along so a released bundle can be audited without
                    # rebuilding it.
                    install -m 644 ${kernelBinaryOf.${guestArch}} "$out/kernel-binary"
                    install -m 644 .config "$out/config"
                    runHook postInstall
                '';

                # why: fixup would strip the packed bundle and the staged kernel binary, and a
                # stripped artifact is a different artifact — the bundle's bytes are the
                # release, so nothing may rewrite them after the packer.
                dontFixup = true;
            }
        );

    appliesClean =
        {
            pkgs,
            pin,
            line,
            patchDir,
        }:
        pkgs.stdenv.mkDerivation {
            pname = "applies-clean-${line}";
            version = pin.KERNEL_VERSION;

            src = fetchSource pkgs pin;
            unpackPhase = unpackKernelPhase pkgs pin.KERNEL_VERSION;

            # GNU patch explicitly: the strict zero-fuzz apply below is exactly what BSD patch
            # silently tolerates, so the gate must never fall back to a host `patch`.
            nativeBuildInputs = [ pkgs.gnupatch ];

            patchPhase = ''
                runHook prePatch
                ${strictPatchScript patchDir}
                runHook postPatch
            '';

            dontConfigure = true;
            dontBuild = true;
            dontFixup = true;

            installPhase = ''
                echo "linux-${pin.KERNEL_VERSION}: series under patches/${line} applied with zero fuzz and zero offset" > "$out"
            '';
        };

    configured =
        {
            pkgs,
            pin,
            line,
            variant,
            guestArch,
            patchDir,
            configFile,
            invariantScript,
        }:
        pkgs.stdenv.mkDerivation {
            pname = "configured-${line}-${variant}-${guestArch}";
            version = pin.KERNEL_VERSION;

            src = fetchSource pkgs pin;
            unpackPhase = unpackKernelPhase pkgs pin.KERNEL_VERSION;

            # olddefconfig compiles kconfig's host tools, which is why the gate needs a
            # compiler at all; no target compile happens here.
            nativeBuildInputs = [
                pkgs.gnupatch
                pkgs.bison
                pkgs.flex
                pkgs.perl
                pkgs.python3
            ];

            patchPhase = ''
                runHook prePatch
                ${strictPatchScript patchDir}
                runHook postPatch
            '';

            buildPhase = ''
                runHook preBuild
                cp ${configFile} .config
                make ARCH=${kernelArchOf.${guestArch}} olddefconfig
                python3 ${invariantScript} --arch ${guestArch} --variant ${variant} --config .config
                runHook postBuild
            '';

            dontFixup = true;

            # The gate's output is the normalized config itself, so a failing invariant can be
            # diagnosed by reading what olddefconfig actually produced rather than by
            # re-running the gate with instrumentation.
            installPhase = ''
                cp .config "$out"
            '';
        };
}

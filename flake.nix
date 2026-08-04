{
    # The flake is the entire build interface (ADR 0017). Every `just` verb is a thin alias
    # over an output declared here, and CI builds the same outputs on the same pinned nixpkgs,
    # so a laptop, the linux-builder VM on a macOS host, and a CI runner produce the same
    # store paths and can therefore substitute each other's work through the binary cache.
    description = "substrate-kernels: reproducible SUBK kernel bundles for substrate";

    inputs = {
        # The toolchain pin (ADR 0005). flake.lock fixes the exact nixpkgs revision, which
        # fixes the compiler, binutils, and every build utility by content hash; bumping the
        # lock is an explicit, reviewed change that re-runs the reproducibility gate, exactly
        # like bumping the kernel source pin.
        nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    };

    outputs =
        { self, nixpkgs }:
        let
            lib = nixpkgs.lib;
            kernel = import ./nix/kernel.nix;

            # The supported LTS lines. Each line's exact version, sha256, and URLs live in
            # scripts/kernel-pins/<line>.env — one source both this flake and release.yml
            # read (ADR 0001).
            lines = [
                "6.12"
                "6.18"
            ];
            pinFor = line: import ./nix/pins.nix {
                inherit lib;
                path = ./scripts/kernel-pins + "/${line}.env";
            };

            # The architecture × variant matrix (ADR 0002). base and debug on both substrate
            # host architectures are the CI-gated cells; riscv64 and windows are carried,
            # buildable cells that CI does not boot-gate.
            cells = [
                { variant = "base"; guestArch = "x86_64"; }
                { variant = "debug"; guestArch = "x86_64"; }
                { variant = "windows"; guestArch = "x86_64"; }
                { variant = "base"; guestArch = "aarch64"; }
                { variant = "debug"; guestArch = "aarch64"; }
                { variant = "base"; guestArch = "riscv64"; }
            ];

            # Each cell has exactly one canonical build system, so one derivation — and one
            # store path — exists per cell. x86_64 and aarch64 compile natively on their own
            # architecture; riscv64 cross-compiles from x86_64-linux because no riscv64
            # builder exists in CI or on a laptop (ADR 0017).
            buildSystemOf = {
                x86_64 = "x86_64-linux";
                aarch64 = "aarch64-linux";
                riscv64 = "x86_64-linux";
            };

            linuxSystems = [
                "x86_64-linux"
                "aarch64-linux"
            ];
            allSystems = linuxSystems ++ [
                "aarch64-darwin"
                "x86_64-darwin"
            ];
            pkgsFor = system: nixpkgs.legacyPackages.${system};
            forAllSystems = f: lib.genAttrs allSystems f;

            cellArgs = line: cell: {
                inherit lib line;
                inherit (cell) variant guestArch;
                pkgs = pkgsFor buildSystemOf.${cell.guestArch};
                pin = pinFor line;
                # Narrow file references, so a docs or workflow change does not invalidate a
                # kernel derivation: only the pin, the patches, the config file, and the two
                # scripts a cell actually consumes are inputs to it.
                patchDir = ./patches + "/${line}";
                configFile = ./. + "/config-${cell.variant}_${cell.guestArch}";
                packScript = ./scripts/pack-kernel.py;
                invariantScript = ./scripts/config-invariant.py;
            };

            # Attribute names carry the line with an underscore (kernel-6_12-base-x86_64),
            # because a dot in `.#kernel-6.12-…` splits the attribute path and nix reports the
            # attribute as missing; the Justfile translates `line=6.12` for you.
            attrLine = line: lib.replaceStrings [ "." ] [ "_" ] line;
            bundleName = line: cell: "kernel-${attrLine line}-${cell.variant}-${cell.guestArch}";
            configuredName = line: cell: "configured-${attrLine line}-${cell.variant}-${cell.guestArch}";

            forEachCell = f: lib.concatMap (line: map (cell: f line cell) cells) lines;

            # Every bundle, named kernel-<line>-<variant>-<arch>. The set is the same under
            # every system because each derivation already carries its canonical build system;
            # `nix build .#kernel-6.12-base-aarch64` therefore names the same store path on a
            # laptop, the linux-builder VM, and CI, which is what lets any of them substitute
            # it instead of compiling.
            bundles = lib.listToAttrs (
                forEachCell (line: cell: lib.nameValuePair (bundleName line cell) (kernel.bundle (cellArgs line cell)))
            );

            # The configured gate per cell, on the cell's canonical build system.
            configureds = lib.listToAttrs (
                forEachCell (
                    line: cell:
                    lib.nameValuePair (configuredName line cell) (
                        kernel.configured (
                            builtins.removeAttrs (cellArgs line cell) [
                                "lib"
                                "packScript"
                            ]
                        )
                    )
                )
            );

            # The applies-clean gate per line, instantiated on the asking system: extraction
            # and GNU patch run anywhere, and a laptop that can run this gate without a Linux
            # builder catches a drifted patch before pushing.
            appliesCleansFor = system: lib.listToAttrs (
                map (
                    line:
                    lib.nameValuePair "applies-clean-${attrLine line}" (kernel.appliesClean {
                        pkgs = pkgsFor system;
                        pin = pinFor line;
                        inherit line;
                        patchDir = ./patches + "/${line}";
                    })
                ) lines
            );

            # The static gates: pure Python and shell over the repo tree, no kernel source.
            staticChecksFor =
                system:
                let
                    pkgs = pkgsFor system;
                    python = pkgs.python3.withPackages (ps: [ ps.pyelftools ]);
                in
                {
                    doc-manifest = pkgs.runCommand "check-doc-manifest" { } ''
                        cd ${self}
                        bash scripts/check-doc-manifest.sh
                        echo ok > "$out"
                    '';
                    bundle-golden = pkgs.runCommand "bundle-golden" { nativeBuildInputs = [ python ]; } ''
                        python3 ${self}/tests/bundle-golden/run.py
                        echo ok > "$out"
                    '';
                    pack-unit = pkgs.runCommand "pack-unit" { nativeBuildInputs = [ python ]; } ''
                        python3 ${self}/tests/pack-kernel/run.py
                        echo ok > "$out"
                    '';
                };

            hostGuestArch = system: if lib.hasPrefix "aarch64" system then "aarch64" else "x86_64";
        in
        {
            packages = forAllSystems (
                system:
                bundles
                // configureds
                // appliesCleansFor system
                // {
                    default = bundles."kernel-6_12-base-${hostGuestArch system}";
                }
            );

            # `nix flake check` on a system builds that system's gates: the static gates and
            # applies-clean everywhere, and each configured gate on its cell's canonical build
            # system. Full bundle builds stay out of the checks — they are CI's build matrix
            # and a laptop's explicit `just build` — so the check verb stays minutes, never
            # hours.
            checks = forAllSystems (
                system:
                staticChecksFor system
                // appliesCleansFor system
                // lib.optionalAttrs (lib.elem system linuxSystems) (
                    lib.filterAttrs (name: drv: drv.system == system) configureds
                )
            );

            devShells = forAllSystems (
                system:
                let
                    pkgs = pkgsFor system;
                in
                {
                    # Everything a working session needs beyond nix itself. The kernel
                    # toolchain deliberately is not here: it belongs to the build sandbox, and
                    # a copy in the shell would be a second toolchain that can drift from the
                    # one the derivations pin.
                    default = pkgs.mkShellNoCC {
                        packages = [
                            pkgs.just
                            # `just cache-login` runs infisical (to read the cache token) and jq (to merge
                            # the Determinate config), so both belong in the shell rather than being
                            # assumed present on the host. Pinning infisical here also fixes which version
                            # the verb uses: an ambient host infisical is what a teammate fell back to, and
                            # it could not resolve the project, so the login failed from this shell while
                            # it worked from cachet's. The committed .infisical.json is what actually names
                            # the project — infisical 0.41 ignores --projectId and reads that file instead.
                            pkgs.infisical
                            pkgs.jq
                            (pkgs.python3.withPackages (ps: [ ps.pyelftools ]))
                            pkgs.shellcheck
                        ];
                    };
                }
            );
        };
}

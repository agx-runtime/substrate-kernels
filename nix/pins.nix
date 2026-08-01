# Parse one kernel pin file into an attribute set.
#
# The pin files under scripts/kernel-pins/ stay in `KEY=value` shell form because release.yml
# sources them with `.` to name its artifacts, and a second copy of the version in Nix syntax
# would be a second place for the two to disagree (ADR 0001). This parser is what lets the
# flake read the same file instead.
{ lib, path }:
let
    text = builtins.readFile path;
    rawLines = builtins.filter builtins.isString (builtins.split "\n" text);
    # A pin line is `KEY=value` with an upper-case key; comment and blank lines fail the match
    # and are dropped.
    pinLines = builtins.filter (line: builtins.match "[A-Z0-9_]+=.*" line != null) rawLines;
    entry = line:
        let m = builtins.match "([A-Z0-9_]+)=(.*)" line;
        in lib.nameValuePair (builtins.elemAt m 0) (builtins.elemAt m 1);
    pin = builtins.listToAttrs (map entry pinLines);
    required = [ "KERNEL_VERSION" "KERNEL_SHA256" "KERNEL_URL" "KERNEL_URL_FALLBACK" ];
    missing = builtins.filter (key: !(pin ? ${key})) required;
in
# A pin file missing any of the four keys cannot fetch or verify a source tree, so the
# evaluation fails here with the file and the key named rather than inside fetchurl with a
# missing-attribute error that points nowhere near the cause.
assert lib.assertMsg (missing == [ ])
    "pin file ${toString path} is missing ${lib.concatStringsSep ", " missing}";
pin

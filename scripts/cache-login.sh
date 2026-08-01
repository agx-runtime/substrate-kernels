#!/bin/sh
# Authenticate this machine to cachet.
#
# Host-level, org-wide state: run it once on a machine and every project is covered. The token
# authenticates a machine to the cache, not a user to a project.
#
# This file is copied into other repositories. The canonical copy lives at
# `scripts/cache-login.sh` in the cachet repository; a copy is not kept in sync, and the cost of that
# choice is drift — a fix here does not reach them. It is deliberate: the alternative was making every
# developer clone cachet, or configure a Nix credential for a private flake, to obtain a credential
# their machine already had. The header above names the canonical copy, so any drift is at least
# traceable to one source.
#
# Which is why it takes no arguments. Every value below is a default a copy can rely on, and every one
# stays overridable by a flag for a second cache or a different layout.
#
# POSIX sh on purpose. This runs on a laptop that may have nothing else installed yet — it is part of
# the path to a working toolchain, so it cannot depend on one (ADR 0006's sibling reasoning: the
# "everything is TypeScript" rule governs the running system, and this script bootstraps the
# toolchain that system needs).
#
# Two details are load-bearing and both come from docs/contracts.md:
#
#   1. Substitution runs in the nix daemon, so the netrc that matters is the daemon's
#      (/etc/nix/netrc). A token in ~/.netrc is invisible to it, and the symptom is silent: every
#      build compiles from source while the cache looks fine.
#   2. Determinate Nix manages /etc/nix/nix.conf, so `netrc-file` goes in
#      /etc/nix/nix.custom.conf instead. Anything written into nix.conf would be overwritten on upgrade.
#
# Everything here is idempotent: run it as often as you like, and re-run it after a token rotation.
set -eu

usage() {
    cat >&2 <<'USAGE'
usage: cache-login.sh [--host <cache-host>] [--token-stdin] [--public-key <name:base64>]
                      [--infisical-name <name>] [--infisical-path <folder>]
                      [--infisical-env <env>] [--infisical-project-id <uuid>]

Every value has a default for this org's cache, so no arguments are needed.

  --host             the cache hostname, e.g. pkg-cache.example.com
  --infisical-name   the Infisical secret to read, e.g. CACHET_READ_TOKEN
  --infisical-path   the folder holding it (default: /)
  --infisical-env    the Infisical environment (default: default)
  --infisical-project-id  the project holding it, if no .infisical.json is present
  --token-stdin      read the token from standard input instead
  --public-key       the cache's signing key, so this machine trusts what it substitutes

The token is written to the nix daemon's netrc. `netrc-file`, `extra-substituters`, and
`extra-trusted-public-keys` are ensured in /etc/nix/nix.custom.conf, which is what makes the
cache usable from every project on this machine without a per-flake prompt. Both writes need
root, so expect a sudo prompt.
USAGE
    exit 2
}

# Overridable for tests. A test points these at a temporary directory and replaces the privileged
# command with a recorder, so the exact argv can be asserted without ever needing real root.
NETRC_PATH="${CACHET_NETRC_PATH:-/etc/nix/netrc}"
NIX_CUSTOM_CONF="${CACHET_NIX_CUSTOM_CONF_PATH:-/etc/nix/nix.custom.conf}"
SUDO="${CACHET_SUDO-sudo}"

# The deployment this authenticates against. Baked in rather than passed, because a copied script has
# no Justfile and no flake to supply them — the same reason the action's metadata carries the cache URL
# as an input default (ADR 0013). None of these is a credential.
host="${CACHET_HOST:-pkg-cache.loopholelabs.io}"
infisical_name_default='CACHET_READ_TOKEN'
infisical_path_default='/PUBLIC'
infisical_project_default='7c433b42-4d98-4d30-b3dc-daf7111ef7cc'
# why: defaulted, not left empty. Without a public key this script installs the credential and not the
# trust, so an ordinary (non-trusted) Nix user still fails every signature check — the exact failure
# ADR 0004 exists to prevent, and the gap that ADR named until now. The key is public by construction.
public_key_default='pkg-cache.loopholelabs.io-1:JC2XK3HyAUXteubthi/pUEM0iokE6YyOGFURMB4hsRE='

# why: a name and a folder, not one string. `infisical secrets get` takes secret names as positional
# arguments and selects the folder with --path; an earlier version passed only a path and no name, which
# asks for every secret in that folder rather than one value.
infisical_name="${CACHET_INFISICAL_NAME:-${infisical_name_default}}"
infisical_path="${CACHET_INFISICAL_PATH:-${infisical_path_default}}"
# why: optional. The CLI resolves the project from a `.infisical.json` in the working directory, which
# `infisical init` writes; without one it needs the id explicitly and otherwise fails with nothing about
# the secret.
infisical_project_id="${CACHET_INFISICAL_PROJECT_ID:-${infisical_project_default}}"
# why: named rather than implied. The Infisical CLI falls back to whatever environment the local
# workspace happens to be set to, so a machine configured for another project would read a token from
# the wrong place and report only "not found" — or worse, find something.
infisical_env="${CACHET_INFISICAL_ENV:-default}"
public_key="${CACHET_PUBLIC_KEY:-${public_key_default}}"
token_from_stdin=0

while [ "$#" -gt 0 ]; do
    case "$1" in
    --host)
        [ "$#" -ge 2 ] || usage
        host="$2"
        shift 2
        ;;
    --infisical-name)
        [ "$#" -ge 2 ] || usage
        infisical_name="$2"
        shift 2
        ;;
    --infisical-path)
        [ "$#" -ge 2 ] || usage
        infisical_path="$2"
        shift 2
        ;;
    --infisical-project-id)
        [ "$#" -ge 2 ] || usage
        infisical_project_id="$2"
        shift 2
        ;;
    --infisical-env)
        [ "$#" -ge 2 ] || usage
        infisical_env="$2"
        shift 2
        ;;
    --public-key)
        [ "$#" -ge 2 ] || usage
        public_key="$2"
        shift 2
        ;;
    --token-stdin)
        token_from_stdin=1
        shift
        ;;
    -h | --help) usage ;;
    *)
        echo "cache-login: unknown argument '$1'" >&2
        usage
        ;;
    esac
done

[ -n "${host}" ] || usage
if [ "${token_from_stdin}" -eq 0 ] && [ -z "${infisical_name}" ]; then
    echo "cache-login: no secret name and no --token-stdin, so there is nowhere to read a token." >&2
    usage
fi

# why: a hostname ends up in a netrc line and in a config file, so it is validated rather than
# interpolated blind. Nothing exotic — letters, digits, dots and dashes are what a hostname is.
case "${host}" in
*[!A-Za-z0-9.-]* | '' | .* | -*)
    echo "cache-login: '${host}' is not a plausible hostname" >&2
    exit 1
    ;;
esac

# why: the public key is written into a config file the daemon reads as root, so it is validated
# rather than interpolated blind. Nix's form is `<name>:<base64>`, and whitespace would silently turn
# one key into two entries.
if [ -n "${public_key}" ]; then
    case "${public_key}" in
    *[![:print:]]* | *' '* | *"$(printf '\t')"* | '')
        echo "cache-login: the public key may not contain whitespace" >&2
        exit 1
        ;;
    *:*) ;;
    *)
        echo "cache-login: '${public_key}' is not a Nix public key (expected <name>:<base64>)" >&2
        exit 1
        ;;
    esac
fi

# Fetch the token. A failure here exits before anything is written: a half-written netrc is worse
# than no netrc, because it looks configured.
if [ "${token_from_stdin}" -eq 1 ]; then
    token="$(cat)"
else
    if ! command -v infisical >/dev/null 2>&1; then
        echo "cache-login: the infisical CLI is not on PATH." >&2
        echo "  It comes from the dev shell — run this from inside a repo with direnv active," >&2
        echo "  or pass the token directly with --token-stdin." >&2
        exit 1
    fi
    # why: the CLI's stderr is captured and reprinted rather than discarded. An earlier version sent it
    # to /dev/null and printed only a guess, which turned "no project is linked in this directory" —
    # the most common failure, and one that says nothing about the secret — into a message about
    # environments and paths that sent the reader looking in the wrong place.
    infisical_stderr="$(mktemp)"
    # --silent so the CLI's tips do not land in the value; --plain so only the value does.
    if [ -n "${infisical_project_id}" ]; then
        set -- --projectId "${infisical_project_id}"
    else
        set --
    fi
    if ! token="$(infisical secrets get "${infisical_name}" \
        --plain --silent \
        --env "${infisical_env}" \
        --path "${infisical_path}" \
        "$@" 2>"${infisical_stderr}")"; then
        echo "cache-login: could not read '${infisical_name}' from Infisical" >&2
        echo "  (environment '${infisical_env}', path '${infisical_path}')." >&2
        echo "  The CLI said:" >&2
        sed 's/^/    /' "${infisical_stderr}" >&2
        rm -f "${infisical_stderr}"
        echo "  If it is asking for a project: run 'infisical init' here once, or pass" >&2
        echo "  --infisical-project-id (just cache_infisical_project_id=...)." >&2
        exit 1
    fi
    rm -f "${infisical_stderr}"
fi

# Strip a trailing newline and reject anything that is not a single token. An empty or multi-line
# value would otherwise be written into a netrc where it silently authenticates nothing.
token="$(printf '%s' "${token}" | tr -d '\n\r')"
if [ -z "${token}" ]; then
    echo "cache-login: the token is empty." >&2
    exit 1
fi
case "${token}" in
*[[:space:]]*)
    echo "cache-login: the token contains whitespace, which a netrc cannot represent." >&2
    exit 1
    ;;
esac

# Write privileged files through a temporary file and a single move, so a reader never sees a
# partially written netrc.
install_file() {
    # $1 = destination, $2 = content, $3 = mode
    tmp="$(mktemp)"
    printf '%s' "$2" >"${tmp}"
    chmod "$3" "${tmp}"
    ${SUDO} mkdir -p "$(dirname "$1")"
    ${SUDO} cp "${tmp}" "$1"
    ${SUDO} chmod "$3" "$1"
    rm -f "${tmp}"
}

# Rebuild the netrc with this host's entry replaced. Every other machine's entry is preserved
# verbatim — a developer may have entries for registries, private flakes, or another cache.
#
# why block-aware rather than line-aware: a netrc entry may be written across several lines, with
# `login` and `password` indented under `machine`. Dropping only the `machine` line left those
# orphaned, and netrc is token-based, so they then bound to the preceding machine — handing an
# unrelated host this cache's login and its stale token while breaking that host's real password.
# That is a credential leak, from a script whose only job is to place one credential carefully.
#
# A `machine` or `default` line starts a block; every line after it belongs to that block until the
# next one. Lines are emitted verbatim, so another entry's layout, comments, and blank lines survive.
existing_netrc=''
if [ -r "${NETRC_PATH}" ]; then
    existing_netrc="$(cat "${NETRC_PATH}")"
fi
preserved="$(printf '%s\n' "${existing_netrc}" | awk -v host="${host}" '
    $1 == "machine" || $1 == "default" { skipping = ($1 == "machine" && $2 == host) }
    !skipping { print }
' | awk 'NF { blanks = 0; print; next } { blanks = blanks + 1 }')"

if [ -n "${preserved}" ]; then
    netrc_content="${preserved}
machine ${host} login cachet password ${token}
"
else
    netrc_content="machine ${host} login cachet password ${token}
"
fi

# 0600: the netrc holds a credential, and the daemon reads it as root.
install_file "${NETRC_PATH}" "${netrc_content}" 0600

# Ensure the three settings that make this machine able to use the cache from any project:
# `netrc-file` (where the credential is), `extra-substituters` (the cache itself), and
# `extra-trusted-public-keys` (so a signed NAR from it is trusted).
#
# why all three here rather than in each repository's flake `nixConfig`: Nix honours a flake's
# `extra-trusted-public-keys` only for a trusted user, so on an ordinary account it is ignored with a
# warning and every substituted path then fails its signature check. Setting it host-side is what makes
# the trust actually hold (ADR 0004), and it is why this script is host-level state rather than
# per-project.
existing_conf=''
if [ -r "${NIX_CUSTOM_CONF}" ]; then
    existing_conf="$(cat "${NIX_CUSTOM_CONF}")"
fi

# Read one setting's current value, empty when absent. The last line wins, which is Nix's own rule for
# a repeated key.
setting_value() {
    printf '%s\n' "${existing_conf}" |
        sed -n "s/^$1[[:space:]]*=[[:space:]]*//p" |
        tail -n 1
}

# why: merged into one line rather than appended as a second. In nix.conf a repeated key overrides
# rather than accumulates, so writing our own `extra-substituters` line below an existing one would
# silently drop whatever cache that machine already used. A value already present is left exactly as it
# is, which is what makes a re-run byte-identical.
merge_value() {
    merge_existing="$1"
    merge_wanted="$2"
    for merge_present in ${merge_existing}; do
        if [ "${merge_present}" = "${merge_wanted}" ]; then
            printf '%s' "${merge_existing}"
            return
        fi
    done
    if [ -n "${merge_existing}" ]; then
        printf '%s %s' "${merge_existing}" "${merge_wanted}"
    else
        printf '%s' "${merge_wanted}"
    fi
}

substituters="$(merge_value "$(setting_value extra-substituters)" "https://${host}")"
trusted_keys="$(setting_value extra-trusted-public-keys)"
if [ -n "${public_key}" ]; then
    trusted_keys="$(merge_value "${trusted_keys}" "${public_key}")"
fi

# Every line this script owns is dropped and rewritten in a fixed order, so the result depends only on
# the inputs and never on how many times it has run. Everything else in the file is preserved as-is.
conf_without="$(printf '%s\n' "${existing_conf}" |
    sed -e '/^netrc-file[[:space:]]*=/d' \
        -e '/^extra-substituters[[:space:]]*=/d' \
        -e '/^extra-trusted-public-keys[[:space:]]*=/d' |
    sed '/^[[:space:]]*$/d')"

conf_managed="netrc-file = ${NETRC_PATH}
extra-substituters = ${substituters}"
if [ -n "${trusted_keys}" ]; then
    conf_managed="${conf_managed}
extra-trusted-public-keys = ${trusted_keys}"
fi

if [ -n "${conf_without}" ]; then
    conf_content="${conf_without}
${conf_managed}
"
else
    conf_content="${conf_managed}
"
fi

# 0644: nix.custom.conf is configuration, not a secret, and the daemon must read it.
install_file "${NIX_CUSTOM_CONF}" "${conf_content}" 0644

# why: the daemon has to be told. It reads nix.custom.conf at start, so writing the file is not enough —
# substitution keeps using the previous configuration and every fetch returns 401 while this script has
# already printed success. Observed exactly that: `nix flake check` failing with
# "HTTP error 401" from the cache immediately after a login that reported both settings written.
#
# The outcome is reported rather than swallowed with `|| true`. A restart that silently failed would
# leave the reader with a working credential, a correct config, and a cache that refuses them.
reload_daemon() {
    if [ -z "${SUDO}" ] && [ "$(id -u)" -ne 0 ]; then
        return 1
    fi
    if command -v systemctl >/dev/null 2>&1; then
        ${SUDO} systemctl restart nix-daemon 2>/dev/null && return 0
    fi
    # why: the label is discovered rather than assumed. Determinate Nix — which this project mandates
    # (ADR 0008) — installs `systems.determinate.nix-daemon`, while the upstream installer uses
    # `org.nixos.nix-daemon`. Hardcoding either one silently fails on the other, and the symptom is a
    # login that reports success while every fetch returns 401.
    if command -v launchctl >/dev/null 2>&1; then
        for plist in /Library/LaunchDaemons/*nix-daemon*.plist; do
            [ -r "${plist}" ] || continue
            label="$(basename "${plist}" .plist)"
            ${SUDO} launchctl kickstart -k "system/${label}" >/dev/null 2>&1 && return 0
        done
    fi
    return 1
}

echo "cache-login: ${host} configured in ${NETRC_PATH}"
echo "cache-login: netrc-file, extra-substituters$([ -n "${trusted_keys}" ] && printf ', extra-trusted-public-keys') set in ${NIX_CUSTOM_CONF}"

if reload_daemon; then
    echo "cache-login: nix-daemon restarted, so the new configuration is live"
else
    echo "cache-login: could NOT restart nix-daemon, so the settings above are not in effect yet." >&2
    echo "  Substitution will keep returning 401 until it reloads. Restart it with:" >&2
    echo "    sudo launchctl kickstart -k system/systems.determinate.nix-daemon   # macOS, Determinate" >&2
    echo "    sudo launchctl kickstart -k system/org.nixos.nix-daemon              # macOS, upstream" >&2
    echo "    sudo systemctl restart nix-daemon                         # linux" >&2
fi

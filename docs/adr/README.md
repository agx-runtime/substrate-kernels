# Architecture Decision Records

Each ADR records one design decision: its context, the decision, the consequences,
and the alternatives weighed. ADRs are the durable home for the *why* behind a
decision — [CLAUDE.md](../../CLAUDE.md) §7 requires one per significant choice, and
[architecture.md](../architecture.md) §8 calls for one per open decision.

**Format** (established by [ADR 0001](0001-kernel-source-pin-and-update-lifecycle.md)):
Context → Decision → Consequences → Alternatives considered, with a `Status` /
`Date` / `Context doc` header. New ADRs append to this index with the next number.

| ADR | Title | Status | Resolves |
|---|---|---|---|
| [0001](0001-kernel-source-pin-and-update-lifecycle.md) | Kernel source pin and update lifecycle | Accepted | establishes the ADR convention; architecture.md §2/§8 — the version + sha256 pin and the bump lane |
| [0002](0002-target-architectures.md) | Target architectures | Accepted | architecture.md §4/§8 — x86_64 / aarch64 / riscv64 + windows carried for completeness; CI gates x86_64 + aarch64 |
| [0003](0003-kernel-bundle-format.md) | The kernel bundle format | Accepted | architecture.md §1/§8 — a fixed header (magic `SUBK`), pre-flattened payload, page alignment |
| [0004](0004-boot-contract-with-substrate.md) | The boot contract with substrate | Accepted | architecture.md §1/§8 — `load_addr`/`entry_addr` semantics, the x86 64-bit `boot_params` entry, the no-runtime-parser split |
| [0005](0005-build-environment-and-reproducibility.md) | Build environment and reproducibility | Accepted | architecture.md §2/§8 / CLAUDE.md §3 — the pinned container, fixed build metadata, the byte-identity gate |
| [0006](0006-kernel-config-strategy.md) | Kernel config strategy | Accepted | architecture.md §3/§8 — monolithic, no modules, virtio-only, one `.config` per (arch, variant) |
| [0007](0007-patch-management-policy.md) | Patch-management policy | Accepted | architecture.md §3/§8 / CLAUDE.md §6 — the ordered series, why-headers, config-over-patch, clean rebase |
| [0008](0008-kernel-capability-surface-vs-vmm-scope.md) | Kernel capability surface vs VMM device scope | Accepted | architecture.md §5/§8 / CLAUDE.md §1 — what the kernel carries vs what substrate exposes; the security boundary |
| [0009](0009-confidential-compute-variants.md) | Confidential-compute variants (TEE / SEV / TDX) | Accepted | architecture.md §4/§8 / CLAUDE.md §1 — TEE out of base, opt-in and quarantined; vendored firmware/initrd blobs, wiring deferred |
| [0010](0010-auto-loaded-doc-context.md) | Auto-loaded documentation context (the CLAUDE.md import manifest) | Accepted | CLAUDE.md §7/§10 — a flat `@`-import manifest in CLAUDE.md loads 100% of `docs/`, guarded against drift by `scripts/check-doc-manifest.sh` |
| [0011](0011-download-proxy-with-analytics.md) | Download proxy with analytics | Accepted | a thin CF Worker (`download-proxy/`) on `kernels.substrate.loopholelabs.io` + `kernels.agx.so` that serves the R2 bucket via binding and emits one `kernel_download` event per full download into the analytics pipeline |
| [0012](0012-listing-page-web-analytics-and-correlation.md) | Listing-page web analytics and download correlation | Accepted | the `/` page loads the RudderStack SDK (`source = WEB:<HOST>`); a same-origin `substrate_aid` cookie + an optional `X-Substrate-Anonymous-Id` header tie the page's download-click to the proxy's server-side `kernel_download` event |

0001 establishes the convention and fixes the pin that roots reproducibility.
0002–0004 fix the artifact's shape (architectures, bundle format, boot contract).
0005–0007 fix how it is built (environment + reproducibility, config, patches).
0008–0009 fix the capability boundary (what the kernel carries vs what substrate
exposes, and the TEE exception). 0010 records a process decision — how the docs
themselves load into an agent's context. 0011 adds the download proxy — the first
Worker in this repo, sitting between the public download hostnames and the R2
bucket so every download is observable in the analytics pipeline. 0012 extends that
Worker's listing page with the RudderStack web SDK and ties the page's
download-click to the proxy's server-side download event via a same-origin cookie.
Further decisions get their own numbered ADR here as they land.

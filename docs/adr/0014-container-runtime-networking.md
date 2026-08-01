# ADR 0014 — Container-runtime networking (in-guest Docker)

- **Status:** Accepted
- **Date:** 2026-07-02
- **Context doc:** [../design/kernel-config.md](../design/kernel-config.md)
  ("Container-runtime networking (netfilter / bridge / NAT)");
  [ADR 0006](0006-kernel-config-strategy.md) (config-over-patch + curated minimal);
  [ADR 0008](0008-kernel-capability-surface-vs-vmm-scope.md) (capability surface vs
  device scope); [ADR 0013](0013-debug-variant.md) (the config-invariant-gate + CI
  pattern this reuses)

## Context

A substrate guest is a useful place to run a **container engine** — `dockerd` /
`containerd` — so that a workload can itself launch containers (docker-in-docker,
CI runners, build farms). Container engines program the guest's network stack
heavily: the default `bridge` network wires each container to a Linux bridge over a
`veth` pair, and the engine installs `iptables` rules for outbound SNAT
(masquerade), inter-container isolation (reject), and published-port DNAT.

The base config already carried a large netfilter block, but it was **incomplete
for a container engine, and — separately — undocumented and ungated**. Booting
`dockerd` in the guest failed at bridge-driver registration:

```
failed to register "bridge" driver: ... addrtype revision 0 not supported, missing kernel module?
iptables (nf_tables): RULE_APPEND failed (No such file or directory)
```

Two facts explain the failure:

1. **Modern container images ship `iptables` in nft mode (`iptables-nft`).** It
   translates classic matches/targets into nftables expressions via `nft_compat`,
   which loads the underlying built-in `xt` modules. The guest had `CONFIG_NFT_COMPAT=y`
   but **not** `CONFIG_NETFILTER_XT_MATCH_ADDRTYPE` — so `-m addrtype` (used by
   Docker's hairpin/NAT rules) had no backing module. That is the literal
   "addrtype revision 0 not supported".
2. **Container outbound NAT needs a MASQUERADE target**, and none was built in any
   config (`NFT_MASQ`, `NETFILTER_XT_TARGET_MASQUERADE`, and `IP_NF_TARGET_MASQUERADE`
   were all off), nor were the REJECT targets Docker uses for isolation.

This is a **kernel-config gap, not a userspace one** (the dind image's iptables
userspace is present). Per [ADR 0006](0006-kernel-config-strategy.md) the fix is
config, not a patch. Per [ADR 0008](0008-kernel-capability-surface-vs-vmm-scope.md)
it is a *carried capability*: netfilter/bridge drivers with no host-side device are
inert, and the guest→host boundary is enforced by substrate not wiring a device, not
by the kernel lacking the driver — so carrying the surface is safe, priced only
against image size and in-guest attack surface.

## Decision

1. **Complete the container-runtime networking surface on the guest-model cells.**
   The netfilter/bridge/NAT set a container engine needs is enabled on `base` and
   `debug` for **x86_64 and aarch64**, and on `base` for **riscv64**. sev, tdx, and
   windows do **not** carry it — they are special-purpose / not substrate boot
   targets ([ADR 0002](0002-target-architectures.md),
   [ADR 0009](0009-confidential-compute-variants.md)).

2. **The enabled set** (on top of the netfilter block the base config already
   carried — [design/kernel-config.md](../design/kernel-config.md)):
   - **`xt` matches (via `nft_compat` for `iptables-nft`):**
     `CONFIG_NETFILTER_XT_MATCH_ADDRTYPE` (the symbol whose absence broke dockerd),
     `_STATE`, `_MARK` (+`NETFILTER_XT_MARK`), `_MULTIPORT`.
   - **NAT / reject, both backends:** `CONFIG_NFT_MASQ`, `CONFIG_NFT_REJECT`,
     `CONFIG_NETFILTER_XT_TARGET_MASQUERADE`, `CONFIG_IP_NF_TARGET_MASQUERADE`,
     `CONFIG_IP_NF_TARGET_REJECT` (these auto-select `NF_NAT_MASQUERADE`,
     `NF_REJECT_IPV4`, and the `NFT_REJECT_*` variants).
   - **IPv6 (Docker configures ip6tables by default):** `CONFIG_IP6_NF_IPTABLES`,
     `IP6_NF_FILTER`, `IP6_NF_MANGLE`, `IP6_NF_NAT`, `IP6_NF_TARGET_MASQUERADE`,
     `IP6_NF_TARGET_REJECT`.
   - **Network drivers:** `CONFIG_VXLAN` (overlay networks), `CONFIG_MACVLAN`,
     `CONFIG_IPVLAN`, `CONFIG_BRIDGE_VLAN_FILTERING`, plus the nft bridge/ebtables
     path (`CONFIG_NF_TABLES_BRIDGE`, `CONFIG_NF_TABLES_NETDEV`,
     `CONFIG_BRIDGE_NF_EBTABLES`). `CONFIG_BRIDGE`/`BRIDGE_NETFILTER`/`VETH`/`DUMMY`
     were already on.
   - **Dependencies that `olddefconfig` would otherwise silently drop:**
     `BRIDGE_VLAN_FILTERING` *depends on* `CONFIG_VLAN_8021Q`, and
     `IP6_NF_TARGET_MASQUERADE` *depends on* `IP6_NF_NAT` — both enabled in the same
     pass.

3. **What stays out.** `CONFIG_IP_VS` (Swarm/IPVS service load-balancing) and
   `CONFIG_IP_SET` stay **off** — no substrate consumer; standalone `dockerd` bridge
   networking does not need them. The Docker-*optional* traffic-control controllers
   (`NET_SCHED` / `NET_CLS_CGROUP` / `CGROUP_NET_PRIO`) also stay off. Adding any of
   these later is a reviewed, per-symbol decision (the curated-minimal default —
   [ADR 0006](0006-kernel-config-strategy.md)).

4. **The config-invariant gate enforces the core set** on the guest-model variants.
   `scripts/config-invariant.py` gains a `DOCKER_VARIANTS = {"base", "debug"}` scope
   and a `DOCKER_REQUIRED` set (the load-bearing netfilter/bridge/NAT symbols,
   including `NETFILTER_XT_MATCH_ADDRTYPE`, the masquerade path, `IP6_NF_IPTABLES`,
   `BRIDGE`, `VXLAN`/`MACVLAN`/`IPVLAN`), applied exactly like `XDP_VARIANTS`
   ([ADR 0013](0013-debug-variant.md) §3). This turns a future `olddefconfig`
   dep-drop (the exact failure mode that let the surface be incomplete) into a
   build-time failure. riscv64 `base` is in scope of the gate (variant `base`);
   sev/tdx/windows are excluded.

5. **riscv64 is brought to full parity but stays un-CI-gated.** riscv64 `base` had
   `NETFILTER` and `BRIDGE` off entirely; it is enabled to the same target set as the
   x86_64/aarch64 `base` cells (plus `IP_ADVANCED_ROUTER`/`IP_MULTIPLE_TABLES` for
   policy-routing parity). Per [ADR 0002](0002-target-architectures.md) riscv64 is
   carried but not build- or boot-gated in CI. Its config gate does run in CI, because
   the riscv64 cell cross-compiles from x86_64-linux ([ADR 0017](0017-nix-build-and-flake-interface.md))
   and `nix flake check` on the x86_64-linux runner builds every configured gate whose
   cell targets that build system; `just configured base riscv64` runs the same gate
   on a laptop.

6. **No bundle-format or patch change.** This is entirely config
   ([ADR 0006](0006-kernel-config-strategy.md)) — no new patch, no header change; the
   `variant` ids are unchanged.

## Consequences

- **`dockerd` boots and `docker run` works** with the default bridge network in the
  guest: the bridge driver registers, `iptables-nft` `addrtype`/MASQUERADE/REJECT
  rules apply, and containers get outbound NAT — on x86_64, aarch64, and riscv64.
- **The surface is now gated.** The netfilter/bridge/NAT set was previously ungated;
  a dependency change at a pin bump could have silently dropped it and CI would have
  stayed green. The config-invariant gate now pins the core set on `base`/`debug`.
- **Image size grows modestly** on the guest-model cells (more built-in netfilter
  matches/targets + VXLAN/MACVLAN/IPVLAN). This is the carried-capability cost
  ([ADR 0008](0008-kernel-capability-surface-vs-vmm-scope.md) §5), governed by the
  size budget ([architecture.md §6](../architecture.md)); Swarm/IPVS and the tc
  controllers are deliberately left out to hold it.
- **Production and confidential-compute posture unchanged elsewhere.** sev/tdx/windows
  do not gain the surface; running a container engine inside a TEE guest is a separate
  decision with its own threat model.
- **CI covers x86_64 + aarch64 (base + debug)** for config-invariant/build/boot-smoke;
  riscv64 `base` is verified locally only.

## Alternatives considered

- **Enable only `CONFIG_NETFILTER_XT_MATCH_ADDRTYPE`** (the single symbol in the error)
  — rejected: it clears the first error but the next wall is immediate (no MASQUERADE
  target → containers have no outbound NAT; no REJECT → isolation rules fail). The
  engine needs the coherent set, not one symbol.
- **Leave the surface ungated** (config-only, no config-invariant entry) — rejected:
  the surface being incomplete-and-ungated is exactly what let dockerd break silently;
  gating it (the [ADR 0013](0013-debug-variant.md) pattern) is the mechanism that keeps
  it from regressing at a pin bump.
- **Add the full set to every variant incl. sev/tdx/windows** — rejected: those aren't
  substrate boot targets or are special-purpose; carrying container networking inside a
  confidential-compute guest is out of scope and unverified. Scope it to the guest
  model (base/debug + riscv64 base).
- **Also enable IPVS/ipset (Swarm) and the tc cgroup controllers** — rejected for now:
  no substrate consumer for Swarm service LB, and the tc controllers need `NET_SCHED`;
  both are curated-minimal opt-ins revisited only with a named consumer
  ([ADR 0006](0006-kernel-config-strategy.md)).
- **Solve it in userspace (ship `iptables-legacy` in the image)** — rejected: it's the
  wrong layer. Even iptables-legacy needs the built-in `ip_tables` match/target modules
  (`xt_addrtype`, MASQUERADE), which are the same kernel gap; and it doesn't help the
  nft path modern images default to. The fix belongs in the guest kernel config.

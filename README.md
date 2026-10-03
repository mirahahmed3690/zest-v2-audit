# zest-v2-audit

**Invariant & property-based security fuzzing of [Zest Protocol V2](https://github.com/Zest-Protocol/zest-v2-contracts)** — a Clarity/Stacks lending protocol with an efficiency-group risk engine, a Pyth-Lazer oracle, and an ERC4626-style leveraged strategy vault (zvstBTC).

This repository is a **security review artifact**: twelve property-based fuzz harnesses that attack Zest V2's economic invariants on the real Clarinet simnet harness. Each harness drives randomized operation sequences against the deployed contracts and asserts a safety property that must hold no matter the input.

> **Scope & outcome.** This review targeted *permissionlessly reachable economic bugs* (solvency, liquidation, oracle freshness, share accounting, cross-user isolation). Across **12 harnesses / ~940 randomized sequences**, plus static review of 12 surfaces and design analysis of the oracle and flashloan paths, **no payable finding was identified.** The protocol's accounting is tight to 0–1 base units in its own favor throughout, and the liquidation close-factor curve is mathematically exact. This is a *coverage/assurance* result, not a vulnerability disclosure.

---

## Why property-based fuzzing

Unit tests check the cases the author thought of. Property-based fuzzing checks the cases nobody thought of: it generates thousands of random operation sequences and asserts that an **invariant** — a statement that must *always* be true — survives every one of them. For a lending protocol the invariants that matter are economic:

- a position can never exceed its loan-to-value ceiling,
- a liquidator can never seize more collateral than the penalty allows,
- the sum of what suppliers can redeem can never exceed what the vault holds,
- one user's actions can never alter another user's books.

A single violation in thousands of sequences is a real exploit. Zero violations across a well-designed suite is *assurance* — and only meaningful if each harness is proven to actually exercise its attack path (see **Non-vacuity** below).

## Coverage

| # | Harness | Property asserted | Seqs |
|---|---------|-------------------|------|
| 1 | `invariant-fuzz` | After any successful op, `debt_usd ≤ collateral_usd × LTV` (egroup solvency) | 130 |
| 2 | `egroup-transition-fuzz` | Debt-mix (USDC+USDH) always resolves the **correct** (lower) egroup LTV, never a stale one | 70 |
| 3 | `price-dynamics-fuzz` | No borrow/withdraw succeeds leaving a position unhealthy **at the current price** (stale-price guard) | 80 |
| 4 | `egroup-collateral-fuzz` | Collateral-mix (sBTC+stSTX) applies the correct egroup LTV | 70 |
| 5 | `strategy-vault-roundtrip-fuzz` | A deposit→redeem round trip never returns more than deposited (dead-shares + floor rounding) | 80 |
| 6 | `liquidation-fuzz` | Seized value ≤ repaid × (1 + max 10% bonus); a healthy position can never be liquidated | 90 |
| 7 | `interest-index-drift-fuzz` | `totalAssets ≥ convertToAssets(totalSupply)` across multi-month accrual (debt index rounds up, liquidity index rounds down) | 60 |
| 8 | `liquidation-baddebt-fuzz` | After underwater full liquidation + bad-debt socialization: vault stays solvent, position closes clean, bonus bounded | 70 |
| 9 | `strategy-vault-nav-fuzz` | Leverage loop creates no NAV; `convertToAssets(convertToShares(x)) ≤ x` at every state | 60 |
| 10 | `cross-user-isolation-fuzz` | One user's op never changes another user's raw collateral or scaled debt | 80 |
| 11 | `vault-inflation-fuzz` | A direct donation cannot pump share price (donation-resistance); no first-depositor robbery | 80 |
| 12 | `over-liquidation-fuzz` | A recoverable (partial-band) position cannot be fully drained — the close-factor curve caps the repay | 70 |

**Total: ~940 randomized sequences, all passing.**

## Method notes

- **Model-in-lockstep.** Each harness keeps a JS model of the expected state and asserts the contract against it after every operation, on a fresh chain per sequence (`beforeEach` re-inits simnet) so state never leaks between cases.
- **Non-vacuity verification.** Every harness ships with a sanity check proving it actually reaches its attack path — e.g. that liquidations *fire*, that bad-debt socialization *triggers*, that the share round-trip *executes*. A fuzz that silently skips its own target "passes" vacuously; each property here was confirmed to engage with real, non-trivial state before being trusted. (During this review that discipline caught a harness-side bug where the first obligation `id = 0` was mistaken for "no position," which had made three harnesses vacuous until corrected.)
- **Conservative tolerances.** A 1% relative tolerance (or a few base units of dust) absorbs interest/index rounding; a true health-check bypass blows past that, dust does not.

## What was *not* in scope

These require capabilities or trust assumptions outside a permissionless black-box review, and are **not** covered here:

- **Admin / DAO-privileged paths** (efficiency-group creation, flashloan whitelisting) — gated by `check-dao-auth`; typically out of scope for bounty programs.
- **Oracle price forgery** — the Pyth-Lazer path is signature-gated; forging a feed needs the trusted signer key.
- **Formal verification / mainnet-fork MEV simulation** — the next rung past randomized fuzzing.

## Running

These harnesses are written for the Zest V2 Clarinet + Vitest + `@clarigen/test` + `@fast-check/vitest` test environment. To run them, drop `tests/security/*.ts` into a checkout of [`zest-v2-contracts`](https://github.com/Zest-Protocol/zest-v2-contracts)'s `local-testing` suite (they import that repo's `setup/helpers` and `assetConfig`) and:

```bash
npx vitest run tests/security/
```

## Disclaimer

Independent, good-faith security research. No affiliation with Zest Protocol. "No payable finding" reflects the methods applied here and is not a guarantee of absence of bugs. Not financial or security advice.

## License

MIT — see [LICENSE](LICENSE).

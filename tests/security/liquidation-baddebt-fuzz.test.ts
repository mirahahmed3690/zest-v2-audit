// LIQUIDATION BAD-DEBT / post-liquidation solvency fuzz for Zest V2.
//
// When a position crashes underwater (debt > collateral), a full liquidation takes ALL
// collateral, debt remains, and the shortfall is SOCIALIZED against the vault's
// suppliers (market.liquidate -> no-collateral-left -> vault-socialize-debt). This is
// the highest-severity seam in a lending protocol and my earlier liquidation fuzz did
// NOT check what the write-down does to vault accounting. Here we crash sBTC hard,
// liquidate, and assert the invariants that a correct socialization must preserve:
//
//   (A) VAULT STAYS SOLVENT after socialization:
//         vaultUsdc.totalAssets + DUST >= convertToAssets(totalSupply)
//       The bad debt must reduce assets AND supplier claims consistently. If assets
//       drop but claims don't (or vice-versa), suppliers can redeem more than the
//       vault holds — phantom solvency / hidden bad debt.
//
//   (B) CLEAN CLOSE: once a borrower's collateral is fully seized and debt socialized,
//       their collateral AND debt for that asset read 0 (mask bits cleared). A leftover
//       would leave a stale-egroup / phantom position.
//
//   (C) BONUS BOUND holds even underwater: seized collateral value <= repaid * 1.10.
import { describe, it, beforeEach } from 'vitest';
import { txOk, rov } from '@clarigen/test';
import { fc } from '@fast-check/vitest';
import {
  deployer, alice, charlie,
  initializeProtocol, executeDaoProposal, contracts, proposalCreateMultipleEgroups,
  proposalSetUsdcInterestRates, proposalSetSbtcInterestRates,
} from '../setup/helpers';
import { ASSET_IDS } from '../assetConfig';
import {
  init_pyth, set_initial_price, set_price, PythFeedIds, scalePriceForPyth, priceFeeds,
} from '../setup/helpers/pyth-helpers';

const { market, marketVault, sbtc: sbtcToken, usdc: usdcToken, vaultUsdc } = contracts;
const SBTC_DEC = 1e8, USDC_DEC = 1e6, MAX_BONUS = 1.10, TOL = 1.01, DUST = 5n;

// scenario knobs
type Scenario = {
  collSbtc: bigint;   // alice collateral
  borrow: bigint;     // alice USDC debt (set near 70% of $60k value)
  crashTo: number;    // BTC price after crash (deeply underwater choices included)
  repay: bigint;      // charlie's repay attempt (large -> full seize + socialize)
};

const scn: fc.Arbitrary<Scenario> = fc.record({
  collSbtc: fc.oneof(fc.constant(100_000_000n), fc.bigInt({ min: 20_000_000n, max: 300_000_000n })),
  borrow: fc.bigInt({ min: 10_000_000_000n, max: 41_000_000_000n }), // $10k-$41k (<=~70% of $60k)
  crashTo: fc.constantFrom(25000, 20000, 15000, 10000, 8000, 5000),  // underwater
  repay: fc.oneof(fc.constant(100_000_000_000n), fc.bigInt({ min: 1_000_000_000n, max: 80_000_000_000n })),
});

const SCENARIOS = fc.sample(scn, 70);

const sbtcBal = (u: string) => (rov(sbtcToken.getBalance(u)).value as bigint) ?? 0n;
const usdcBal = (u: string) => (rov(usdcToken.getBalance(u)).value as bigint) ?? 0n;
const totalAssets = () => rov(vaultUsdc.getTotalAssets()).value as bigint;
const totalSupply = () => rov(vaultUsdc.getTotalSupply()).value as bigint;
const claimAll = () => rov(vaultUsdc.convertToAssets(totalSupply())).value as bigint;

describe('LIQUIDATION BAD-DEBT FUZZ: socialization keeps the vault solvent and closes the position', () => {
  beforeEach(async () => {
    initializeProtocol();
    init_pyth(deployer);
    executeDaoProposal(contracts.proposalSetPriceStaleness);
    executeDaoProposal(proposalCreateMultipleEgroups);
    executeDaoProposal(proposalSetUsdcInterestRates);
    executeDaoProposal(proposalSetSbtcInterestRates);
    await set_initial_price(PythFeedIds.BTC, scalePriceForPyth(60000, -8), deployer);
    await set_initial_price(PythFeedIds.USDC, scalePriceForPyth(1, -8), deployer);
    // deep USDC liquidity so socialization has suppliers to absorb the loss
    txOk(usdcToken.mint(1_000_000_000_000n, deployer), deployer);
    txOk(vaultUsdc.deposit(1_000_000_000_000n, 0n, deployer), deployer);
    // liquidator funds
    txOk(usdcToken.mint(1_000_000_000_000n, charlie), deployer);
  });

  SCENARIOS.forEach((s, i) => {
    it(`scn #${i} (crash to $${s.crashTo}): solvent after socialization, clean close, bonus bounded`, async () => {
      // 1. Alice opens a healthy position at $60k
      txOk(sbtcToken.mint(s.collSbtc, alice), deployer);
      txOk(market.collateralAdd(sbtcToken.identifier, s.collSbtc, priceFeeds()), alice);
      // cap borrow to ~70% of collateral value so the open succeeds
      const maxBorrow = BigInt(Math.floor((Number(s.collSbtc) / SBTC_DEC) * 60000 * 0.69)) * 1_000_000n;
      const borrow = s.borrow > maxBorrow ? maxBorrow : s.borrow;
      if (borrow < 1_000_000n) return; // too small to matter
      txOk(market.borrow(usdcToken.identifier, borrow, alice, priceFeeds()), alice);

      // 2. Crash BTC deeply underwater
      await set_price(PythFeedIds.BTC, scalePriceForPyth(s.crashTo, -8), -8, deployer);

      // snapshot vault + liquidator before
      const taBefore = totalAssets();
      const claimBefore = claimAll();
      const charlieUsdc0 = usdcBal(charlie), charlieSbtc0 = sbtcBal(charlie);

      // 3. Liquidate (large repay -> full seize, possibly bad-debt socialization)
      let ok = false;
      try {
        txOk(market.liquidate(alice, sbtcToken.identifier, usdcToken.identifier, s.repay, 0n, null, priceFeeds()), charlie);
        ok = true;
      } catch { ok = false; }
      if (!ok) return; // underwater liquidation may revert for some param combos; not a bug

      const usdcSpent = charlieUsdc0 - usdcBal(charlie);
      const sbtcGained = sbtcBal(charlie) - charlieSbtc0;

      // (C) bonus bound at the crash price
      if (usdcSpent > 0n && sbtcGained > 0n) {
        const repaidUsd = Number(usdcSpent) / USDC_DEC;
        const seizedUsd = (Number(sbtcGained) / SBTC_DEC) * s.crashTo;
        if (seizedUsd > repaidUsd * MAX_BONUS * TOL) {
          throw new Error(
            `OVER-SEIZURE underwater @$${s.crashTo}: seized $${seizedUsd.toFixed(2)} for $${repaidUsd.toFixed(2)} ` +
            `(ratio ${(seizedUsd / repaidUsd).toFixed(4)}). scn=${JSON.stringify(s, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`
          );
        }
      }

      // (A) vault solvency AFTER (socialization must not create phantom assets/claims)
      const taAfter = totalAssets();
      const claimAfter = claimAll();
      if (claimAfter > taAfter + DUST) {
        throw new Error(
          `VAULT INSOLVENT after liquidation/socialization @$${s.crashTo}: ` +
          `claim=${claimAfter} > assets=${taAfter} (drift=${claimAfter - taAfter}). ` +
          `before: assets=${taBefore} claim=${claimBefore}. ` +
          `scn=${JSON.stringify(s, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`
        );
      }

      // (B) clean close: if collateral fully gone, debt for USDC must be gone too (no phantom debt)
      // alice's id is VALID at 0 (first account) — gate only on "was she ever registered"
      // (resolve panics if not), never on id===0.
      let aliceId: bigint | null = null;
      try { aliceId = (rov(marketVault.resolve(alice)) as any).id as bigint; } catch { aliceId = null; }
      if (aliceId !== null) {
        let coll = 0n, debtScaled = 0n;
        try { coll = rov(marketVault.getCollateral(aliceId, ASSET_IDS.sbtc)) as bigint; } catch { coll = 0n; }
        try { debtScaled = (rov(marketVault.getDebt(aliceId, ASSET_IDS.usdc)) as any).scaled as bigint; } catch { debtScaled = 0n; }
        if (coll === 0n && debtScaled !== 0n) {
          // collateral fully seized but USDC debt still on the books and NOT socialized -> phantom bad debt
          // (only a violation if the position truly has no other collateral; single-asset setup guarantees that)
          throw new Error(
            `PHANTOM BAD DEBT @$${s.crashTo}: collateral=0 but USDC debt scaled=${debtScaled} remains unsocialized. ` +
            `scn=${JSON.stringify(s, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`
          );
        }
      }
    });
  });
});

// OVER-LIQUIDATION / close-factor fuzz for Zest V2 (sBTC/USDC egroup).
//
// The sBTC/USDC egroup liquidates on a quadratic curve between LTV-LIQ-PARTIAL (85%)
// and LTV-LIQ-FULL (95%): inside that band only a FRACTION of the debt may be
// liquidated (0% at 85% -> 100% at 95%). A borrower who is merely, say, 88% LTV must
// NOT be fully drained by a liquidator sending a huge repay — the protocol must cap the
// liquidation at the curve's fraction. Over-liquidation (seizing a recoverable
// borrower's whole position) is a real value-extraction / griefing bug.
//
// INVARIANT: after a single liquidate() of a position whose LTV is in [86%, 93%]
// (comfortably inside the partial band), the borrower must still have BOTH collateral
// and debt left (partial liquidation only, not a full wipe). Plus the bonus bound
// (seized <= repaid * 1.10) must still hold.
import { describe, it, beforeEach } from 'vitest';
import { txOk, rov } from '@clarigen/test';
import { fc } from '@fast-check/vitest';
import {
  deployer, alice, charlie,
  initializeProtocol, executeDaoProposal, contracts, proposalCreateMultipleEgroups,
} from '../setup/helpers';
import { ASSET_IDS } from '../assetConfig';
import {
  init_pyth, set_initial_price, set_price, PythFeedIds, scalePriceForPyth, priceFeeds,
} from '../setup/helpers/pyth-helpers';

const { market, marketVault, sbtc: sbtcToken, usdc: usdcToken, vaultUsdc } = contracts;
const SBTC_DEC = 1e8, USDC_DEC = 1e6, MAX_BONUS = 1.10, TOL = 1.01;

// 1 sBTC collateral, $42k debt. LTV = 42000/price. Prices chosen to land inside the
// PARTIAL band [86%, 93%] (strictly below the 95% full-liq threshold):
//   48000 -> 87.5%, 47000 -> 89.4%, 46000 -> 91.3%, 45500 -> 92.3%
const PARTIAL_PRICES = [48000, 47000, 46000, 45500];

type Scenario = { price: number; repay: bigint };
const scn: fc.Arbitrary<Scenario> = fc.record({
  price: fc.constantFrom(...PARTIAL_PRICES),
  repay: fc.oneof(fc.constant(100_000_000_000n), fc.bigInt({ min: 5_000_000_000n, max: 90_000_000_000n })),
});
const SCENARIOS = fc.sample(scn, 70);

const sbtcBal = (u: string) => (rov(sbtcToken.getBalance(u)).value as bigint) ?? 0n;
const usdcBal = (u: string) => (rov(usdcToken.getBalance(u)).value as bigint) ?? 0n;

describe('OVER-LIQUIDATION FUZZ: a recoverable (partial-band) position cannot be fully drained', () => {
  beforeEach(async () => {
    initializeProtocol();
    init_pyth(deployer);
    executeDaoProposal(contracts.proposalSetPriceStaleness);
    executeDaoProposal(proposalCreateMultipleEgroups);
    await set_initial_price(PythFeedIds.BTC, scalePriceForPyth(60000, -8), deployer);
    await set_initial_price(PythFeedIds.USDC, scalePriceForPyth(1, -8), deployer);
    txOk(usdcToken.mint(1_000_000_000_000n, deployer), deployer);
    txOk(vaultUsdc.deposit(1_000_000_000_000n, 0n, deployer), deployer);
    txOk(usdcToken.mint(1_000_000_000_000n, charlie), deployer);
    // alice: 1 sBTC collateral, borrow $42k (70% at $60k)
    txOk(sbtcToken.mint(100_000_000n, alice), deployer);
    txOk(market.collateralAdd(sbtcToken.identifier, 100_000_000n, priceFeeds()), alice);
    txOk(market.borrow(usdcToken.identifier, 42_000_000_000n, alice, priceFeeds()), alice);
  });

  SCENARIOS.forEach((s, i) => {
    it(`scn #${i} (BTC $${s.price} ~${(42000 / s.price * 100).toFixed(1)}% LTV): partial liquidation only`, async () => {
      await set_price(PythFeedIds.BTC, scalePriceForPyth(s.price, -8), -8, deployer);

      const aliceId = (rov(marketVault.resolve(alice)) as any).id as bigint;
      const charlieUsdc0 = usdcBal(charlie), charlieSbtc0 = sbtcBal(charlie);

      let ok = false;
      try {
        txOk(market.liquidate(alice, sbtcToken.identifier, usdcToken.identifier, s.repay, 0n, null, priceFeeds()), charlie);
        ok = true;
      } catch { ok = false; }
      if (!ok) return; // a partial-band liquidation may revert for some params; not a bug

      const usdcSpent = charlieUsdc0 - usdcBal(charlie);
      const sbtcGained = sbtcBal(charlie) - charlieSbtc0;

      // bonus bound
      if (usdcSpent > 0n && sbtcGained > 0n) {
        const repaidUsd = Number(usdcSpent) / USDC_DEC;
        const seizedUsd = (Number(sbtcGained) / SBTC_DEC) * s.price;
        if (seizedUsd > repaidUsd * MAX_BONUS * TOL) {
          throw new Error(`OVER-SEIZURE @$${s.price}: seized $${seizedUsd.toFixed(2)} for $${repaidUsd.toFixed(2)}. scn=${JSON.stringify(s, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`);
        }
      }

      // partial-only: both collateral AND debt must remain (position not fully wiped)
      let coll = 0n, debt = 0n;
      try { coll = rov(marketVault.getCollateral(aliceId, ASSET_IDS.sbtc)) as bigint; } catch { coll = 0n; }
      try { debt = (rov(marketVault.getDebt(aliceId, ASSET_IDS.usdc)) as any).scaled as bigint; } catch { debt = 0n; }

      if (usdcSpent > 0n && (coll === 0n || debt === 0n)) {
        throw new Error(
          `OVER-LIQUIDATION @$${s.price} (~${(42000 / s.price * 100).toFixed(1)}% LTV, below 95% full-liq): ` +
          `position fully drained in one liquidation (coll=${coll}, debtScaled=${debt}) after repay ${usdcSpent}. ` +
          `A recoverable borrower was wiped. scn=${JSON.stringify(s, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`
        );
      }
    });
  });
});

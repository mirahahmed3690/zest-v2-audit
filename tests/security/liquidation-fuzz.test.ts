// LIQUIDATION fuzz for Zest V2 (sBTC collateral / USDC debt, egroup 1 = 70% LTV).
//
// Liquidation is where value is physically transferred from a borrower to a
// liquidator. Two safety properties must hold no matter the price path or repay size:
//
//   (A) NO OVER-SEIZURE: the USD value of collateral the liquidator receives must not
//       exceed the USD value of debt they repaid, times (1 + MAX_BONUS). Zest's max
//       liquidation penalty is 10%, so seized_usd <= repaid_usd * 1.10. Anything more
//       is collateral stolen from the borrower / protocol.
//
//   (B) NO LIQUIDATING A HEALTHY POSITION: if the borrower is healthy at the current
//       price (debt_usd <= coll_usd * LTV), a liquidate() MUST fail. A success means a
//       solvent user just had collateral seized.
//
// Alice is the victim; Charlie the liquidator. The fuzz drives random price drops and
// random repay amounts, then checks (A) after every SUCCESSFUL liquidation and (B) at
// every price where Alice is healthy.
import { describe, it, beforeEach } from 'vitest';
import { txOk, txErr, rov } from '@clarigen/test';
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
const LTV = 0.70, SBTC_DEC = 1e8, USDC_DEC = 1e6;
const MAX_BONUS = 1.10;        // 10% max liquidation penalty
const TOL = 1.01;              // 1% slack for index/rounding dust
const PRICES = [60000, 55000, 50000, 46000, 42000, 38000, 32000, 28000];

type Op =
  | { t: 'setPrice'; price: number }
  | { t: 'liquidate'; repay: bigint };

const repayAmt = fc.oneof(
  fc.constant(1n),
  fc.bigInt({ min: 1n, max: 100_000n }),
  fc.bigInt({ min: 1_000_000_000n, max: 45_000_000_000n }), // up to $45k
);

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.constantFrom(...PRICES).map((price) => ({ t: 'setPrice', price } as Op)),
  repayAmt.map((repay) => ({ t: 'liquidate', repay } as Op)),
);

const SEQUENCES = fc.sample(fc.array(opArb, { minLength: 2, maxLength: 16 }), 90);

const sbtcBal = (u: string) => (rov(sbtcToken.getBalance(u)).value as bigint) ?? 0n;
const usdcBal = (u: string) => (rov(usdcToken.getBalance(u)).value as bigint) ?? 0n;

describe('LIQUIDATION FUZZ: no over-seizure, and no liquidation of a healthy position', () => {
  let aliceCollSbtc = 100_000_000n; // 1 sBTC
  let aliceDebtUsdc = 42_000_000_000n; // $42k = exactly 70% at $60k

  beforeEach(async () => {
    initializeProtocol();
    init_pyth(deployer);
    executeDaoProposal(contracts.proposalSetPriceStaleness);
    executeDaoProposal(proposalCreateMultipleEgroups);
    await set_initial_price(PythFeedIds.BTC, scalePriceForPyth(60000, -8), deployer);
    await set_initial_price(PythFeedIds.USDC, scalePriceForPyth(1, -8), deployer);
    // liquidity so Alice can borrow
    txOk(usdcToken.mint(1_000_000_000_000n, deployer), deployer);
    txOk(vaultUsdc.deposit(1_000_000_000_000n, 0n, deployer), deployer);
    // Alice opens a max (70%) position at $60k
    txOk(sbtcToken.mint(aliceCollSbtc, alice), deployer);
    txOk(market.collateralAdd(sbtcToken.identifier, aliceCollSbtc, priceFeeds()), alice);
    txOk(market.borrow(usdcToken.identifier, aliceDebtUsdc, alice, priceFeeds()), alice);
    // Charlie the liquidator, well funded
    txOk(usdcToken.mint(500_000_000_000n, charlie), deployer);
  });

  SEQUENCES.forEach((ops, i) => {
    it(`seq #${i} (${ops.length} ops): liquidation bonus bounded, healthy never liquidated`, async () => {
      let btc = 60000;

      for (const op of ops) {
        if (op.t === 'setPrice') {
          await set_price(PythFeedIds.BTC, scalePriceForPyth(op.price, -8), -8, deployer);
          btc = op.price;
          continue;
        }

        // op.t === 'liquidate'
        // Alice's obligation id is VALID starting at 0 (she's the first account), so
        // id===0 is a real position — never skip on the id value. resolve() panics only
        // if she was never registered; getCollateral/getDebt panic when the (id,asset)
        // entry is gone (position fully closed) -> caught as 0 -> nothing to liquidate.
        let aliceId: bigint;
        try {
          aliceId = (rov(marketVault.resolve(alice)) as any).id as bigint;
        } catch { continue; }

        let collBefore = 0n, debtScaled = 0n;
        try { collBefore = rov(marketVault.getCollateral(aliceId, ASSET_IDS.sbtc)) as bigint; } catch { collBefore = 0n; }
        try { debtScaled = (rov(marketVault.getDebt(aliceId, ASSET_IDS.usdc)) as any).scaled as bigint; } catch { debtScaled = 0n; }
        if (collBefore === 0n || debtScaled === 0n) continue; // nothing to liquidate

        // Is Alice healthy at the current price? (model-side)
        const collUsd = (Number(collBefore) / SBTC_DEC) * btc;
        // debtScaled is index-scaled; approximate USD with >= actual (index >= 1), so
        // "healthy" here is conservative: if our lower-bound debt is already under the
        // limit, the true position is too.
        const debtUsdApprox = Number(debtScaled) / USDC_DEC;
        const healthy = debtUsdApprox <= collUsd * LTV;

        const charlieUsdcBefore = usdcBal(charlie);
        const charlieSbtcBefore = sbtcBal(charlie);

        let ok = false;
        try {
          txOk(
            market.liquidate(alice, sbtcToken.identifier, usdcToken.identifier, op.repay, 0n, null, priceFeeds()),
            charlie,
          );
          ok = true;
        } catch { ok = false; }

        if (!ok) continue;

        const usdcSpent = charlieUsdcBefore - usdcBal(charlie);
        const sbtcGained = sbtcBal(charlie) - charlieSbtcBefore;

        // (B) healthy position must NOT have been liquidatable
        if (healthy && (usdcSpent > 0n || sbtcGained > 0n)) {
          throw new Error(
            `HEALTHY LIQUIDATED at BTC=$${btc}: debt~$${debtUsdApprox.toFixed(2)} <= ` +
            `max=$${(collUsd * LTV).toFixed(2)} yet liquidation seized ${sbtcGained} sats for ${usdcSpent} uUSDC. ` +
            `seq=${JSON.stringify(ops, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`
          );
        }

        // (A) over-seizure: value out must be bounded by value in * (1 + max bonus)
        if (usdcSpent > 0n && sbtcGained > 0n) {
          const repaidUsd = Number(usdcSpent) / USDC_DEC;
          const seizedUsd = (Number(sbtcGained) / SBTC_DEC) * btc;
          if (seizedUsd > repaidUsd * MAX_BONUS * TOL) {
            throw new Error(
              `OVER-SEIZURE at BTC=$${btc}: seized $${seizedUsd.toFixed(2)} of sBTC for ` +
              `only $${repaidUsd.toFixed(2)} repaid (ratio ${(seizedUsd / repaidUsd).toFixed(4)} > ${MAX_BONUS}). ` +
              `Liquidator drained extra collateral. ` +
              `seq=${JSON.stringify(ops, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`
            );
          }
        }
      }
    });
  });
});

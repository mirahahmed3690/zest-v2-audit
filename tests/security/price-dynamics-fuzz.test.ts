// Price-DYNAMICS fuzz for Zest V2 (sBTC collateral / USDC debt, egroup 1 = 70%).
//
// BTC price moves between ops. A price DROP can legitimately leave a position
// underwater (awaiting liquidation) — that is NOT a bug. The bug this hunts is a
// STALE / BYPASSED price check: a user ACTION (borrow or collateral-remove) that
// SUCCEEDS while leaving the position unhealthy AT THE CURRENT PRICE.
//
// INVARIANT: immediately after a SUCCESSFUL borrow or collateral-remove,
// debt_usd <= collateral_usd * LTV (at the current BTC price). We do NOT assert
// after price changes / repay / collateral-add (those can be underwater or only
// improve health). A violation means the health check used a wrong or stale price.
import { describe, it, beforeEach } from 'vitest';
import { txOk } from '@clarigen/test';
import { fc } from '@fast-check/vitest';
import {
  deployer, alice, bob,
  initializeProtocol, executeDaoProposal, contracts, proposalCreateMultipleEgroups,
} from '../setup/helpers';
import {
  init_pyth, set_initial_price, set_price, PythFeedIds, scalePriceForPyth, priceFeeds,
} from '../setup/helpers/pyth-helpers';

const { market, sbtc: sbtcToken, usdc: usdcToken, vaultUsdc } = contracts;
const LTV = 0.70, SBTC_DEC = 1e8, USDC_DEC = 1e6, TOL = 1.01;
const PRICES = [30000, 45000, 60000, 75000, 90000];

type Op =
  | { t: 'addColl'; amt: bigint }
  | { t: 'borrow'; amt: bigint }
  | { t: 'repay'; amt: bigint }
  | { t: 'removeColl'; amt: bigint }
  | { t: 'setPrice'; price: number };

const sbtcAmt = fc.oneof(fc.constant(1n), fc.bigInt({ min: 1n, max: 1000n }), fc.bigInt({ min: 10_000_000n, max: 150_000_000n }));
const usdcAmt = fc.oneof(fc.constant(1n), fc.bigInt({ min: 1n, max: 5000n }), fc.bigInt({ min: 1_000_000_000n, max: 60_000_000_000n }));

const opArb: fc.Arbitrary<Op> = fc.oneof(
  sbtcAmt.map((amt) => ({ t: 'addColl', amt } as Op)),
  usdcAmt.map((amt) => ({ t: 'borrow', amt } as Op)),
  usdcAmt.map((amt) => ({ t: 'repay', amt } as Op)),
  sbtcAmt.map((amt) => ({ t: 'removeColl', amt } as Op)),
  fc.constantFrom(...PRICES).map((price) => ({ t: 'setPrice', price } as Op)),
);

const SEQUENCES = fc.sample(fc.array(opArb, { minLength: 2, maxLength: 18 }), 80);
const trySend = (call: any, s: string) => { try { txOk(call, s); return true; } catch { return false; } };

describe('PRICE-DYNAMICS FUZZ: no borrow/withdraw may succeed leaving an unhealthy position at the current price', () => {
  beforeEach(async () => {
    initializeProtocol();
    init_pyth(deployer);
    executeDaoProposal(contracts.proposalSetPriceStaleness);
    executeDaoProposal(proposalCreateMultipleEgroups);
    await set_initial_price(PythFeedIds.BTC, scalePriceForPyth(60000, -8), deployer);
    await set_initial_price(PythFeedIds.USDC, scalePriceForPyth(1, -8), deployer);
    txOk(usdcToken.mint(1_000_000_000_000n, bob), deployer);
    txOk(vaultUsdc.deposit(1_000_000_000_000n, 0n, bob), bob);
    txOk(usdcToken.mint(1_000_000_000_000n, alice), deployer);
  });

  SEQUENCES.forEach((ops, i) => {
    it(`seq #${i} (${ops.length} ops) never leaves an unhealthy state after a successful action`, async () => {
      let collSbtc = 0n, debtUsdc = 0n, btc = 60000;

      for (const op of ops) {
        let didAction = false; // true only for borrow / removeColl successes

        if (op.t === 'addColl') {
          txOk(sbtcToken.mint(op.amt, alice), deployer);
          if (trySend(market.collateralAdd(sbtcToken.identifier, op.amt, priceFeeds()), alice)) collSbtc += op.amt;
        } else if (op.t === 'borrow') {
          if (trySend(market.borrow(usdcToken.identifier, op.amt, alice, priceFeeds()), alice)) { debtUsdc += op.amt; didAction = true; }
        } else if (op.t === 'repay') {
          const p = op.amt > debtUsdc ? debtUsdc : op.amt; if (p === 0n) continue;
          if (trySend(market.repay(usdcToken.identifier, p, alice), alice)) debtUsdc -= p;
        } else if (op.t === 'removeColl') {
          const r = op.amt > collSbtc ? collSbtc : op.amt; if (r === 0n) continue;
          if (trySend(market.collateralRemove(sbtcToken.identifier, r, alice, priceFeeds()), alice)) { collSbtc -= r; didAction = true; }
        } else {
          await set_price(PythFeedIds.BTC, scalePriceForPyth(op.price, -8), -8, deployer);
          btc = op.price;
        }

        if (didAction) {
          const collUsd = (Number(collSbtc) / SBTC_DEC) * btc;
          const debtUsd = Number(debtUsdc) / USDC_DEC;
          if (debtUsd > 0 && debtUsd > collUsd * LTV * TOL) {
            throw new Error(
              `STALE-PRICE VIOLATION after ${op.t}: debt=$${debtUsd.toFixed(2)} > ` +
              `max=$${(collUsd * LTV).toFixed(2)} at BTC=$${btc} (coll=$${collUsd.toFixed(2)}). ` +
              `sbtc=${collSbtc} usdc=${debtUsdc}. seq=${JSON.stringify(ops, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`
            );
          }
        }
      }
    });
  });
});

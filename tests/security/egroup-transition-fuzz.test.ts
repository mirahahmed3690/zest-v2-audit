// Multi-asset EFFICIENCY-GROUP transition fuzz for Zest V2.
//
// sBTC collateral, debt in USDC and/or USDH. The applicable egroup (and its LTV)
// changes with the DEBT MIX:
//   debt {USDC}        -> EG1 = 70%
//   debt {USDH}        -> EG2 = 65%
//   debt {USDC, USDH}  -> EG5 = 55%
//
// INVARIANT: after any successful op, debt_usd <= collateral_usd * LTV(debt-mix).
// The sharp bug this hunts: a user borrows USDC to ~70%, then borrows a little
// USDH — the correct egroup becomes EG5 (55%), so the position is now far over
// the 55% bound. That second borrow MUST be rejected. If the protocol checks
// against the stale egroup (or mis-resolves), it leaks bad debt. The fuzz will
// surface any sequence where a SUCCEEDED op leaves debt over the correct LTV.
import { describe, it, beforeEach } from 'vitest';
import { txOk } from '@clarigen/test';
import { fc } from '@fast-check/vitest';
import {
  deployer, alice, bob,
  initializeProtocol, executeDaoProposal, contracts, proposalCreateMultipleEgroups,
} from '../setup/helpers';
import {
  init_pyth, set_initial_price, PythFeedIds, scalePriceForPyth, priceFeeds,
} from '../setup/helpers/pyth-helpers';

const { market, sbtc: sbtcToken, usdc: usdcToken, usdh: usdhToken, vaultUsdc, vaultUsdh } = contracts;

const BTC = 60000;
const SBTC_DEC = 1e8, USDC_DEC = 1e6, USDH_DEC = 1e8, TOL = 1.01;

type Op =
  | { t: 'addColl'; amt: bigint }
  | { t: 'borrowUsdc'; amt: bigint }
  | { t: 'borrowUsdh'; amt: bigint }
  | { t: 'repayUsdc'; amt: bigint }
  | { t: 'repayUsdh'; amt: bigint }
  | { t: 'removeColl'; amt: bigint };

const sbtcAmt = fc.oneof(
  fc.constant(1n), fc.bigInt({ min: 1n, max: 1000n }),
  fc.bigInt({ min: 10_000_000n, max: 150_000_000n }),
);
const usdcAmt = fc.oneof(
  fc.constant(1n), fc.bigInt({ min: 1n, max: 5000n }),
  fc.bigInt({ min: 1_000_000_000n, max: 60_000_000_000n }),
);
const usdhAmt = fc.oneof(
  fc.constant(1n), fc.bigInt({ min: 1n, max: 5000n }),
  fc.bigInt({ min: 100_000_000_000n, max: 6_000_000_000_000n }), // USDH 8dec: $1k–$60k
);

const opArb: fc.Arbitrary<Op> = fc.oneof(
  sbtcAmt.map((amt) => ({ t: 'addColl', amt } as Op)),
  usdcAmt.map((amt) => ({ t: 'borrowUsdc', amt } as Op)),
  usdhAmt.map((amt) => ({ t: 'borrowUsdh', amt } as Op)),
  usdcAmt.map((amt) => ({ t: 'repayUsdc', amt } as Op)),
  usdhAmt.map((amt) => ({ t: 'repayUsdh', amt } as Op)),
  sbtcAmt.map((amt) => ({ t: 'removeColl', amt } as Op)),
);

const SEQUENCES = fc.sample(fc.array(opArb, { minLength: 2, maxLength: 16 }), 70);

function ltvFor(debtUsdc: bigint, debtUsdh: bigint): number {
  const c = debtUsdc > 0n, h = debtUsdh > 0n;
  if (c && h) return 0.55; // EG5
  if (c) return 0.70;      // EG1
  if (h) return 0.65;      // EG2
  return 1;                // no debt
}
const trySend = (call: any, s: string) => { try { txOk(call, s); return true; } catch { return false; } };

describe('EGROUP TRANSITION FUZZ: debt mix must apply the correct LTV', () => {
  beforeEach(async () => {
    initializeProtocol();
    init_pyth(deployer);
    executeDaoProposal(contracts.proposalSetPriceStaleness);
    executeDaoProposal(proposalCreateMultipleEgroups);
    await set_initial_price(PythFeedIds.BTC, scalePriceForPyth(BTC, -8), deployer);
    await set_initial_price(PythFeedIds.USDC, scalePriceForPyth(1, -8), deployer);
    // liquidity in both debt vaults
    txOk(usdcToken.mint(1_000_000_000_000n, bob), deployer);
    txOk(vaultUsdc.deposit(1_000_000_000_000n, 0n, bob), bob);
    txOk(usdhToken.mint(100_000_000_000_000n, bob), deployer);
    txOk(vaultUsdh.deposit(9_000_000_000_000n, 0n, bob), bob);
    // spare for repay
    txOk(usdcToken.mint(1_000_000_000_000n, alice), deployer);
    txOk(usdhToken.mint(100_000_000_000_000n, alice), deployer);
  });

  SEQUENCES.forEach((ops, i) => {
    it(`seq #${i} (${ops.length} ops) keeps debt within the debt-mix LTV`, () => {
      let collSbtc = 0n, debtUsdc = 0n, debtUsdh = 0n;

      for (const op of ops) {
        if (op.t === 'addColl') {
          txOk(sbtcToken.mint(op.amt, alice), deployer);
          if (trySend(market.collateralAdd(sbtcToken.identifier, op.amt, priceFeeds()), alice)) collSbtc += op.amt;
        } else if (op.t === 'borrowUsdc') {
          if (trySend(market.borrow(usdcToken.identifier, op.amt, alice, priceFeeds()), alice)) debtUsdc += op.amt;
        } else if (op.t === 'borrowUsdh') {
          if (trySend(market.borrow(usdhToken.identifier, op.amt, alice, priceFeeds()), alice)) debtUsdh += op.amt;
        } else if (op.t === 'repayUsdc') {
          const p = op.amt > debtUsdc ? debtUsdc : op.amt; if (p === 0n) continue;
          if (trySend(market.repay(usdcToken.identifier, p, alice), alice)) debtUsdc -= p;
        } else if (op.t === 'repayUsdh') {
          const p = op.amt > debtUsdh ? debtUsdh : op.amt; if (p === 0n) continue;
          if (trySend(market.repay(usdhToken.identifier, p, alice), alice)) debtUsdh -= p;
        } else {
          const r = op.amt > collSbtc ? collSbtc : op.amt; if (r === 0n) continue;
          if (trySend(market.collateralRemove(sbtcToken.identifier, r, alice, priceFeeds()), alice)) collSbtc -= r;
        }

        const collUsd = (Number(collSbtc) / SBTC_DEC) * BTC;
        const debtUsd = Number(debtUsdc) / USDC_DEC + Number(debtUsdh) / USDH_DEC;
        const ltv = ltvFor(debtUsdc, debtUsdh);
        if (debtUsd > 0 && debtUsd > collUsd * ltv * TOL) {
          throw new Error(
            `EGROUP INVARIANT VIOLATED after ${op.t}: debt=$${debtUsd.toFixed(2)} > ` +
            `max=$${(collUsd * ltv).toFixed(2)} (coll=$${collUsd.toFixed(2)}, ltv=${ltv}). ` +
            `usdc=${debtUsdc} usdh=${debtUsdh} sbtc=${collSbtc}. ` +
            `seq=${JSON.stringify(ops, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`
          );
        }
      }
    });
  });
});

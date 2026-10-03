// Collateral-side EFFICIENCY-GROUP fuzz for Zest V2.
//
// Collateral in sBTC and/or ststx, debt in USDC. The egroup (and LTV) changes
// with the COLLATERAL MIX:
//   coll {sBTC}         -> EG1 = 70%
//   coll {ststx}        -> EG3 = 50%
//   coll {sBTC, ststx}  -> EG4 = 45%
//
// INVARIANT: after any successful op, debt_usd <= collateral_usd * LTV(coll-mix).
// Sharp hunt: borrow against sBTC at 70%, then add ststx — the correct egroup is
// now EG4 (45%); any later borrow/withdraw must respect 45%, not the stale 70%.
//
// Prices: BTC $60,000; ststx = STX_feed * ratio. We set STX_feed = $1.00 and read
// the live ststx ratio so the USD model is exact regardless of the mock's ratio.
import { describe, it, beforeEach } from 'vitest';
import { txOk, rov } from '@clarigen/test';
import { fc } from '@fast-check/vitest';
import {
  deployer, alice, bob,
  initializeProtocol, executeDaoProposal, contracts, proposalCreateMultipleEgroups,
} from '../setup/helpers';
import {
  init_pyth, set_initial_price, PythFeedIds, scalePriceForPyth, priceFeeds,
} from '../setup/helpers/pyth-helpers';

const { market, sbtc: sbtcToken, ststx: ststxToken, usdc: usdcToken, vaultUsdc } = contracts;
const BTC = 60000, SBTC_DEC = 1e8, STSTX_DEC = 1e6, USDC_DEC = 1e6, TOL = 1.02;

// ststx USD price, filled at setup from the live ratio.
let STSTX_USD = 1.0;

type Op =
  | { t: 'addSbtc'; amt: bigint }
  | { t: 'addStstx'; amt: bigint }
  | { t: 'borrow'; amt: bigint }
  | { t: 'repay'; amt: bigint }
  | { t: 'rmSbtc'; amt: bigint }
  | { t: 'rmStstx'; amt: bigint };

const sbtcAmt = fc.oneof(fc.constant(1n), fc.bigInt({ min: 1n, max: 1000n }), fc.bigInt({ min: 10_000_000n, max: 100_000_000n }));
const ststxAmt = fc.oneof(fc.constant(1n), fc.bigInt({ min: 1n, max: 1000n }), fc.bigInt({ min: 1_000_000n, max: 5_000_000_000n }));
const usdcAmt = fc.oneof(fc.constant(1n), fc.bigInt({ min: 1n, max: 5000n }), fc.bigInt({ min: 1_000_000_000n, max: 50_000_000_000n }));

const opArb: fc.Arbitrary<Op> = fc.oneof(
  sbtcAmt.map((amt) => ({ t: 'addSbtc', amt } as Op)),
  ststxAmt.map((amt) => ({ t: 'addStstx', amt } as Op)),
  usdcAmt.map((amt) => ({ t: 'borrow', amt } as Op)),
  usdcAmt.map((amt) => ({ t: 'repay', amt } as Op)),
  sbtcAmt.map((amt) => ({ t: 'rmSbtc', amt } as Op)),
  ststxAmt.map((amt) => ({ t: 'rmStstx', amt } as Op)),
);

const SEQUENCES = fc.sample(fc.array(opArb, { minLength: 2, maxLength: 16 }), 70);

function ltvFor(sbtc: bigint, ststx: bigint): number {
  const b = sbtc > 0n, s = ststx > 0n;
  if (b && s) return 0.45; // EG4
  if (b) return 0.70;      // EG1
  if (s) return 0.50;      // EG3
  return 1;
}
const trySend = (call: any, se: string) => { try { txOk(call, se); return true; } catch { return false; } };

describe('COLLATERAL-SIDE EGROUP FUZZ: collateral mix must apply the correct LTV', () => {
  beforeEach(async () => {
    initializeProtocol();
    init_pyth(deployer);
    executeDaoProposal(contracts.proposalSetPriceStaleness);
    executeDaoProposal(proposalCreateMultipleEgroups);
    await set_initial_price(PythFeedIds.BTC, scalePriceForPyth(BTC, -8), deployer);
    await set_initial_price(PythFeedIds.USDC, scalePriceForPyth(1, -8), deployer);
    await set_initial_price(PythFeedIds.STX, scalePriceForPyth(1, 0), deployer); // $1.00
    // read live ststx ratio -> exact ststx USD price (STX $1 * ratio/1e6)
    try {
      const r = rov(market.callStstxRatio());
      const ratio = Number((r as any).value ?? (r as any));
      if (ratio > 0) STSTX_USD = (1.0 * ratio) / 1_000_000;
    } catch { STSTX_USD = 1.0; }
    txOk(usdcToken.mint(1_000_000_000_000n, bob), deployer);
    txOk(vaultUsdc.deposit(1_000_000_000_000n, 0n, bob), bob);
    txOk(usdcToken.mint(1_000_000_000_000n, alice), deployer);
  });

  SEQUENCES.forEach((ops, i) => {
    it(`seq #${i} (${ops.length} ops) keeps debt within the collateral-mix LTV`, () => {
      let sbtc = 0n, ststx = 0n, usdc = 0n;

      for (const op of ops) {
        if (op.t === 'addSbtc') {
          txOk(sbtcToken.mint(op.amt, alice), deployer);
          if (trySend(market.collateralAdd(sbtcToken.identifier, op.amt, priceFeeds()), alice)) sbtc += op.amt;
        } else if (op.t === 'addStstx') {
          txOk(ststxToken.mint(op.amt, alice), deployer);
          if (trySend(market.collateralAdd(ststxToken.identifier, op.amt, priceFeeds()), alice)) ststx += op.amt;
        } else if (op.t === 'borrow') {
          if (trySend(market.borrow(usdcToken.identifier, op.amt, alice, priceFeeds()), alice)) usdc += op.amt;
        } else if (op.t === 'repay') {
          const p = op.amt > usdc ? usdc : op.amt; if (p === 0n) continue;
          if (trySend(market.repay(usdcToken.identifier, p, alice), alice)) usdc -= p;
        } else if (op.t === 'rmSbtc') {
          const r = op.amt > sbtc ? sbtc : op.amt; if (r === 0n) continue;
          if (trySend(market.collateralRemove(sbtcToken.identifier, r, alice, priceFeeds()), alice)) sbtc -= r;
        } else {
          const r = op.amt > ststx ? ststx : op.amt; if (r === 0n) continue;
          if (trySend(market.collateralRemove(ststxToken.identifier, r, alice, priceFeeds()), alice)) ststx -= r;
        }

        const collUsd = (Number(sbtc) / SBTC_DEC) * BTC + (Number(ststx) / STSTX_DEC) * STSTX_USD;
        const debtUsd = Number(usdc) / USDC_DEC;
        const ltv = ltvFor(sbtc, ststx);
        if (debtUsd > 0 && debtUsd > collUsd * ltv * TOL) {
          throw new Error(
            `COLLATERAL-EGROUP VIOLATION after ${op.t}: debt=$${debtUsd.toFixed(2)} > ` +
            `max=$${(collUsd * ltv).toFixed(2)} (coll=$${collUsd.toFixed(2)}, ltv=${ltv}, ststxUsd=${STSTX_USD}). ` +
            `sbtc=${sbtc} ststx=${ststx} usdc=${usdc}. seq=${JSON.stringify(ops, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`
          );
        }
      }
    });
  });
});

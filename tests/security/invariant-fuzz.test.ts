// Property-based solvency fuzz for Zest V2 (sBTC collateral / USDC debt, egroup 1 = 70% LTV).
//
// Invariant: after ANY successful user operation, the position must stay within
// the egroup LTV. We model collateral/debt in USD from fixed prices and flag a
// violation only when a SUCCEEDED op leaves debt_usd > collateral_usd * LTV by a
// meaningful margin (1% tolerance absorbs interest/rounding dust). A real
// health-check bypass blows past that; interest dust does not.
//
// Each random sequence runs on a FRESH chain (beforeEach re-inits simnet), so the
// JS model starts at 0 and stays in lockstep with the contract state.
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

const { market, sbtc: sbtcToken, usdc: usdcToken, vaultUsdc } = contracts;

const BTC_PRICE = 60000, USDC_PRICE = 1, LTV = 0.70;
const SBTC_DEC = 1e8, USDC_DEC = 1e6, TOL = 1.01;

type Op =
  | { t: 'addColl'; amt: bigint }
  | { t: 'borrow'; amt: bigint }
  | { t: 'repay'; amt: bigint }
  | { t: 'removeColl'; amt: bigint };

// Amounts include aggressive edge cases (1 wei, tiny, boundary) where rounding
// bugs hide, plus normal ranges.
const sbtcAmt = fc.oneof(
  fc.constant(1n), fc.constant(2n), fc.constant(1000n),
  fc.bigInt({ min: 1n, max: 500n }),
  fc.bigInt({ min: 10_000_000n, max: 200_000_000n }),
);
const usdcAmt = fc.oneof(
  fc.constant(1n), fc.constant(2n), fc.constant(1000n),
  fc.bigInt({ min: 1n, max: 5000n }),
  fc.bigInt({ min: 1_000_000_000n, max: 84_000_000_000n }), // up to ~$84k (max coll)
);

const opArb: fc.Arbitrary<Op> = fc.oneof(
  sbtcAmt.map((amt) => ({ t: 'addColl', amt } as Op)),
  usdcAmt.map((amt) => ({ t: 'borrow', amt } as Op)),
  usdcAmt.map((amt) => ({ t: 'repay', amt } as Op)),
  sbtcAmt.map((amt) => ({ t: 'removeColl', amt } as Op)),
);

// Pre-generate random sequences; each becomes its own fresh-chain test case.
const SEQUENCES = fc.sample(fc.array(opArb, { minLength: 2, maxLength: 18 }), 90);

function usd(collSbtc: bigint, debtUsdc: bigint) {
  return {
    collUsd: (Number(collSbtc) / SBTC_DEC) * BTC_PRICE,
    debtUsd: (Number(debtUsdc) / USDC_DEC) * USDC_PRICE,
  };
}

function trySend(call: any, sender: string): boolean {
  try { txOk(call, sender); return true; } catch { return false; }
}

describe('SOLVENCY FUZZ: no successful op leaves debt_usd > collateral_usd * LTV', () => {
  beforeEach(async () => {
    initializeProtocol();
    init_pyth(deployer);
    executeDaoProposal(contracts.proposalSetPriceStaleness);
    executeDaoProposal(proposalCreateMultipleEgroups);
    await set_initial_price(PythFeedIds.BTC, scalePriceForPyth(BTC_PRICE, -8), deployer);
    await set_initial_price(PythFeedIds.USDC, scalePriceForPyth(USDC_PRICE, -8), deployer);
    txOk(usdcToken.mint(1_000_000_000_000n, bob), deployer);
    txOk(vaultUsdc.deposit(1_000_000_000_000n, 0n, bob), bob);
    txOk(usdcToken.mint(1_000_000_000_000n, alice), deployer); // spare USDC for repay
  });

  SEQUENCES.forEach((ops, i) => {
    it(`sequence #${i} (${ops.length} ops) keeps the position within LTV`, () => {
      let collSbtc = 0n, debtUsdc = 0n;

      for (const op of ops) {
        if (op.t === 'addColl') {
          txOk(sbtcToken.mint(op.amt, alice), deployer);
          if (trySend(market.collateralAdd(sbtcToken.identifier, op.amt, priceFeeds()), alice))
            collSbtc += op.amt;
        } else if (op.t === 'borrow') {
          if (trySend(market.borrow(usdcToken.identifier, op.amt, alice, priceFeeds()), alice))
            debtUsdc += op.amt;
        } else if (op.t === 'repay') {
          const pay = op.amt > debtUsdc ? debtUsdc : op.amt;
          if (pay === 0n) continue;
          if (trySend(market.repay(usdcToken.identifier, pay, alice), alice))
            debtUsdc -= pay;
        } else {
          const rem = op.amt > collSbtc ? collSbtc : op.amt;
          if (rem === 0n) continue;
          if (trySend(market.collateralRemove(sbtcToken.identifier, rem, alice, priceFeeds()), alice))
            collSbtc -= rem;
        }

        const { collUsd, debtUsd } = usd(collSbtc, debtUsdc);
        if (debtUsd > 0 && debtUsd > collUsd * LTV * TOL) {
          throw new Error(
            `INVARIANT VIOLATED after op ${op.t}: debt=$${debtUsd.toFixed(2)} > ` +
            `maxAllowed=$${(collUsd * LTV).toFixed(2)} (coll=$${collUsd.toFixed(2)}). ` +
            `State: collSbtc=${collSbtc} debtUsdc=${debtUsdc}. Seq=${JSON.stringify(ops, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`
          );
        }
      }
    });
  });
});

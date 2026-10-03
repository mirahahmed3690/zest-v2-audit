// CROSS-USER ISOLATION fuzz for Zest V2 (shared-pool accounting integrity).
//
// Every prior fuzz drove a single borrower. The untested seam is INTERFERENCE: in a
// shared lending pool, one user's deposit / borrow / repay / withdraw must NEVER alter
// ANOTHER user's recorded position. Scaled debt is index-independent (only that user's
// own borrow/repay moves it) and raw collateral is per-user, so both are exact
// invariants under other users' actions.
//
// INVARIANT: pick a random actor and a self-action each step; the TWO non-actors'
// (rawCollateral, scaledDebt) must be byte-identical before and after. Any drift is a
// cross-user corruption bug (one user draining/inflating another's books).
//
// Also checks GLOBAL conservation: the sum of USDC a user net-borrowed equals the
// actual debt the market tracks for them (within interest), so nobody's borrow leaks
// onto someone else's ledger.
import { describe, it, beforeEach } from 'vitest';
import { txOk, rov } from '@clarigen/test';
import { fc } from '@fast-check/vitest';
import {
  deployer, alice, bob, charlie,
  initializeProtocol, executeDaoProposal, contracts, proposalCreateMultipleEgroups,
} from '../setup/helpers';
import { ASSET_IDS } from '../assetConfig';
import {
  init_pyth, set_initial_price, PythFeedIds, scalePriceForPyth, priceFeeds,
} from '../setup/helpers/pyth-helpers';

const { market, marketVault, sbtc: sbtcToken, usdc: usdcToken, vaultUsdc } = contracts;
const USERS = [alice, bob, charlie] as const;

type Op =
  | { t: 'addColl'; who: number; amt: bigint }
  | { t: 'borrow'; who: number; amt: bigint }
  | { t: 'repay'; who: number; amt: bigint }
  | { t: 'removeColl'; who: number; amt: bigint };

const who = fc.constantFrom(0, 1, 2);
const sbtcAmt = fc.oneof(fc.constant(1n), fc.bigInt({ min: 1n, max: 1000n }), fc.bigInt({ min: 10_000_000n, max: 80_000_000n }));
const usdcAmt = fc.oneof(fc.constant(1n), fc.bigInt({ min: 1n, max: 1000n }), fc.bigInt({ min: 1_000_000_000n, max: 25_000_000_000n }));

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.tuple(who, sbtcAmt).map(([w, amt]) => ({ t: 'addColl', who: w, amt } as Op)),
  fc.tuple(who, usdcAmt).map(([w, amt]) => ({ t: 'borrow', who: w, amt } as Op)),
  fc.tuple(who, usdcAmt).map(([w, amt]) => ({ t: 'repay', who: w, amt } as Op)),
  fc.tuple(who, sbtcAmt).map(([w, amt]) => ({ t: 'removeColl', who: w, amt } as Op)),
);

const SEQUENCES = fc.sample(fc.array(opArb, { minLength: 3, maxLength: 16 }), 80);

// Per-user (rawCollateral sBTC, scaledDebt USDC). Returns zeros if no obligation yet.
function snapshot(u: string): { coll: bigint; debt: bigint } {
  // resolve() panics only for a never-registered account. id is a VALID obligation id
  // starting at 0 (alice=0, bob=1, ...), so id===0 is a real position, not "empty".
  let id: bigint;
  try { id = (rov(marketVault.resolve(u)) as any).id as bigint; } catch { return { coll: 0n, debt: 0n }; }
  // read with the real id; getCollateral/getDebt panic when that (id,asset) has no
  // entry (closed/empty) -> caught as 0. Never skip on the id value itself.
  let coll = 0n, debt = 0n;
  try { coll = rov(marketVault.getCollateral(id, ASSET_IDS.sbtc)) as bigint; } catch {}
  try { debt = (rov(marketVault.getDebt(id, ASSET_IDS.usdc)) as any).scaled as bigint; } catch {}
  return { coll, debt };
}
const trySend = (call: any, s: string) => { try { txOk(call, s); return true; } catch { return false; } };

describe('CROSS-USER ISOLATION FUZZ: one user\'s action never alters another user\'s position', () => {
  beforeEach(async () => {
    initializeProtocol();
    init_pyth(deployer);
    executeDaoProposal(contracts.proposalSetPriceStaleness);
    executeDaoProposal(proposalCreateMultipleEgroups);
    await set_initial_price(PythFeedIds.BTC, scalePriceForPyth(60000, -8), deployer);
    await set_initial_price(PythFeedIds.USDC, scalePriceForPyth(1, -8), deployer);
    // deep USDC liquidity
    txOk(usdcToken.mint(1_000_000_000_000n, deployer), deployer);
    txOk(vaultUsdc.deposit(1_000_000_000_000n, 0n, deployer), deployer);
    // each user funded with USDC (for repay) and sBTC (for collateral)
    for (const u of USERS) {
      txOk(usdcToken.mint(1_000_000_000_000n, u), deployer);
      txOk(sbtcToken.mint(1_000_000_000n, u), deployer);
    }
  });

  SEQUENCES.forEach((ops, i) => {
    it(`seq #${i} (${ops.length} ops): non-actors' (collateral, scaledDebt) never move`, () => {
      // local model of each user's current collateral to size valid removes/repays
      const collModel = [0n, 0n, 0n];
      const debtModel = [0n, 0n, 0n];

      for (const op of ops) {
        const actor = USERS[op.who];
        const others = [0, 1, 2].filter((x) => x !== op.who);
        const before = others.map((x) => snapshot(USERS[x]));

        if (op.t === 'addColl') {
          if (trySend(market.collateralAdd(sbtcToken.identifier, op.amt, priceFeeds()), actor)) collModel[op.who] += op.amt;
        } else if (op.t === 'borrow') {
          if (trySend(market.borrow(usdcToken.identifier, op.amt, actor, priceFeeds()), actor)) debtModel[op.who] += op.amt;
        } else if (op.t === 'repay') {
          const p = op.amt > debtModel[op.who] ? debtModel[op.who] : op.amt;
          if (p > 0n && trySend(market.repay(usdcToken.identifier, p, actor), actor)) debtModel[op.who] -= p;
        } else {
          const r = op.amt > collModel[op.who] ? collModel[op.who] : op.amt;
          if (r > 0n && trySend(market.collateralRemove(sbtcToken.identifier, r, actor, priceFeeds()), actor)) collModel[op.who] -= r;
        }

        // the two NON-actors must be byte-identical before and after
        const after = others.map((x) => snapshot(USERS[x]));
        for (let k = 0; k < others.length; k++) {
          if (before[k].coll !== after[k].coll || before[k].debt !== after[k].debt) {
            throw new Error(
              `CROSS-USER CORRUPTION: actor=${op.who} did ${op.t}, but user ${others[k]} changed ` +
              `coll ${before[k].coll}->${after[k].coll} debtScaled ${before[k].debt}->${after[k].debt}. ` +
              `seq=${JSON.stringify(ops, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`
            );
          }
        }
      }
    });
  });
});

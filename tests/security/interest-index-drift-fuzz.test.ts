// INTEREST-INDEX DRIFT / vault-solvency fuzz for Zest V2 (USDC vault).
//
// Zest accrues interest through two indices: the DEBT (borrow) index, which rounds
// UP (borrowers owe at least the true amount), and the LIQUIDITY index, which rounds
// DOWN (suppliers earn at most the true amount). By design debt-interest collected
// >= supplier-interest credited, so the vault stays solvent no matter how long or how
// often it accrues. A drift the WRONG way (liquidity index outrunning what debt
// collects) would let the sum of supplier claims exceed the assets backing them — the
// last withdrawer couldn't be paid.
//
// INVARIANT (canonical ERC4626 solvency, checked after every op and every time-jump):
//     getTotalAssets() + DUST  >=  convertToAssets(getTotalSupply())
// i.e. the assets the vault accounts for always cover redeeming EVERY share. Random
// deposits / borrows / repays / withdrawals are interleaved with multi-year time jumps
// that force many accrual steps, so any per-step rounding drift compounds and surfaces.
import { describe, it, beforeEach } from 'vitest';
import { txOk, rov } from '@clarigen/test';
import { fc } from '@fast-check/vitest';
import {
  deployer, alice, bob, charlie,
  initializeProtocol, executeDaoProposal, contracts, proposalCreateMultipleEgroups,
  proposalSetUsdcInterestRates, proposalSetSbtcInterestRates,
} from '../setup/helpers';
import {
  init_pyth, set_initial_price, PythFeedIds, scalePriceForPyth, priceFeeds,
} from '../setup/helpers/pyth-helpers';

const { market, sbtc: sbtcToken, usdc: usdcToken, vaultUsdc } = contracts;
const DUST = 2n; // allow <=2 base-unit rounding slack in the protocol's favor

type Op =
  | { t: 'supply'; who: 0 | 1; amt: bigint }   // bob/charlie deposit USDC liquidity
  | { t: 'borrow'; amt: bigint }               // alice borrows USDC
  | { t: 'repay'; amt: bigint }                // alice repays
  | { t: 'withdraw'; who: 0 | 1; shares: bigint } // supplier redeems z-shares
  | { t: 'wait'; blocks: number };             // advance time -> accrual

const SUPPLIERS = [bob, charlie] as const;

const supplyAmt = fc.oneof(fc.constant(1n), fc.bigInt({ min: 1n, max: 1000n }), fc.bigInt({ min: 1_000_000n, max: 50_000_000_000n }));
const borrowAmt = fc.oneof(fc.constant(1n), fc.bigInt({ min: 1n, max: 1000n }), fc.bigInt({ min: 1_000_000n, max: 20_000_000_000n }));
const shareAmt = fc.oneof(fc.constant(1n), fc.bigInt({ min: 1n, max: 100n }), fc.bigInt({ min: 1_000_000n, max: 30_000_000_000n }));
const waitBlocks = fc.constantFrom(1, 100, 2_000, 20_000); // consecutive waits compound; 20k blocks ~140 days of accrual

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.tuple(fc.constantFrom(0, 1), supplyAmt).map(([who, amt]) => ({ t: 'supply', who, amt } as Op)),
  borrowAmt.map((amt) => ({ t: 'borrow', amt } as Op)),
  borrowAmt.map((amt) => ({ t: 'repay', amt } as Op)),
  fc.tuple(fc.constantFrom(0, 1), shareAmt).map(([who, shares]) => ({ t: 'withdraw', who, shares } as Op)),
  waitBlocks.map((blocks) => ({ t: 'wait', blocks } as Op)),
);

const SEQUENCES = fc.sample(fc.array(opArb, { minLength: 3, maxLength: 12 }), 60);

const trySend = (call: any, s: string) => { try { txOk(call, s); return true; } catch { return false; } };
const totalAssets = () => rov(vaultUsdc.getTotalAssets()).value as bigint;
const totalSupply = () => rov(vaultUsdc.getTotalSupply()).value as bigint;
const claimOfAllShares = () => rov(vaultUsdc.convertToAssets(totalSupply())).value as bigint;

describe('INTEREST-INDEX DRIFT FUZZ: vault assets must always cover redeeming every share', () => {
  beforeEach(async () => {
    initializeProtocol();
    init_pyth(deployer);
    executeDaoProposal(contracts.proposalSetPriceStaleness);
    executeDaoProposal(proposalCreateMultipleEgroups);
    executeDaoProposal(proposalSetUsdcInterestRates);   // non-zero USDC interest curve
    executeDaoProposal(proposalSetSbtcInterestRates);
    await set_initial_price(PythFeedIds.BTC, scalePriceForPyth(60000, -8), deployer);
    await set_initial_price(PythFeedIds.USDC, scalePriceForPyth(1, -8), deployer);
    // Seed suppliers with USDC; alice with sBTC collateral so she can borrow.
    txOk(usdcToken.mint(1_000_000_000_000n, bob), deployer);
    txOk(usdcToken.mint(1_000_000_000_000n, charlie), deployer);
    txOk(usdcToken.mint(1_000_000_000_000n, alice), deployer); // for repaying interest
    txOk(sbtcToken.mint(500_000_000n, alice), deployer);        // 5 sBTC = $300k collateral
    txOk(market.collateralAdd(sbtcToken.identifier, 500_000_000n, priceFeeds()), alice);
    // a baseline supplier so the vault is non-empty from the start
    txOk(vaultUsdc.deposit(100_000_000_000n, 0n, bob), bob);
  });

  SEQUENCES.forEach((ops, i) => {
    it(`seq #${i} (${ops.length} ops): totalAssets covers convertToAssets(totalSupply) through accrual`, () => {
      const check = (label: string) => {
        const ta = totalAssets();
        const claim = claimOfAllShares();
        if (claim > ta + DUST) {
          throw new Error(
            `VAULT INSOLVENT after ${label}: convertToAssets(totalSupply)=${claim} > totalAssets=${ta} ` +
            `(drift=${claim - ta}). Suppliers can redeem more than the vault holds. ` +
            `seq=${JSON.stringify(ops, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`
          );
        }
      };

      for (const op of ops) {
        if (op.t === 'supply') {
          trySend(vaultUsdc.deposit(op.amt, 0n, SUPPLIERS[op.who]), SUPPLIERS[op.who]);
        } else if (op.t === 'borrow') {
          trySend(market.borrow(usdcToken.identifier, op.amt, alice, priceFeeds()), alice);
        } else if (op.t === 'repay') {
          trySend(market.repay(usdcToken.identifier, op.amt, alice), alice);
        } else if (op.t === 'withdraw') {
          const u = SUPPLIERS[op.who];
          const have = (rov(vaultUsdc.getBalance(u)).value as bigint) ?? 0n;
          const s = op.shares > have ? have : op.shares;
          if (s > 0n) trySend(vaultUsdc.redeem(s, 0n, u), u); // redeem shares -> assets, minOut 0
        } else {
          simnet.mineEmptyBlocks(op.blocks);
          trySend(vaultUsdc.accrue(), deployer); // force an accrual step at the new time
        }
        check(op.t);
      }
    });
  });
});

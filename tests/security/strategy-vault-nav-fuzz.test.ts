// Strategy-vault NAV-CONSISTENCY fuzz for Zest V2 (zvstBTC leverage engine).
//
// open/close-position are trader-gated, but EVERY depositor's deposit/redeem is priced
// off compute-gross-nav. If leverage + StackingDAO yield ever leaves NAV mis-stated, a
// (permissionless) depositor mints or redeems shares at the wrong price and extracts
// value. This fuzz drives the trader's leverage loop and random yield moves, and after
// every step checks the NAV invariants that must hold at ALL states:
//
//   (A) NO FREE SHARES:  convert-to-assets(convert-to-shares(x)) <= x + dust.
//       Minting shares then valuing them back can never exceed what you'd pay in. This
//       is NAV-regime-independent, so yield timing can't make it falsely pass/fail.
//
//   (B) LEVERAGE CREATES NO VALUE:  after an open-position with NO yield change,
//       NAV_after <= NAV_before + dust. Borrowing and redeploying is value-neutral
//       (minus fees); a NAV jump means the loop mis-counts collateral vs debt.
//
//   (C) NAV well-formed: getNetAssets resolves (>= 0) at every state.
import { describe, it, beforeEach } from 'vitest';
import { txOk, rov } from '@clarigen/test';
import { fc } from '@fast-check/vitest';
import {
  deployer, alice,
  initializeProtocol, executeDaoProposal, contracts, proposalCreateMultipleEgroups,
} from '../setup/helpers';
import { setLazerTrustedSigner } from '../setup/helpers/pyth-lazer-helpers';
import { init_pyth, set_initial_price, priceFeeds, PythFeedIds, scalePriceForPyth } from '../setup/helpers/pyth-helpers';

const {
  vaultStbtc, vaultSbtc, stbtcToken, sbtc: sbtcToken, proposalSetMarketV1,
  zvEngineStbtc0: svEngine, zvStateStbtc0: svState, zvOpsStbtc0: svOps, stackingDaoMock: stackingDao,
} = contracts;

const ONE = 100_000_000n;        // 1 stBTC
const UNIT = 1_000_000n;         // probe size for the round-trip share check
const DUST = 3n;

type Op =
  | { t: 'open'; coll: bigint; borrow: bigint }
  | { t: 'ratio'; value: bigint }      // StackingDAO sBTC-per-stBTC ratio (yield up/down)
  | { t: 'deposit'; amt: bigint };

const collAmt = fc.oneof(fc.constant(1n * ONE), fc.bigInt({ min: 1n, max: 5n }).map((n) => n * ONE));
const borrowAmt = fc.oneof(fc.bigInt({ min: 1n, max: 3n }).map((n) => n * ONE), fc.constant(ONE / 2n));
// ratio stays within MIN/MAX bounds the NAV asserts (1.0 .. ~1.6); 1e8 = 1.0
const ratioVal = fc.constantFrom(100_000_000n, 110_000_000n, 125_000_000n, 140_000_000n, 150_000_000n);
const depAmt = fc.oneof(fc.constant(UNIT), fc.bigInt({ min: 1n, max: 3n }).map((n) => n * ONE));

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.tuple(collAmt, borrowAmt).map(([coll, borrow]) => ({ t: 'open', coll, borrow } as Op)),
  ratioVal.map((value) => ({ t: 'ratio', value } as Op)),
  depAmt.map((amt) => ({ t: 'deposit', amt } as Op)),
);

const SEQUENCES = fc.sample(fc.array(opArb, { minLength: 2, maxLength: 10 }), 60);

const nav = (): bigint | null => { try { return rov(svEngine.getNetAssets()).value as bigint; } catch { return null; } };
const cShares = (x: bigint): bigint | null => { try { return rov(svEngine.convertToShares(x)).value as bigint; } catch { return null; } };
const cAssets = (s: bigint): bigint | null => { try { return rov(svEngine.convertToAssets(s)).value as bigint; } catch { return null; } };
const trySend = (call: any, s: string) => { try { txOk(call, s); return true; } catch { return false; } };

describe('STRATEGY-VAULT NAV FUZZ: leverage + yield never let a depositor mis-price shares', () => {
  beforeEach(async () => {
    initializeProtocol();
    executeDaoProposal(proposalCreateMultipleEgroups);
    executeDaoProposal(proposalSetMarketV1);
    init_pyth(deployer);
    setLazerTrustedSigner(deployer);
    await set_initial_price(PythFeedIds.BTC, scalePriceForPyth(60000, -8), deployer);
    txOk(stbtcToken.mint(1000n, deployer), deployer);
    txOk(vaultStbtc.initialize(), deployer);
    txOk(sbtcToken.mint(100_000_000_000n, deployer), deployer);
    txOk(vaultSbtc.deposit(100_000_000_000n, 0n, deployer), deployer); // borrow liquidity
    txOk(stbtcToken.mint(1000n, deployer), deployer);
    txOk(svEngine.initialize(stbtcToken.identifier), deployer);        // dead shares
    // a baseline depositor so supply > 0
    txOk(stbtcToken.mint(10n * ONE, alice), deployer);
    txOk(svEngine.deposit(stbtcToken.identifier, 10n * ONE, 0n), alice);
  });

  SEQUENCES.forEach((ops, i) => {
    it(`seq #${i} (${ops.length} ops): NAV consistent, no free shares, leverage value-neutral`, () => {
      const checkNoFreeShares = (label: string) => {
        const s = cShares(UNIT); if (s === null) return;
        const back = cAssets(s); if (back === null) return;
        if (back > UNIT + DUST) {
          throw new Error(
            `FREE SHARES after ${label}: convertToAssets(convertToShares(${UNIT}))=${back} > ${UNIT}. ` +
            `A depositor mints shares worth more than paid. seq=${JSON.stringify(ops, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`
          );
        }
      };

      for (const op of ops) {
        if (op.t === 'open') {
          const navBefore = nav();
          const ok = trySend(svOps.openPosition(stbtcToken.identifier, sbtcToken.identifier, op.coll, op.borrow, priceFeeds()), deployer);
          if (ok && navBefore !== null) {
            const navAfter = nav();
            // (B) leverage with no yield change must not create NAV. Allow small dust +
            // a relative 0.1% slack for haircut/index rounding in the conservative calc.
            if (navAfter !== null && navAfter > navBefore + DUST + navBefore / 1000n) {
              throw new Error(
                `LEVERAGE CREATED VALUE: NAV ${navBefore} -> ${navAfter} on open (coll=${op.coll} borrow=${op.borrow}). ` +
                `seq=${JSON.stringify(ops, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`
              );
            }
          }
        } else if (op.t === 'ratio') {
          trySend(stackingDao.setRatio(op.value), deployer);
        } else {
          txOk(stbtcToken.mint(op.amt, alice), deployer);
          trySend(svEngine.deposit(stbtcToken.identifier, op.amt, 0n), alice);
        }

        // (C) + (A) after every op
        if (nav() === null) {
          throw new Error(`NAV UNRESOLVABLE after ${op.t}. seq=${JSON.stringify(ops, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`);
        }
        checkNoFreeShares(op.t);
      }
    });
  });
});

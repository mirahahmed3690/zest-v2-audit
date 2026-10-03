// LENDING-VAULT INFLATION / donation-resistance fuzz for Zest V2 (z-token vaults).
//
// The classic ERC4626 first-depositor attack: attacker deposits 1 unit (1 share), then
// DONATES a large amount directly to the vault's token balance to inflate assets-per-
// share; a victim's later deposit rounds down to 0 shares and the attacker redeems the
// victim's funds. Zest claims donation-resistance by accounting assets in an internal
// `assets` var (not the raw token balance). This fuzz attacks that claim on the real
// USDC lending vault.
//
// INVARIANTS (checked across random deposit / redeem / DONATE sequences):
//   (A) DONATION-RESISTANCE: a pure donation (mint tokens straight to the vault) must
//       NOT change the share price convertToAssets(UNIT_SHARES). If it rises, the
//       inflation attack is live.
//   (B) NO FREE SHARES: convertToAssets(convertToShares(x)) <= x + dust at all times.
//   (C) NO ROBBERY: a depositor's shares are always worth >= their deposit minus a tiny
//       rounding dust (a victim is never rounded down to ~0 while their funds stay in).
import { describe, it, beforeEach } from 'vitest';
import { txOk, rov } from '@clarigen/test';
import { fc } from '@fast-check/vitest';
import {
  deployer, alice, bob,
  initializeProtocol, executeDaoProposal, contracts, proposalCreateMultipleEgroups,
} from '../setup/helpers';
import { init_pyth, set_initial_price, PythFeedIds, scalePriceForPyth } from '../setup/helpers/pyth-helpers';

const { usdc: usdcToken, vaultUsdc } = contracts;
const UNIT_SHARES = 1_000_000n; // probe size for share price
const DUST = 3n;

type Op =
  | { t: 'deposit'; who: 0 | 1; amt: bigint }
  | { t: 'redeem'; who: 0 | 1; shares: bigint }
  | { t: 'donate'; amt: bigint }; // mint USDC straight into the vault contract

const USERS = [alice, bob] as const;
const depAmt = fc.oneof(fc.constant(1n), fc.constant(2n), fc.bigInt({ min: 1n, max: 10_000n }), fc.bigInt({ min: 1_000_000n, max: 50_000_000_000n }));
const donAmt = fc.oneof(fc.constant(1n), fc.bigInt({ min: 1n, max: 1000n }), fc.bigInt({ min: 1_000_000_000n, max: 100_000_000_000n }));
const shareAmt = fc.oneof(fc.constant(1n), fc.bigInt({ min: 1n, max: 100n }), fc.bigInt({ min: 1_000_000n, max: 40_000_000_000n }));

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.tuple(fc.constantFrom(0, 1), depAmt).map(([who, amt]) => ({ t: 'deposit', who, amt } as Op)),
  fc.tuple(fc.constantFrom(0, 1), shareAmt).map(([who, shares]) => ({ t: 'redeem', who, shares } as Op)),
  donAmt.map((amt) => ({ t: 'donate', amt } as Op)),
);

const SEQUENCES = fc.sample(fc.array(opArb, { minLength: 2, maxLength: 16 }), 80);

const sharePrice = () => rov(vaultUsdc.convertToAssets(UNIT_SHARES)).value as bigint;
const cShares = (x: bigint) => rov(vaultUsdc.convertToShares(x)).value as bigint;
const cAssets = (s: bigint) => rov(vaultUsdc.convertToAssets(s)).value as bigint;
const vShares = (u: string) => (rov(vaultUsdc.getBalance(u)).value as bigint) ?? 0n;
const trySend = (call: any, s: string) => { try { txOk(call, s); return true; } catch { return false; } };

describe('VAULT INFLATION FUZZ: donations cannot pump share price; no free shares; no robbery', () => {
  beforeEach(async () => {
    initializeProtocol();
    init_pyth(deployer);
    executeDaoProposal(contracts.proposalSetPriceStaleness);
    executeDaoProposal(proposalCreateMultipleEgroups);
    await set_initial_price(PythFeedIds.USDC, scalePriceForPyth(1, -8), deployer);
    txOk(usdcToken.mint(1_000_000_000_000n, alice), deployer);
    txOk(usdcToken.mint(1_000_000_000_000n, bob), deployer);
  });

  SEQUENCES.forEach((ops, i) => {
    it(`seq #${i} (${ops.length} ops): donation-resistant, no free shares, no robbery`, () => {
      const model = [0n, 0n];      // shares our model believes each user holds
      const deposited = [0n, 0n];  // cumulative USDC each user put in
      const redeemed = [0n, 0n];   // cumulative USDC each user got out

      for (const op of ops) {
        if (op.t === 'deposit') {
          const u = USERS[op.who];
          const before = vShares(u);
          if (trySend(vaultUsdc.deposit(op.amt, 0n, u), u)) {
            deposited[op.who] += op.amt;
            model[op.who] += vShares(u) - before;
          }
        } else if (op.t === 'redeem') {
          const u = USERS[op.who];
          const have = vShares(u);
          const s = op.shares > have ? have : op.shares;
          if (s > 0n) {
            const usdcBefore = (rov(usdcToken.getBalance(u)).value as bigint) ?? 0n;
            if (trySend(vaultUsdc.redeem(s, 0n, u), u)) {
              redeemed[op.who] += ((rov(usdcToken.getBalance(u)).value as bigint) ?? 0n) - usdcBefore;
              model[op.who] -= s;
            }
          }
        } else {
          // (A) donation-resistance: price must not move on a pure donation
          const priceBefore = sharePrice();
          txOk(usdcToken.mint(op.amt, vaultUsdc.identifier), deployer); // donate into vault balance
          const priceAfter = sharePrice();
          if (priceAfter > priceBefore + DUST) {
            throw new Error(
              `DONATION PUMPED SHARE PRICE: convertToAssets(${UNIT_SHARES}) ${priceBefore} -> ${priceAfter} ` +
              `after donating ${op.amt}. Inflation attack is live. ` +
              `seq=${JSON.stringify(ops, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`
            );
          }
        }

        // (B) no free shares, at every state
        const s = cShares(UNIT_SHARES);
        const back = cAssets(s);
        if (back > UNIT_SHARES + DUST) {
          throw new Error(
            `FREE SHARES after ${op.t}: convertToAssets(convertToShares(${UNIT_SHARES}))=${back} > ${UNIT_SHARES}. ` +
            `seq=${JSON.stringify(ops, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`
          );
        }
      }

      // (C) no robbery: each user's remaining shares + what they already redeemed must be
      // worth at least what they deposited, minus small rounding dust. (No yield here, so
      // value is conserved; a victim rounded to ~0 shares while funds stayed in would break this.)
      for (let u = 0; u < 2; u++) {
        const remainingValue = model[u] > 0n ? cAssets(model[u]) : 0n;
        const recoverable = redeemed[u] + remainingValue;
        // allow dust per deposit op; cap generously at a few units
        if (deposited[u] > 0n && recoverable + 10n < deposited[u]) {
          throw new Error(
            `DEPOSITOR ROBBED (user ${u}): deposited=${deposited[u]} but recoverable=${recoverable} ` +
            `(redeemed=${redeemed[u]} + remainingShares=${model[u]} worth ${remainingValue}). ` +
            `seq=${JSON.stringify(ops, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`
          );
        }
      }
    });
  });
});

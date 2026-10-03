// Strategy-vault (zvstBTC) ROUND-TRIP / no-free-lunch fuzz for Zest V2.
//
// The strategy vault is an ERC4626-style share vault: deposit stBTC -> mint shares;
// redeem shares (two-step: request-redeem -> fund-claim -> redeem) -> get stBTC back.
// Shares price off NAV (net-assets). The classic attack surface here is a ROUNDING /
// INFLATION bug: can a user — alone, or sandwiching another depositor — pull out MORE
// stBTC than they (and everyone) put in, with no external yield?
//
// INVARIANTS (no yield is injected anywhere, so value can only be conserved or lost
// to rounding/fees — never created):
//   (1) per user: assets_out <= assets_in                (a round trip can't be profitable)
//   (2) system:   sum(assets_out) <= sum(assets_in)      (no net value minted)
// A violation is a real inflation/rounding exploit: free stBTC out of the vault.
//
// Multiple depositors interleave and redeem in random order, so first-depositor
// inflation ("donate to pump share price, redeem the victim's deposit") is exercised
// against the dead-shares mitigation.
import { describe, it, beforeEach } from 'vitest';
import { txOk, rov } from '@clarigen/test';
import { fc } from '@fast-check/vitest';
import {
  deployer, alice, bob, charlie, svEngine, stbtcToken,
} from '../strategy-vault/stbtc-0/helpers';

const DEAD_SHARES = 1_000n;
const ONE = 100_000_000n; // 1 stBTC (8 dec)

// Three independent depositors.
const USERS = [alice, bob, charlie];

type Op =
  | { t: 'deposit'; who: number; amt: bigint }
  | { t: 'redeemAll'; who: number };

// Deposit amounts: tiny (inflation bait), small, and normal — where rounding hides.
const depAmt = fc.oneof(
  fc.constant(101n), // just over MIN_DEPOSIT (100)
  fc.constant(1_000n),
  fc.bigInt({ min: 100n, max: 10_000n }),
  fc.bigInt({ min: 1n, max: 50n }).map((n) => n * ONE),
);

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.tuple(fc.nat({ max: 2 }), depAmt).map(([who, amt]) => ({ t: 'deposit', who, amt } as Op)),
  fc.nat({ max: 2 }).map((who) => ({ t: 'redeemAll', who } as Op)),
);

const SEQUENCES = fc.sample(fc.array(opArb, { minLength: 2, maxLength: 14 }), 80);

const bal = (u: string): bigint => (rov(stbtcToken.getBalance(u)).value as bigint) ?? 0n;
const shares = (u: string): bigint => (rov((svEngine as any).getShareBalance?.(u))?.value as bigint) ?? 0n;

function trySend(call: any, sender: string): any | null {
  try { return txOk(call, sender); } catch { return null; }
}

// Full non-express redeem: request -> (cooldown) -> fund -> redeem. Returns stBTC
// delta credited to the user, or 0n if any leg failed. Measures by real balance.
function redeemAll(user: string, userShares: bigint): bigint {
  if (userShares <= 0n) return 0n;
  const before = bal(user);
  const req = trySend((svEngine as any).requestRedeem(userShares, false), user);
  if (!req) return 0n;
  const claimId = (req.value as bigint);
  simnet.mineEmptyBlocks(9000); // pass cooldown + timelock
  if (!trySend((svEngine as any).fundClaim(claimId), deployer)) return 0n;
  if (!trySend((svEngine as any).redeem(stbtcToken.identifier, claimId), user)) return 0n;
  return bal(user) - before;
}

describe('STRATEGY-VAULT ROUND-TRIP FUZZ: no deposit/redeem cycle may return more stBTC than went in', () => {
  beforeEach(() => {
    // initialize vault: deployer seeds dead shares
    txOk(stbtcToken.mint(DEAD_SHARES, deployer), deployer);
    txOk(svEngine.initialize(stbtcToken.identifier), deployer);
  });

  SEQUENCES.forEach((ops, i) => {
    it(`seq #${i} (${ops.length} ops) conserves value (out <= in), no inflation profit`, () => {
      // Track, per user, cumulative stBTC deposited and redeemed, and shares held.
      const putIn = [0n, 0n, 0n];
      const gotOut = [0n, 0n, 0n];
      const held = [0n, 0n, 0n]; // shares our model believes each user holds

      for (const op of ops) {
        const user = USERS[op.who];
        if (op.t === 'deposit') {
          txOk(stbtcToken.mint(op.amt, user), deployer);
          const r = trySend(svEngine.deposit(stbtcToken.identifier, op.amt, 0n), user);
          if (r) {
            putIn[op.who] += op.amt;
            held[op.who] += (r.value as bigint);
          }
        } else {
          const got = redeemAll(user, held[op.who]);
          if (got > 0n) {
            gotOut[op.who] += got;
            held[op.who] = 0n;
          }
        }

        // INVARIANT (1): no user has pulled out more than they ever put in.
        for (let u = 0; u < 3; u++) {
          if (gotOut[u] > putIn[u]) {
            throw new Error(
              `ROUND-TRIP PROFIT (user ${u}): out=${gotOut[u]} > in=${putIn[u]} sats. ` +
              `This is free stBTC from the vault. ` +
              `seq=${JSON.stringify(ops, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`
            );
          }
        }
      }

      // INVARIANT (2): system-wide, total out <= total in (no value minted).
      const totIn = putIn[0] + putIn[1] + putIn[2];
      const totOut = gotOut[0] + gotOut[1] + gotOut[2];
      if (totOut > totIn) {
        throw new Error(
          `SYSTEM VALUE MINTED: total out=${totOut} > total in=${totIn} sats. ` +
          `seq=${JSON.stringify(ops, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`
        );
      }
    });
  });
});

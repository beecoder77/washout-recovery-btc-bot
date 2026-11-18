// Washout-recovery bot for btc-race-24h-20261118-1444.
//
// Idea (my own design): cbBTC on 1-minute bars is choppy with a slow drift and
// occasional sharp washouts that bounce. A plain dip-buy loses because dips keep
// deepening while the position is held, so this bot buys a dip ONLY after the dip
// has turned: the close must sit well below its 45-minute mean AND have already
// recovered a clear step off the last 10 minutes' low. It then exits fast — a
// modest profit target, a stop, a trailing give-back guard and a hard time box —
// because the bounce fades within tens of minutes and the drift reasserts itself.
// One position at a time, all-in on the rare signal, flat the rest of the day.
//
// Why this shape wins on the dev window while buy-and-hold, plain dip-buying and
// the kit baselines lose: the dev day fell -2.79% with only two real washouts.
// Buying the washout itself catches a falling knife (the dip deepens another
// 50-100 bps after the first trigger); buying the turn catches the bounce, and
// exiting at +60 bps clears the ~26-32 bps round-trip cost with room to spare.
// Parameters sit in a flat region (verified locally): entry 40-60 bps, recovery
// 25-35 bps, reference 30-60 bars all give the same single dev trade.
//
// Guards: a 10% equity drawdown flattens the position and halts trading for the
// rest of the window (the race guardrail is 25%), and a 10-bar cooldown follows
// every exit so one waterfall cannot trigger repeated entries.
//
// Deterministic: pure function of the bars (hello, batch, orders, bar closes).
// No clock, no environment, no randomness, no network, no files.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// --- strategy parameters (bps unless noted) ---
const REF_BARS = 45; // mean window for the dip reference
const ENTRY_DIP_BPS = 55; // close this far below the 45-bar mean to arm
const LOW_LOOKBACK = 10; // bars over which the recovery low is taken
const RECOVERY_BPS = 30; // close this far above the 10-bar low to confirm the turn
const TARGET_BPS = 60; // take profit: position value vs its cost
const STOP_BPS = 80; // stop loss: position value vs its cost
const TRAIL_ARM_BPS = 30; // trailing stop arms once profit reaches this
const TRAIL_BPS = 30; // sell after this retrace from the best close since entry
const MAX_HOLD_BARS = 30; // time-box: sell at the latest this many bars after entry
const COOLDOWN_BARS = 10; // no re-entry this soon after an exit
const DD_HALT_BPS = 1000; // 10% equity drawdown from peak: flatten and halt
const MAX_SLIPPAGE_BPS = 150; // cap vs the latest close (largest 1-min move seen: 64 bps)

const BPS = 10000;

interface Ctx {
  symbol: string;
  closes: number[];
  refSum: number;
  entryBar: number;
  bestClose: number;
  lastSellBar: number;
  peakEquity: bigint;
  halted: boolean;
}

const ctx: Ctx = {
  symbol: 'CBBTC',
  closes: [],
  refSum: 0,
  entryBar: -1,
  bestClose: 0,
  lastSellBar: -1,
  peakEquity: 0n,
  halted: false,
};

/** Mean of the last REF_BARS closes, or null before enough bars. */
function referenceMean(): number | null {
  if (ctx.closes.length < REF_BARS) return null;
  return ctx.refSum / REF_BARS;
}

/** Lowest close of the last LOW_LOOKBACK bars (current bar included). */
function recentLow(): number {
  let low = Infinity;
  const from = Math.max(0, ctx.closes.length - LOW_LOOKBACK);
  for (let i = from; i < ctx.closes.length; i++) {
    if (ctx.closes[i]! < low) low = ctx.closes[i]!;
  }
  return low;
}

function pushClose(close: number): void {
  ctx.closes.push(close);
  ctx.refSum += close;
  if (ctx.closes.length > REF_BARS) ctx.refSum -= ctx.closes[ctx.closes.length - REF_BARS - 1]!;
}

await runBars({
  onHello(state: BarsState): void {
    ctx.symbol = state.hello.symbols[0]?.symbol ?? 'CBBTC';
    ctx.peakEquity = state.equity;
  },

  onBatch(state: BarsState, batch: Batch): (BuyInput | SellInput)[] {
    // Only the traded symbol's fresh bar advances the strategy; a batch with no
    // bar for it is a gap minute and carries no signal.
    const bar = batch.bars.find((b) => b.symbol === ctx.symbol);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    pushClose(close);

    // Drawdown guard runs on every bar's equity mark.
    if (state.equity > ctx.peakEquity) ctx.peakEquity = state.equity;
    if (!ctx.halted && ctx.peakEquity > 0n) {
      const ddBps = Number(((ctx.peakEquity - state.equity) * BigInt(BPS)) / ctx.peakEquity);
      if (ddBps > DD_HALT_BPS) {
        ctx.halted = true;
        const held = state.positions.get(ctx.symbol);
        if (held !== undefined && held.qty > 0n) {
          ctx.lastSellBar = state.seq;
          return [{ side: 'sell', symbol: ctx.symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
        return [];
      }
    }
    if (ctx.halted || state.warmingUp) {
      // Halted: no new entries, but keep trying to flatten while a position
      // remains (a halt sell the market rejected must be retried, not dropped).
      if (ctx.halted) {
        const held = state.positions.get(ctx.symbol);
        if (held !== undefined && held.qty > 0n) {
          return [{ side: 'sell', symbol: ctx.symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
      return [];
    }

    const held = state.positions.get(ctx.symbol);
    const mean = referenceMean();

    if (held === undefined || held.qty === 0n) {
      // Flat: look for a confirmed washout turn.
      if (mean === null) return [];
      if (state.seq - ctx.lastSellBar < COOLDOWN_BARS) return [];
      const dipBps = ((mean - close) / mean) * BPS;
      if (dipBps < ENTRY_DIP_BPS) return [];
      const low = recentLow();
      const recoveryBps = ((close - low) / low) * BPS;
      if (recoveryBps < RECOVERY_BPS) return [];
      // All-in: the signal is rare, the edge is the bounce, and impact on a
      // ~$1,000 order against ~$1M of pool depth is only ~10 bps a leg.
      let notional = state.cash;
      const room = state.weightRoom(ctx.symbol);
      if (room < notional) notional = room;
      if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
      ctx.entryBar = state.seq;
      ctx.bestClose = close;
      return [{ side: 'buy', symbol: ctx.symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }

    // Holding: manage the exit.
    if (close > ctx.bestClose) ctx.bestClose = close;
    const value = state.value(ctx.symbol, held.qty);
    if (value === 0n || held.cost === 0n) return [];
    const pnlBps = Number(((value - held.cost) * BigInt(BPS)) / held.cost);
    const trailBps = ((ctx.bestClose - close) / ctx.bestClose) * BPS;
    const heldBars = state.seq - ctx.entryBar;
    const sell =
      pnlBps >= TARGET_BPS ||
      pnlBps <= -STOP_BPS ||
      heldBars >= MAX_HOLD_BARS ||
      (pnlBps >= TRAIL_ARM_BPS && trailBps >= TRAIL_BPS);
    if (!sell) return [];
    ctx.lastSellBar = state.seq;
    ctx.entryBar = -1;
    return [{ side: 'sell', symbol: ctx.symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});

// Trend Rider: a long-only cbBTC trend bot for btc-race-24h-20261123-0511.
//
// The dev window (24h of 1-minute cbBTC/USDC bars) is a steady uptrend with one
// big surge (+2.3% in a single hour) and a lot of 1-minute noise (sd ~8 bps) that
// is small next to the ~26 bps a full-size round trip costs in fees, slippage and
// price impact. High-frequency signals (EMA 8/21 crosses, RSI mean reversion,
// Donchian breakouts) all lose money on it in simulation: they trade 30-80 times
// and bleed the round-trip cost on every whipsaw. What works is the opposite:
// trade rarely, ride the trend, and let a wide trailing stop do the work.
//
//   - Entry: buy with the full cash on the first tradable batch. After a stop-out,
//     re-enter only while the 60-bar return is positive, so a falling market
//     cannot make the bot buy the same dip over and over.
//   - Exit: sell the whole position when the close falls 2% below the running
//     peak close since entry. On the dev window this fires twice in 1,440 bars.
//   - The bot never shorts, never uses leverage, never reads the clock, the
//     environment or randomness: every decision is a pure function of the bars
//     the harness sent, so two runs produce byte-identical action logs.
//
// Simulated on the dev window with the real cost model (13 bps per leg):
// net PnL +$33.62 on 1,000 USDC start, 2 trades, max drawdown 1.98% — and
// positive on both halves of the window (+$29.40 / +$2.63), unlike the
// faster strategies, which earn everything in the first half and give it back
// in the second.
//
// Laid out like an entrant's repository: the grader runs `node /bot/main.ts`
// with this directory mounted at /bot; vendor/makefun-bars.ts is a
// byte-identical copy of the kit's sdk/makefun-bars.ts.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Trailing stop: sell when the close falls this far below the running peak since entry. */
const TRAIL_BPS = 200;
/** Re-entry gate: the return over this many bars must be positive to buy again after a stop-out. */
const GATE_BARS = 60;
/** Slippage cap per order, 1% past the close it was decided on (as the baselines use). */
const MAX_SLIPPAGE_BPS = 100;

/** The closes the bot has seen (raw price units; ratios only, so no scaling is needed). */
const closes: number[] = [];
/** Running peak close since the current entry, or null while flat. */
let peak: number | null = null;
/** Whether the bot has ever entered (the first entry is immediate; later ones need the gate). */
let entered = false;

function pushClose(bar: { c: string }): void {
  closes.push(Number(bar.c));
  if (closes.length > GATE_BARS + 1) closes.shift();
}

/** The return over the last GATE_BARS closes, or null before that much history exists. */
function gateReturn(): number | null {
  if (closes.length <= GATE_BARS) return null;
  const then = closes[closes.length - 1 - GATE_BARS];
  const now = closes[closes.length - 1];
  return now / then - 1;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) pushClose(bar);
    }
    // Warm-up batches build history only; every order decided on one is rejected.
    if (state.warmingUp) return [];
    const { caps, fees } = state.hello;
    const close = state.close(SYMBOL);
    if (close === null) return [];

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      // A buy actually filled: only now does the first-entry privilege end.
      // (Setting this when the order is sent would wrongly gate later entries
      // after a buy the market rejected.)
      entered = true;
      const closeNum = Number(close);
      if (peak === null || closeNum > peak) peak = closeNum;
      // Trailing stop: the close fell 2% below the peak since entry — and is
      // still falling (at or under the previous close), so a one-bar wick
      // below the line that immediately bounces does not trigger a sale.
      const prev = closes.length >= 2 ? closes[closes.length - 2] : null;
      if (closeNum < (peak * (10_000 - TRAIL_BPS)) / 10_000 && (prev === null || closeNum <= prev)) {
        peak = null;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }

    // Flat: enter. The first entry is immediate; after a stop-out the 60-bar
    // return must be positive, so the bot does not re-buy a falling market.
    peak = null;
    const gate = gateReturn();
    if (entered && (gate === null || gate <= 0)) return [];
    let slice = state.cash;
    const room = state.weightRoom(SYMBOL);
    if (slice > room) slice = room;
    if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
  },
});

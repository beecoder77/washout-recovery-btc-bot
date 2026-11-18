# Washout-Recovery BTC Bot

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/beecoder77/washout-recovery-btc-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/beecoder77/washout-recovery-btc-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)

A bot for the make.fun competition **btc-race-24h-20261118-1444** ("Race a BTC
trading bot live for 24 hours"). It trades cbBTC/USDC on 1-minute bars, long
only, starting from $1,000 paper USDC, speaking `agent-fun/bars-replay/v1`.

## Strategy

cbBTC's 1-minute bars are choppy with a slow drift and occasional sharp
washouts that bounce. Buying the washout itself loses — the dip keeps deepening
another 50–100 bps after the first trigger — so this bot buys only after the
dip has **turned**:

- **Entry:** the close sits ≥ 55 bps below its 45-bar mean **and** has already
  recovered ≥ 30 bps off the last 10 bars' low. One position at a time, all-in
  (the signal is rare; impact on a ~$1,000 order against ~$1M pool depth is
  only ~10 bps a leg).
- **Exit (first trigger wins):** +60 bps profit target, −80 bps stop,
  30-bar time box, or a 30 bps trailing give-back once +30 bps in profit.
- **Guards:** a 10% equity drawdown flattens the position and halts trading
  for the rest of the window (race guardrail is 25%); a 10-bar cooldown
  follows every exit so one waterfall cannot trigger repeated entries.

Parameters sit in a flat region verified on the dev window (entry 40–60 bps,
recovery 25–35 bps, reference 30–60 bars all give the same trade), not a sharp
peak — the bot is built to survive a different, unseen race window, not to
overfit the dev one.

## Dev-window result (local grade)

- Net PnL: **+$5.80 USDC** on the frozen dev window (1,440 bars)
- Trades: 1 round trip (2 orders); max drawdown 0.21%
- Buy-and-hold on the same window loses −2.79%; hold-cash is $0 — both fail
  the dev gate. All six kit baselines lose money on this window.

## Layout

- `main.ts` — the bot (Node 22, erasable TypeScript, run as `node main.ts`)
- `vendor/makefun-bars.ts` — byte-for-byte copy of the kit's protocol SDK
- `LICENSE` — MIT

## Grade locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

Deterministic: a pure function of the bars — no clock, no environment, no
randomness, no network, no files.

# tradebot — free paper-trading bot (fake money only)

Never places real orders. No API keys. Data: Binance public prices. Runs on CPU, no GPU needed.

## Setup
```bash
pip install -r requirements.txt
python -m pytest -q                      # 7 tests should pass
```

## Use (do these in order)
```bash
# 1. Test the strategy on 2 years of real past prices. Last 30% is the honest test.
python -m tradebot backtest --symbols BTCUSDT ETHUSDT SOLUSDT --interval 4h --days 730

# 2. Run it live with fake $10,000 (checks every 60s, trades when a 4h candle closes)
python -m tradebot paper

# 3. Look at the account anytime
python -m tradebot status

# Copy-trading (Hyperliquid public wallets)
python -m tradebot copy-scan             # see which wallets pass the filter + what they hold
python -m tradebot copy-paper            # paper-copy what most of them are long
```
Offline code test (fake prices, results mean nothing): `python -m tradebot backtest --synthetic`

## Strategy (tradebot/strategy.py)
Long only. Buy when EMA20 crosses above EMA50 and price is above EMA200 and RSI < 75.
Sell when EMA20 drops below EMA50 or a trailing stop (3x ATR) is hit.
Risk: 1% of account per trade, max 33% of account per coin. Costs: 0.1% fee + 0.05% slippage per side.
Signals use the closed candle; fills happen at the next candle open (no peeking at the future).

## AI helpers (free, local, like "Grok Bot" but no subscription)
Needs Ollama (https://ollama.com): `ollama pull qwen2.5:7b-instruct` (Q4, about 5GB VRAM; model unloads right after each answer so your voice models get the VRAM back).
```bash
python -m tradebot brief     # morning brief: prices + free RSS news -> risk low/medium/high
python -m tradebot deals     # weekly: pullback setups on a 10-coin watchlist
python -m tradebot risk      # exposure, open risk, 24h loss of your fake account
python -m tradebot chat      # ask "why did you buy?" - answers only from your real trade log
```
Safety design: the AI can write and advise. It cannot place trades or size them up. Its only power over trading is a veto:
if the brief says risk is HIGH (or the risk check fails), `paper` skips new buys. Exits always run.
Run `brief` every morning with Windows Task Scheduler or cron, e.g. `30 7 * * * cd ~/Maaan && python -m tradebot brief`.
The veto cannot be backtested (there is no history of past briefs), so judge it only by paper trading.

## Edit the settings visually
Open Tradebot Lab (https://claude.ai/artifact/LfKUFa63HdVnBymoan4kuA), move the sliders, press **Copy settings**,
save the text as `settings.json` in the repo folder. `backtest`, `paper` and `copy-paper` read it automatically.
Delete the file to go back to the defaults.

## Rule before any real money
Paper-trade for at least 4–8 weeks AND the out-of-sample backtest must beat buy-and-hold on drawdown or return.
If it can't, do not go live. The bot has no live-trading code on purpose.

# Maaan Trading Bot — dashboard

One file: `index.html`. No install, no build, no server.

**Open it:** double-click `trading-bot/index.html`, or (if GitHub Pages is on) `https://<user>.github.io/Maaan/trading-bot/`.

## What it is
- A **paper-trading** dashboard (fake money). Live trading is locked on purpose.
- Prices: **Simulated** (offline) or **Binance public** (real prices, no API key).
- Decision maker: built-in SMA + RSI, **Grok decides**, or built-in signal that **Grok must confirm**.
- Risk guard is plain code (not AI): risk per trade, max position size, max open trades, SL/TP, cooldown,
  daily-loss stop, drawdown stop, fees, slippage, kill switch.

## Connect Grok (Grok tab)
Any OpenAI-style `/chat/completions` endpoint works.

| Provider | URL | Model |
|---|---|---|
| xAI Grok | `https://api.x.ai/v1/chat/completions` | set to the model your bot uses |
| Local Ollama | `http://localhost:11434/v1/chat/completions` | e.g. `llama3.1:8b` (needs `OLLAMA_ORIGINS=*`) |

Grok must answer with JSON: `{"action":"buy|sell|hold","confidence":0-1,"reason":"...","stop_loss_pct":n,"take_profit_pct":n}`.
Its answer is clamped and still passes through the risk guard.

The API key stays in memory unless you tick "Remember key" (then it is saved as plain text in your browser).
If the browser blocks the call (CORS), put a small local proxy in front of your Grok bot and use its URL.

State (account, trades, settings) is saved in your browser's localStorage.

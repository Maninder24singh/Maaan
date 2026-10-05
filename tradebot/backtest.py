import numpy as np
import pandas as pd

from .engine import Engine, Risk
from .portfolio import Portfolio
from .strategy import Params, prepare

BARS_PER_YEAR = {"15m": 35040, "1h": 8760, "4h": 2190, "1d": 365}


def run(frames: dict, params=Params(), risk=Risk(), cash=10_000.0, fee=0.001, slip=0.0005):
    """frames: {symbol: raw OHLCV df}. Signals come from candle j-1, fills happen at candle j open."""
    prep = {s: prepare(df, params) for s, df in frames.items()}
    idx = sorted(set.intersection(*[set(d.index) for d in prep.values()]))
    pf = Portfolio(cash=cash, fee=fee, slip=slip)
    eng = Engine(pf, params, risk)
    curve = []
    for j in range(1, len(idx)):
        ts, prev = idx[j], idx[j - 1]
        for s, d in prep.items():
            eng.on_open(s, ts, d.at[ts, "open"], d.loc[prev])
        for s, d in prep.items():
            eng.check_stop(s, ts, d.at[ts, "open"], d.at[ts, "low"])
            eng.on_close(s, d.at[ts, "close"], d.at[ts, "atr"])
        curve.append((ts, pf.equity(eng.last_price)))
    for s in list(pf.positions):  # close leftovers so every trade is counted
        pf.sell(s, eng.last_price[s], idx[-1], "end")
    eq = pd.Series(dict(curve))
    bh = np.mean([d.at[idx[-1], "close"] / d.at[idx[0], "close"] - 1 for d in prep.values()])
    return pf, eq, bh


def metrics(pf: Portfolio, eq: pd.Series, bh: float, interval: str, start_cash: float) -> dict:
    t = pd.DataFrame(pf.trades)
    r = eq.pct_change().dropna()
    wins, losses = (t[t.pnl > 0].pnl.sum(), -t[t.pnl <= 0].pnl.sum()) if len(t) else (0, 0)
    return {
        "return_%": round((eq.iloc[-1] / start_cash - 1) * 100, 2),
        "buy_and_hold_%": round(bh * 100, 2),
        "max_drawdown_%": round(((eq / eq.cummax()) - 1).min() * 100, 2),
        "sharpe": round(r.mean() / r.std() * np.sqrt(BARS_PER_YEAR.get(interval, 365)), 2) if r.std() > 0 else 0.0,
        "trades": len(t),
        "win_rate_%": round((t.pnl > 0).mean() * 100, 1) if len(t) else 0.0,
        "profit_factor": round(wins / losses, 2) if losses > 0 else float("inf") if wins > 0 else 0.0,
        "fees_paid_$": round(float((t.qty * t.entry).sum() * pf.fee * 2), 2) if len(t) else 0.0,
    }

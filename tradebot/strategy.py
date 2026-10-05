"""Trend following, long only.

Enter : EMA(fast) crosses above EMA(slow), price is above EMA(trend), RSI not overheated.
Exit  : EMA(fast) falls below EMA(slow), or the ATR trailing stop is hit.
Every column uses only past data, so row i is known at the close of candle i.
"""
from dataclasses import dataclass

import pandas as pd

from .indicators import atr, ema, rsi


@dataclass(frozen=True)
class Params:
    fast: int = 20
    slow: int = 50
    trend: int = 200
    rsi_max: float = 75.0
    atr_n: int = 14
    stop_atr: float = 2.0   # first stop distance, in ATRs
    trail_atr: float = 3.0  # trailing stop distance, in ATRs


def prepare(df: pd.DataFrame, p: Params = Params()) -> pd.DataFrame:
    out = df.copy()
    c = out["close"]
    out["ema_f"], out["ema_s"], out["ema_t"] = ema(c, p.fast), ema(c, p.slow), ema(c, p.trend)
    out["rsi"], out["atr"] = rsi(c), atr(out, p.atr_n)
    cross_up = (out["ema_f"] > out["ema_s"]) & (out["ema_f"].shift(1) <= out["ema_s"].shift(1))
    warm = pd.Series(range(len(out)), index=out.index) >= p.trend
    out["entry"] = cross_up & (c > out["ema_t"]) & (out["rsi"] < p.rsi_max) & warm
    out["exit"] = (out["ema_f"] < out["ema_s"]) & warm
    return out

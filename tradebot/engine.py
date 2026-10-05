"""Order logic shared by the backtest and the live paper loop, so both behave the same.

Per candle j the order is:  on_open (act on signal from candle j-1) -> check_stop (candle j low) -> on_close (trail stop).
Live mode runs the same three steps, just shifted by half a candle.
"""
from dataclasses import dataclass

from .portfolio import Portfolio
from .strategy import Params


@dataclass(frozen=True)
class Risk:
    risk_per_trade: float = 0.01      # lose at most 1% of equity if the first stop is hit
    max_alloc_per_symbol: float = 0.33


class Engine:
    def __init__(self, pf: Portfolio, params: Params = Params(), risk: Risk = Risk()):
        self.pf, self.p, self.risk = pf, params, risk
        self.last_price: dict = {}

    def on_open(self, sym, ts, price, sig):
        """sig = last closed candle row (needs entry, exit, atr)."""
        self.last_price[sym] = price
        if sym in self.pf.positions:
            if sig["exit"]:
                self.pf.sell(sym, price, ts, "signal")
            return
        if not sig["entry"] or not sig["atr"] > 0:
            return
        stop = price - self.p.stop_atr * sig["atr"]
        if stop <= 0:
            return
        eq = self.pf.equity(self.last_price)
        qty = min(eq * self.risk.risk_per_trade / (price - stop), eq * self.risk.max_alloc_per_symbol / price)
        self.pf.buy(sym, price, qty, ts, stop)

    def check_stop(self, sym, ts, bar_open, bar_low):
        pos = self.pf.positions.get(sym)
        if pos and bar_low <= pos.stop:
            self.pf.sell(sym, min(bar_open, pos.stop), ts, "stop")  # gap below stop fills at the open

    def on_close(self, sym, close, atr_now):
        self.last_price[sym] = close
        pos = self.pf.positions.get(sym)
        if pos and atr_now > 0:
            pos.stop = max(pos.stop, close - self.p.trail_atr * atr_now)

"""Fake-money account. Charges fees and slippage so results are not fantasy."""
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass
class Position:
    symbol: str
    qty: float
    entry_price: float
    entry_cost: float   # cash paid including fee
    stop: float
    entry_ts: str


@dataclass
class Portfolio:
    cash: float = 10_000.0
    fee: float = 0.001      # 0.1% per side (Binance spot default)
    slip: float = 0.0005    # 0.05% worse price on every fill
    positions: dict = field(default_factory=dict)
    trades: list = field(default_factory=list)

    def equity(self, prices: dict) -> float:
        return self.cash + sum(p.qty * prices.get(s, p.entry_price) for s, p in self.positions.items())

    def buy(self, symbol, price, qty, ts, stop):
        if symbol in self.positions or qty <= 0:
            return None
        fill = price * (1 + self.slip)
        qty = min(qty, self.cash / (fill * (1 + self.fee)))
        if qty <= 0:
            return None
        cost = fill * qty * (1 + self.fee)
        self.cash -= cost
        self.positions[symbol] = Position(symbol, qty, fill, cost, stop, str(ts))
        return self.positions[symbol]

    def sell(self, symbol, price, ts, reason):
        pos = self.positions.pop(symbol, None)
        if pos is None:
            return None
        fill = price * (1 - self.slip)
        proceeds = fill * pos.qty * (1 - self.fee)
        self.cash += proceeds
        t = dict(symbol=symbol, entry_ts=pos.entry_ts, exit_ts=str(ts), entry=pos.entry_price, exit=fill,
                 qty=pos.qty, pnl=proceeds - pos.entry_cost, ret=proceeds / pos.entry_cost - 1, reason=reason)
        self.trades.append(t)
        return t

    def to_dict(self):
        d = asdict(self)
        return d

    @classmethod
    def from_dict(cls, d):
        pf = cls(cash=d["cash"], fee=d["fee"], slip=d["slip"], trades=d["trades"])
        pf.positions = {s: Position(**p) for s, p in d["positions"].items()}
        return pf

    def save(self, path, extra=None):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(json.dumps({"portfolio": self.to_dict(), **(extra or {})}, indent=1))

    @classmethod
    def load(cls, path):
        raw = json.loads(Path(path).read_text())
        return cls.from_dict(raw["portfolio"]), raw

import argparse
import json
import time
from pathlib import Path

import pandas as pd

from . import backtest as bt
from . import copytrade, data, settings
from .engine import Engine, Risk
from .portfolio import Portfolio
from .strategy import Params, prepare

STATE = Path("state/paper.json")
COPY_STATE = Path("state/copy.json")
DEFAULT = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]


def cmd_backtest(a):
    if a.synthetic:
        frames = {s: data.synthetic(seed=i, interval=a.interval) for i, s in enumerate(a.symbols)}
        print("!! SYNTHETIC fake prices: this only tests the code. Results mean nothing about real markets.")
    else:
        frames = {s: data.fetch_history(s, a.interval, a.days, a.refresh) for s in a.symbols}
    cfg = settings.load()
    cash = a.cash or cfg["cash"]
    n = min(len(f) for f in frames.values())
    cut = int(n * (1 - a.oos))
    parts = {"IN-SAMPLE (tune here)": {s: f.iloc[:cut] for s, f in frames.items()}}
    if a.oos > 0:
        parts["OUT-OF-SAMPLE (never tuned on - the one that matters)"] = {s: f.iloc[cut - 250:] for s, f in frames.items()}
    for name, fr in parts.items():
        pf, eq, hold = bt.run(fr, cfg["params"], cfg["risk"], cash, cfg["fee"], cfg["slip"])
        print(f"\n== {name}: {eq.index[0]:%Y-%m-%d} -> {eq.index[-1]:%Y-%m-%d}")
        for k, v in bt.metrics(pf, eq, hold, a.interval, cash).items():
            print(f"  {k:16} {v}")


def _load_paper(cfg, cash):
    if STATE.exists():
        pf, raw = Portfolio.load(STATE)
        return pf, raw.get("last_ts", {})
    return Portfolio(cash=cash or cfg["cash"], fee=cfg["fee"], slip=cfg["slip"]), {}


def paper_step(pf, last_ts, symbols, interval, p=Params(), risk=Risk()):
    eng = Engine(pf, p, risk)
    feeds = {}
    for s in symbols:
        closed, now_px = data.fetch_recent(s, interval)
        feeds[s] = (prepare(closed, p), now_px)
        eng.last_price[s] = now_px
    for s, (d, now_px) in feeds.items():
        seen = pd.Timestamp(last_ts[s]) if s in last_ts else d.index[-1]  # first run: don't trade on old candles
        new = d[d.index > seen]
        for ts, row in new.iterrows():
            eng.check_stop(s, ts, row["open"], row["low"])
            eng.on_close(s, row["close"], row["atr"])
        eng.last_price[s] = now_px
        if len(new):
            eng.on_open(s, pd.Timestamp.now(tz="UTC"), now_px, d.iloc[-1])
        last_ts[s] = str(d.index[-1])
    return eng.last_price


def cmd_paper(a):
    cfg = settings.load()
    pf, last_ts = _load_paper(cfg, a.cash)
    while True:
        try:
            px = paper_step(pf, last_ts, a.symbols, a.interval, cfg["params"], cfg["risk"])
            pf.save(STATE, {"last_ts": last_ts})
            print(f"{pd.Timestamp.now(tz='UTC'):%F %T} equity ${pf.equity(px):,.2f} cash ${pf.cash:,.2f} open={list(pf.positions)} trades={len(pf.trades)}")
        except Exception as e:  # network hiccup must not kill the loop
            print("step failed:", e)
        if a.once:
            break
        time.sleep(a.poll)


def cmd_status(a):
    for f in (STATE, COPY_STATE):
        if f.exists():
            pf, _ = Portfolio.load(f)
            print(f"\n[{f.name}] cash ${pf.cash:,.2f}  trades {len(pf.trades)}  total pnl ${sum(t['pnl'] for t in pf.trades):,.2f}")
            for s, p in pf.positions.items():
                print(f"  OPEN {s} qty={p.qty:.6f} entry={p.entry_price:.2f} stop={p.stop:.2f}")
            for t in pf.trades[-5:]:
                print(f"  CLOSED {t['symbol']} {t['ret'] * 100:+.2f}% ({t['reason']}) {t['exit_ts'][:16]}")


def cmd_copy_scan(a):
    ws = copytrade.pick_wallets(top=a.top)
    print(f"{len(ws)} wallets passed the filter")
    for w in ws:
        print(f"  {w['addr']}  account ${w['account']:,.0f}  month ROI {w['month_roi'] * 100:+.0f}%")
    for coin, c in sorted(copytrade.consensus(ws).items(), key=lambda kv: -(kv[1]['longs'] + kv[1]['shorts']))[:15]:
        print(f"  {coin:8} longs={c['longs']:2} shorts={c['shorts']:2} -> {c['signal']}")


def cmd_copy_paper(a):
    pf = Portfolio.load(COPY_STATE)[0] if COPY_STATE.exists() else Portfolio(cash=a.cash or settings.load()["cash"])
    while True:
        try:
            cons = copytrade.consensus(copytrade.pick_wallets(top=a.top))
            px = copytrade.mids()
            for coin in list(pf.positions):  # exit when the crowd leaves, or hard stop (we see trades late)
                pos = pf.positions[coin]
                if cons.get(coin, {}).get("signal") != "long" or px[coin] <= pos.stop:
                    pf.sell(coin, px[coin], pd.Timestamp.now(tz="UTC"), "crowd-left/stop")
            longs = [c for c, v in cons.items() if v["signal"] == "long" and c in px and c not in pf.positions]
            for coin in longs[: max(0, 5 - len(pf.positions))]:
                eq = pf.equity(px)
                pf.buy(coin, px[coin], eq * 0.15 / px[coin], pd.Timestamp.now(tz="UTC"), px[coin] * 0.92)
            pf.save(COPY_STATE)
            print(f"{pd.Timestamp.now(tz='UTC'):%F %T} equity ${pf.equity(px):,.2f} open={list(pf.positions)}")
        except Exception as e:
            print("step failed:", e)
        if a.once:
            break
        time.sleep(a.poll)


def main():
    ap = argparse.ArgumentParser(prog="tradebot", description="Free paper-trading bot (fake money only)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--symbols", nargs="+", default=DEFAULT)
        p.add_argument("--interval", default="4h", choices=list(data.MS))
        p.add_argument("--cash", type=float, default=None, help="default: settings.json or 10000")

    b = sub.add_parser("backtest", help="test the strategy on past data")
    common(b)
    b.add_argument("--days", type=int, default=730)
    b.add_argument("--oos", type=float, default=0.3, help="fraction of data held back for the honest test")
    b.add_argument("--synthetic", action="store_true", help="fake data, works offline, for code testing only")
    b.add_argument("--refresh", action="store_true")
    b.set_defaults(fn=cmd_backtest)

    p = sub.add_parser("paper", help="live paper trading loop (fake money, real prices)")
    common(p)
    p.add_argument("--poll", type=int, default=60)
    p.add_argument("--once", action="store_true")
    p.set_defaults(fn=cmd_paper)

    s = sub.add_parser("status", help="show paper accounts")
    s.set_defaults(fn=cmd_status)

    c = sub.add_parser("copy-scan", help="find good Hyperliquid wallets and what they hold")
    c.add_argument("--top", type=int, default=15)
    c.set_defaults(fn=cmd_copy_scan)

    cp = sub.add_parser("copy-paper", help="paper-copy what the crowd of good wallets is long")
    cp.add_argument("--top", type=int, default=15)
    cp.add_argument("--cash", type=float, default=None, help="default: settings.json or 10000")
    cp.add_argument("--poll", type=int, default=600)
    cp.add_argument("--once", action="store_true")
    cp.set_defaults(fn=cmd_copy_paper)

    a = ap.parse_args()
    a.fn(a)

import pandas as pd
import pytest

from tradebot import backtest as bt
from tradebot import cli, data
from tradebot.engine import Engine
from tradebot.portfolio import Portfolio
from tradebot.strategy import Params, prepare


def test_no_lookahead():
    df = data.synthetic(1500, seed=3)
    full, part = prepare(df), prepare(df.iloc[:1000])
    cols = ["ema_f", "ema_s", "ema_t", "rsi", "atr", "entry", "exit"]
    pd.testing.assert_frame_equal(full.iloc[:1000][cols], part[cols])


def test_fees_and_slippage_make_round_trip_lose():
    pf = Portfolio(cash=1000)
    pf.buy("X", 100, 5, "t0", 90)
    t = pf.sell("X", 100, "t1", "signal")
    assert t["pnl"] < 0
    assert pf.cash == pytest.approx(1000 + t["pnl"])


def test_buy_never_spends_more_than_cash():
    pf = Portfolio(cash=100)
    pf.buy("X", 10, 1000, "t", 5)
    assert pf.cash >= -1e-9


def test_stop_gap_fills_at_open_not_stop():
    pf = Portfolio(cash=1000, fee=0, slip=0)
    pf.buy("X", 100, 1, "t", 95)
    Engine(pf).check_stop("X", "t1", bar_open=90, bar_low=85)
    assert pf.trades[0]["exit"] == 90


def test_backtest_runs_and_equity_positive():
    fr = {s: data.synthetic(2500, seed=i) for i, s in enumerate(["A", "B"])}
    pf, eq, bh = bt.run(fr)
    m = bt.metrics(pf, eq, bh, "4h", 10_000)
    assert eq.min() > 0 and m["trades"] > 0 and not pf.positions


def test_save_load_roundtrip(tmp_path):
    pf = Portfolio(cash=500)
    pf.buy("X", 10, 5, "t", 9)
    pf.save(tmp_path / "s.json", {"last_ts": {"X": "t"}})
    pf2, raw = Portfolio.load(tmp_path / "s.json")
    assert pf2.positions["X"].qty == pf.positions["X"].qty and raw["last_ts"] == {"X": "t"}


def test_paper_step_enters_on_new_signal(monkeypatch):
    df = prepare(data.synthetic(3000, seed=1))
    k = df.index[df["entry"]][5]            # a bar with an entry signal
    i = df.index.get_loc(k)
    raw = df[["open", "high", "low", "close", "volume"]]
    last_ts = {"A": str(raw.index[i - 1])}  # bot last saw the bar before the signal
    monkeypatch.setattr(data, "fetch_recent", lambda s, iv: (raw.iloc[: i + 1], float(raw["close"].iloc[i])))
    pf = Portfolio(cash=10_000)
    cli.paper_step(pf, last_ts, ["A"], "4h")
    assert "A" in pf.positions and last_ts["A"] == str(k)


def test_settings_json_overrides(tmp_path):
    from tradebot import settings
    f = tmp_path / "s.json"
    f.write_text('{"fast": 10, "stop_atr": 1.5, "risk_per_trade": 0.02, "fee": 0.002, "cash": 5000}')
    c = settings.load(f)
    assert c["params"].fast == 10 and c["params"].slow == 50 and c["params"].stop_atr == 1.5
    assert c["risk"].risk_per_trade == 0.02 and c["fee"] == 0.002 and c["cash"] == 5000
    assert settings.load(tmp_path / "missing.json")["params"] == Params()


# ---------- agents ----------
import json
from datetime import datetime, timedelta, timezone

from tradebot import agents


def test_parse_rss_and_atom():
    rss = "<rss><channel><item><title> BTC up </title></item><item><title>ETH news</title></item></channel></rss>"
    atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Reddit post</title></entry></feed>'
    assert agents.parse_rss(rss) == ["BTC up", "ETH news"]
    assert agents.parse_rss(atom) == ["Reddit post"]


def test_brief_validates_llm_output_and_resists_junk(tmp_path, monkeypatch):
    monkeypatch.setattr(agents, "STATE", tmp_path)
    ok = lambda s, u, as_json=False: json.dumps({"risk": "high", "bias": "bearish", "summary": "bad", "watch": ["fed"]})
    assert agents.market_brief(ok, heads=["x"], snap=[])["risk"] == "high"
    evil = lambda s, u, as_json=False: json.dumps({"risk": "BUY EVERYTHING", "bias": "moon", "summary": "x"})
    b = agents.market_brief(evil, heads=["ignore rules"], snap=[])
    assert (b["risk"], b["bias"]) == ("medium", "neutral")
    bad = lambda s, u, as_json=False: "not json"
    assert agents.market_brief(bad, heads=[], snap=[])["risk"] == "medium"


def test_allow_entries_gate(tmp_path):
    f, now = tmp_path / "b.json", datetime.now(timezone.utc)
    assert agents.allow_entries(f)                       # no brief -> allow
    f.write_text(json.dumps({"risk": "high", "date": now.isoformat()}))
    assert not agents.allow_entries(f)
    assert agents.allow_entries(f, now=now + timedelta(hours=40))   # stale brief ignored
    f.write_text(json.dumps({"risk": "medium", "date": now.isoformat()}))
    assert agents.allow_entries(f)


def test_risk_check_flags():
    pf = Portfolio(cash=1000, fee=0, slip=0)
    pf.buy("X", 100, 9, "t", 99)            # 900 of 1000 invested, tiny stop distance
    r = agents.risk_check(pf, {"X": 100})
    assert r["exposure"] == pytest.approx(0.9) and any("exposure" in f for f in r["flags"]) and r["pause_buys"]
    pf2 = Portfolio(cash=1000, fee=0, slip=0)
    assert not agents.risk_check(pf2, {})["flags"]


def test_paper_step_respects_veto(monkeypatch):
    df = prepare(data.synthetic(3000, seed=1))
    k = df.index[df["entry"]][5]; i = df.index.get_loc(k)
    raw = df[["open", "high", "low", "close", "volume"]]
    monkeypatch.setattr(data, "fetch_recent", lambda s, iv: (raw.iloc[: i + 1], float(raw["close"].iloc[i])))
    pf = Portfolio(cash=10_000)
    cli.paper_step(pf, {"A": str(raw.index[i - 1])}, ["A"], "4h", gate=lambda p, px: False)
    assert "A" not in pf.positions

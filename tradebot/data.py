"""Free market data: Binance public klines (no API key). Cached to data/*.csv."""
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

HOSTS = ["https://api.binance.com", "https://data-api.binance.vision"]  # second one is market-data only, works where the first is blocked
MS = {"1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}
CACHE = Path("data")
COLS = ["open", "high", "low", "close", "volume"]


def _get(path, params):
    last = None
    for h in HOSTS:
        try:
            r = requests.get(h + path, params=params, timeout=15)
            r.raise_for_status()
            return r.json()
        except requests.RequestException as e:
            last = e
    raise RuntimeError(f"all Binance hosts failed: {last}")


def _frame(rows):
    df = pd.DataFrame(rows).iloc[:, :7]
    df.columns = ["t", *COLS, "close_t"]
    df.index = pd.to_datetime(df.pop("t"), unit="ms", utc=True)
    df["close_t"] = pd.to_datetime(df["close_t"], unit="ms", utc=True)
    return df.astype({c: float for c in COLS})


def fetch_history(symbol: str, interval: str = "4h", days: int = 730, refresh: bool = False) -> pd.DataFrame:
    f = CACHE / f"{symbol}_{interval}.csv"
    if f.exists() and not refresh:
        df = pd.read_csv(f, index_col=0, parse_dates=True)
        if time.time() - f.stat().st_mtime < 6 * 3600:
            return df
    start = int((time.time() - days * 86400) * 1000)
    rows = []
    while True:
        chunk = _get("/api/v3/klines", dict(symbol=symbol, interval=interval, startTime=start, limit=1000))
        if not chunk:
            break
        rows += chunk
        start = chunk[-1][0] + MS[interval]
        if len(chunk) < 1000:
            break
    df = _frame(rows)
    df = df[df["close_t"] < pd.Timestamp.now(tz="UTC")][COLS]  # drop the unfinished candle
    CACHE.mkdir(exist_ok=True)
    df.to_csv(f)
    return df


def fetch_recent(symbol: str, interval: str, limit: int = 300):
    """Returns (closed candles, current price). The last candle from Binance is still open."""
    df = _frame(_get("/api/v3/klines", dict(symbol=symbol, interval=interval, limit=limit)))
    closed = df[df["close_t"] < pd.Timestamp.now(tz="UTC")]
    return closed[COLS], float(df["close"].iloc[-1])


def synthetic(n: int = 4000, seed: int = 0, interval: str = "4h") -> pd.DataFrame:
    """Fake prices with trending/choppy regimes. ONLY for testing the code, never to judge a strategy."""
    rng = np.random.default_rng(seed)
    drift = np.repeat(rng.choice([-0.0004, 0.0, 0.0006], size=n // 200 + 1), 200)[:n]
    vol = np.repeat(rng.choice([0.008, 0.015, 0.025], size=n // 200 + 1), 200)[:n]
    ret = drift + vol * rng.standard_normal(n)
    close = 30_000 * np.exp(np.cumsum(ret))
    open_ = np.concatenate([[30_000], close[:-1]])
    span = np.abs(rng.standard_normal(n)) * vol * close * 0.6
    idx = pd.date_range("2023-01-01", periods=n, freq=pd.Timedelta(milliseconds=MS[interval]), tz="UTC")
    return pd.DataFrame(dict(open=open_, high=np.maximum(open_, close) + span, low=np.minimum(open_, close) - span,
                             close=close, volume=1.0), index=idx)

"""Optional settings.json in the repo folder (export it from Tradebot Lab). Missing keys keep the defaults."""
import json
from dataclasses import fields
from pathlib import Path

from .engine import Risk
from .strategy import Params

FILE = Path("settings.json")


def load(path=FILE):
    raw = json.loads(Path(path).read_text()) if Path(path).exists() else {}
    pick = lambda cls: {f.name: raw[f.name] for f in fields(cls) if f.name in raw}
    return dict(params=Params(**pick(Params)), risk=Risk(**pick(Risk)),
                fee=raw.get("fee", 0.001), slip=raw.get("slip", 0.0005), cash=raw.get("cash", 10_000.0))

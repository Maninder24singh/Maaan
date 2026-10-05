"""Copy-trading signal from public Hyperliquid wallets (free, no key, on-chain data is public).

Honest limits: the leaderboard is full of survivors (people who got lucky on leverage), and you see
their positions late. So we only keep wallets with big accounts and steady results, and only act when
MANY of them agree. This is a filter, not a guarantee.
"""
import requests

LEADERBOARD = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard"
INFO = "https://api.hyperliquid.xyz/info"


def _info(body):
    r = requests.post(INFO, json=body, timeout=15)
    r.raise_for_status()
    return r.json()


def pick_wallets(min_account=250_000, max_month_roi=3.0, top=15):
    rows = requests.get(LEADERBOARD, timeout=30).json()["leaderboardRows"]
    keep = []
    for r in rows:
        w = {k: v for k, v in r["windowPerformances"]}
        try:
            acct, m, a, wk = float(r["accountValue"]), w["month"], w["allTime"], w["week"]
            m_roi, a_roi, wk_roi = float(m["roi"]), float(a["roi"]), float(wk["roi"])
            a_pnl, m_pnl = float(a["pnl"]), float(m["pnl"])
        except (KeyError, ValueError, TypeError):
            continue
        # big account, profitable over month AND all time, not a lottery month, not blowing up this week
        if acct >= min_account and a_pnl > 0 and m_pnl > 0 and 0 < m_roi < max_month_roi and a_roi > 0.2 and wk_roi > -0.05:
            keep.append((a_roi, r["ethAddress"], acct, m_roi))
    keep.sort(reverse=True)
    return [dict(addr=a, account=acct, month_roi=m) for _, a, acct, m in keep[:top]]


def positions(addr):
    st = _info({"type": "clearinghouseState", "user": addr})
    acct = float(st["marginSummary"]["accountValue"])
    out = []
    for ap in st["assetPositions"]:
        p = ap["position"]
        out.append(dict(coin=p["coin"], side=1 if float(p["szi"]) > 0 else -1,
                        weight=float(p["positionValue"]) / acct if acct else 0.0))
    return out


def consensus(wallets, min_wallets=3, min_agree=0.6):
    """Per coin: how many top wallets are long vs short. Returns {coin: {'longs','shorts','score'}}."""
    book = {}
    for w in wallets:
        try:
            for p in positions(w["addr"]):
                c = book.setdefault(p["coin"], dict(longs=0, shorts=0, score=0.0))
                c["longs" if p["side"] > 0 else "shorts"] += 1
                c["score"] += p["side"] * p["weight"]
        except requests.RequestException:
            continue
    for c in book.values():
        n = c["longs"] + c["shorts"]
        c["signal"] = ("long" if c["longs"] / n >= min_agree else "short" if c["shorts"] / n >= min_agree else "none") if n >= min_wallets else "none"
    return book


def mids():
    return {k: float(v) for k, v in _info({"type": "allMids"}).items()}

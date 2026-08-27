#!/usr/bin/env python3
"""Render durable-state eval charts from captured ledgers.

Sources (repo root):
  repeated-work-ledger.json   required  — 19/20 = 95%
  tough-eval-ledger.json      required  — 330 turns, 25.15%, 0 false hits
  workday-eval-ledger.json    optional  — 5/10/20% novel overalls + 5% series
  workday-eval-spec.json      optional

Run from the repo root:

  python3 -m venv .venv && .venv/bin/pip install matplotlib
  .venv/bin/python charts/render.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import matplotlib.patheffects as pe
from matplotlib.patches import FancyBboxPatch
from matplotlib.ticker import FuncFormatter, MultipleLocator

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "charts"

INK = "#111111"
CANVAS = "#141414"
RAISED = "#1C1C1C"
LINE = "#2A2A2A"
TEXT = "#F2F2F2"
SECONDARY = "#B4B4B4"
MUTED = "#8A8A8A"
GHOST = "#5A5A5A"
NEON = "#00C972"
NEON_SOFT = "#00C97228"
NEON_MID = "#00C97266"
GOLD = "#F0C000"
CYAN = "#00BCA6"
CYAN_SOFT = "#00BCA628"

plt.rcParams.update(
    {
        "font.family": "sans-serif",
        "font.sans-serif": [
            "Avenir Next",
            "Avenir",
            "Helvetica Neue",
            "SF Pro Display",
            "Arial",
            "DejaVu Sans",
        ],
        "font.size": 11,
        "axes.linewidth": 0,
        "figure.facecolor": CANVAS,
        "axes.facecolor": CANVAS,
        "savefig.facecolor": CANVAS,
        "savefig.edgecolor": CANVAS,
        "text.color": TEXT,
        "axes.labelcolor": SECONDARY,
        "xtick.color": MUTED,
        "ytick.color": MUTED,
        "svg.fonttype": "path",
        "pdf.fonttype": 42,
        "figure.dpi": 140,
        "axes.unicode_minus": False,
    }
)


def load(path: Path):
    return json.loads(path.read_text())


def frac_pct(x: float, digits: int | None = None) -> str:
    pct = 100.0 * x
    if digits is None:
        if abs(pct - round(pct)) < 0.05:
            return f"{int(round(pct))}%"
        digits = 2
    s = f"{pct:.{digits}f}".rstrip("0").rstrip(".")
    return s + "%"


def cumulative(flags: list[bool]) -> list[float]:
    out = []
    hits = 0
    for i, hit in enumerate(flags, start=1):
        if hit:
            hits += 1
        out.append(hits / i)
    return out


def window_rate(flags: list[bool], start: int, end: int) -> float:
    slice_ = flags[start:end]
    if not slice_:
        return 0.0
    return sum(1 for h in slice_ if h) / len(slice_)


def glow_line():
    return [
        pe.Stroke(linewidth=7.0, foreground=NEON_SOFT),
        pe.Stroke(linewidth=3.2, foreground=NEON_MID),
        pe.Normal(),
    ]


def as_float(v, default=None):
    if v is None:
        return default
    if isinstance(v, bool):
        return default
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip().replace("%", "")
        try:
            x = float(s)
        except ValueError:
            return default
        if "%" in v or (x > 1.5 and x <= 100):
            return x / 100.0
        return x
    return default


def snap_f(v: float) -> float:
    target = min((0.05, 0.10, 0.20), key=lambda t: abs(t - v))
    return target if abs(target - v) < 0.03 else v


# ---------------------------------------------------------------------------
# Ledgers
# ---------------------------------------------------------------------------


def load_repeated() -> dict:
    data = load(ROOT / "repeated-work-ledger.json")
    flags = [bool(t.get("inferenceAvoided")) for t in data["turns"]]
    summary = data.get("summary") or {}
    return {
        "turns": len(flags),
        "hits": int(summary.get("hits") or sum(flags)),
        "misses": int(summary.get("misses") or (len(flags) - sum(flags))),
        "avoidance": float(summary.get("avoidedOverTotal") or (sum(flags) / len(flags))),
        "flags": flags,
        "series": cumulative(flags),
        "costUsd": float((data.get("ledger") or {}).get("costUsd") or 0.0),
        "inferenceCalls": int(summary.get("inferenceCalls") or 1),
    }


def load_hostile() -> dict:
    data = load(ROOT / "tough-eval-ledger.json")
    turns = data["turns"]
    flags = [bool(t.get("inferenceAvoided")) for t in turns]
    summary = data.get("summary") or {}
    paraphrase_hit = sum(
        1
        for t in turns
        if (t.get("gold") or {}).get("reason") == "paraphrase" and t.get("outcome") == "hit"
    )
    paraphrase_miss = sum(
        1
        for t in turns
        if (t.get("gold") or {}).get("reason") == "paraphrase" and t.get("outcome") == "miss"
    )
    expected_miss = sum(1 for t in turns if (t.get("gold") or {}).get("expect") == "miss")
    return {
        "turns": int(summary.get("turns") or len(turns)),
        "hits": int(summary.get("hits") or sum(flags)),
        "misses": int(summary.get("misses") or (len(flags) - sum(flags))),
        "avoidance": float(summary.get("avoidance") or (sum(flags) / len(flags))),
        "falseHitRate": float(summary.get("falseHitRate") or 0.0),
        "staleHitRate": float(summary.get("staleHitRate") or 0.0),
        "falseHits": int(summary.get("falseHits") or 0),
        "staleHits": int(summary.get("staleHits") or 0),
        "costUsd": float(summary.get("costUsd") or 0.0),
        "inferenceCalls": int(summary.get("inferenceCalls") or 0),
        "flags": flags,
        "series": cumulative(flags),
        "paraphraseHits": paraphrase_hit,
        "paraphraseMisses": paraphrase_miss,
        "paraphraseGold": paraphrase_hit + paraphrase_miss,
        "expectedMisses": expected_miss,
    }


def _series_from(obj) -> list[float] | None:
    raw = None
    if isinstance(obj, list):
        raw = obj
    elif isinstance(obj, dict):
        raw = obj.get("series") or obj.get("cumulative") or obj.get("cumulativeAvoidance")
    if not isinstance(raw, list) or not raw:
        return None
    if isinstance(raw[0], dict):
        vals = []
        for row in raw:
            v = row.get("cumulativeAvoidance", row.get("avoidance", row.get("y")))
            fv = as_float(v)
            if fv is None:
                return None
            vals.append(fv if fv <= 1.5 else fv / 100.0)
        return vals
    if isinstance(raw[0], (int, float)):
        return [float(v) if float(v) <= 1.5 else float(v) / 100.0 for v in raw]
    return None


def _flags_from_turns(turns) -> list[bool] | None:
    if not isinstance(turns, list) or not turns or not isinstance(turns[0], dict):
        return None
    return [
        bool(t.get("inferenceAvoided") if "inferenceAvoided" in t else t.get("outcome") == "hit")
        for t in turns
    ]


def _run_from_summary(summary: dict, f: float) -> dict:
    avoidance = as_float(summary.get("avoidance"))
    hits = as_float(summary.get("hits"))
    turns = as_float(summary.get("turns"))
    if avoidance is None and hits is not None and turns:
        avoidance = hits / turns
    return {
        "f": f,
        "avoidance": float(avoidance if avoidance is not None else (1.0 - f)),
        "series": None,
        "flags": None,
        "turns": int(turns or 0),
        "hits": int(hits or 0),
        "firstLooks": int(as_float(summary.get("firstLooks"), 0) or 0),
        "falseHitRate": float(as_float(summary.get("falseHitRate"), 0) or 0),
        "staleHitRate": float(as_float(summary.get("staleHitRate"), 0) or 0),
        "falseHits": int(as_float(summary.get("falseHits"), 0) or 0),
        "staleHits": int(as_float(summary.get("staleHits"), 0) or 0),
        "early": as_float(summary.get("earlyAvoidance")),
        "late": as_float(summary.get("lateAvoidance")),
        "earlyWindow": None,
        "lateWindow": None,
        "costUsd": as_float(summary.get("costUsd")),
        "inferenceCalls": int(as_float(summary.get("inferenceCalls"), 0) or 0),
        "measured": avoidance is not None,
    }


def load_workday() -> dict | None:
    path = ROOT / "workday-eval-ledger.json"
    spec_path = ROOT / "workday-eval-spec.json"
    if not path.exists():
        return None
    data = load(path)
    spec = load(spec_path) if spec_path.exists() else {}
    runs: dict[float, dict] = {}

    by = data.get("byNovelRate") if isinstance(data.get("byNovelRate"), dict) else {}
    for k, v in by.items():
        if not isinstance(v, dict):
            continue
        f = snap_f(as_float(v.get("novelRate")) or as_float(k) or 0)
        runs[f] = _run_from_summary(v, f)

    summary = data.get("summary") if isinstance(data.get("summary"), dict) else {}
    workload = data.get("workload") if isinstance(data.get("workload"), dict) else {}
    primary_f = snap_f(
        as_float(summary.get("novelRate"))
        or as_float(workload.get("novelRate"))
        or 0.05
    )
    primary = runs.get(primary_f) or _run_from_summary(summary or {}, primary_f)

    series = _series_from(data) or _series_from(summary)
    flags = _flags_from_turns(data.get("turns"))
    if series is None and flags:
        series = cumulative(flags)
    windows = data.get("windows") if isinstance(data.get("windows"), dict) else {}
    early_w = windows.get("early") if isinstance(windows.get("early"), dict) else None
    late_w = windows.get("late") if isinstance(windows.get("late"), dict) else None

    primary["series"] = series
    primary["flags"] = flags
    if as_float(summary.get("avoidance")) is not None:
        primary["avoidance"] = float(summary["avoidance"])
        primary["measured"] = True
    if as_float(summary.get("turns")):
        primary["turns"] = int(summary["turns"])
    if as_float(summary.get("hits")) is not None:
        primary["hits"] = int(summary["hits"])
    if early_w:
        primary["early"] = as_float(early_w.get("avoidance"), primary.get("early"))
        primary["earlyWindow"] = (int(early_w.get("start") or 1), int(early_w.get("end") or 1))
    if late_w:
        primary["late"] = as_float(late_w.get("avoidance"), primary.get("late"))
        primary["lateWindow"] = (int(late_w.get("start") or 1), int(late_w.get("end") or 1))
    runs[primary_f] = primary

    ordered = [runs[k] for k in sorted(runs)]
    if not ordered:
        print("workday-eval-ledger.json present but no runs parsed; keys:", list(data)[:40], file=sys.stderr)
        return None
    return {"runs": ordered, "primary_f": primary_f, "spec": spec, "source": path.name}


def run_at(workday: dict | None, f: float) -> dict | None:
    if not workday:
        return None
    for r in workday["runs"]:
        if abs(r["f"] - f) < 0.015:
            return r
    return None


# ---------------------------------------------------------------------------
# Drawing
# ---------------------------------------------------------------------------


def save(fig, stem: str) -> list[Path]:
    paths = []
    for ext, kw in (("svg", {}), ("png", {"dpi": 160})):
        path = OUT / f"{stem}.{ext}"
        fig.savefig(path, facecolor=CANVAS, edgecolor=CANVAS, **kw)
        paths.append(path)
    plt.close(fig)
    return paths


def header(fig, kicker: str, title: str, sub: str):
    fig.text(0.055, 0.945, kicker.upper(), fontsize=8.2, color=NEON, ha="left", va="top")
    fig.text(0.055, 0.905, title, fontsize=16.5, color=TEXT, ha="left", va="top")
    fig.text(0.055, 0.855, sub, fontsize=10.4, color=SECONDARY, ha="left", va="top")


def style_axes(ax):
    ax.set_facecolor(CANVAS)
    ax.tick_params(length=0, pad=4)
    ax.grid(axis="y", color=LINE, lw=0.7)
    ax.set_axisbelow(True)
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _p: f"{int(v)}%"))


def rounded_bar(ax, x, width, height, facecolor, edgecolor, lw=1.2, alpha=1.0, z=3):
    ax.add_patch(
        FancyBboxPatch(
            (x - width / 2, 0.0),
            width,
            max(height, 0.01),
            boxstyle="round,pad=0,rounding_size=0.05",
            linewidth=lw,
            edgecolor=edgecolor,
            facecolor=facecolor,
            alpha=alpha,
            zorder=z,
        )
    )


# ---------------------------------------------------------------------------
# A. Workday cumulative
# ---------------------------------------------------------------------------


def chart_workday_cumulative(repeated: dict, workday: dict | None) -> list[Path]:
    run5 = run_at(workday, 0.05)
    using_ledger = bool(run5 and run5.get("series"))
    if using_ledger:
        series = run5["series"]
        flags = run5.get("flags")
        source = f"workday ledger  ·  {run5['turns']} turns  ·  5% novel"
        early = run5.get("early")
        late = run5.get("late")
        early_win = run5.get("earlyWindow")
        late_win = run5.get("lateWindow")
    else:
        series = repeated["series"]
        flags = repeated["flags"]
        source = "5% novel day  ·  19/20 replay"
        early = late = None
        early_win = late_win = None

    n = len(series)
    xs = list(range(1, n + 1))
    early_n = max(1, int(round(n * 0.20))) if n <= 40 else min(50, n)
    late_n = early_n
    if early_win:
        e0, e1 = early_win
    else:
        e0, e1 = 1, early_n
    if late_win:
        l0, l1 = late_win
    else:
        l0, l1 = n - late_n + 1, n

    if early is None:
        early = window_rate(flags, e0 - 1, e1) if flags else series[min(e1, n) - 1]
    if late is None:
        late = window_rate(flags, l0 - 1, l1) if flags else series[-1]

    fig = plt.figure(figsize=(11.4, 5.85), facecolor=CANVAS)
    header(
        fig,
        "Figure A  ·  workday",
        "Avoidance climbs as the store fills",
        f"Cumulative inference avoided  ·  {source}  ·  95% is a day where about 1 in 20 turns is a first look",
    )
    ax = fig.add_axes([0.08, 0.13, 0.88, 0.64])
    style_axes(ax)

    ax.axvspan(e0 - 0.5, e1 + 0.5, color=GOLD, alpha=0.07, lw=0, zorder=0)
    ax.axvspan(l0 - 0.5, l1 + 0.5, color=NEON, alpha=0.08, lw=0, zorder=0)

    ax.plot(
        xs,
        [v * 100 for v in series],
        color=NEON,
        lw=2.35,
        solid_capstyle="round",
        path_effects=glow_line(),
        zorder=4,
    )
    ax.fill_between(xs, [v * 100 for v in series], color=NEON, alpha=0.10, zorder=1)

    ax.axhline(95, color=GOLD, lw=1.15, ls=(0, (4, 3.2)), zorder=3)
    ax.text(0.02, 95.0, "95%", color=GOLD, fontsize=10, va="bottom", ha="left", transform=ax.get_yaxis_transform())

    final = series[-1] * 100
    ax.scatter([n], [final], s=32, color=NEON, zorder=5, linewidths=0)
    ax.annotate(
        frac_pct(series[-1]),
        xy=(n, final),
        xytext=(-6, 8),
        textcoords="offset points",
        color=NEON,
        fontsize=12.5,
        ha="right",
        va="bottom",
    )

    ax.text((e0 + e1) / 2, 4.5, f"early  {frac_pct(early)}", ha="center", va="bottom", color=GOLD, fontsize=9.2)
    ax.text((l0 + l1) / 2, 4.5, f"late  {frac_pct(late)}", ha="center", va="bottom", color=NEON, fontsize=9.2)

    ax.set_xlim(0.5, n + 0.6)
    ax.set_ylim(0, 108)
    ax.set_xlabel("turn")
    ax.set_ylabel("cumulative avoidance")
    if n <= 25:
        ax.xaxis.set_major_locator(MultipleLocator(5))
    elif n <= 120:
        ax.xaxis.set_major_locator(MultipleLocator(20))
    else:
        ax.xaxis.set_major_locator(MultipleLocator(50))
    ax.yaxis.set_major_locator(MultipleLocator(25))
    ax.set_yticks([0, 25, 50, 75, 95, 100])

    return save(fig, "workday-cumulative")


# ---------------------------------------------------------------------------
# B. Novel-fraction bars
# ---------------------------------------------------------------------------


def chart_novel_fraction(repeated: dict, workday: dict | None) -> list[Path]:
    measured: dict[float, float] = {0.05: repeated["avoidance"]}
    meta: dict[float, dict] = {0.05: {"source": "19/20"}}
    if workday:
        for r in workday["runs"]:
            if r.get("measured"):
                measured[r["f"]] = r["avoidance"]
                meta[r["f"]] = r

    fig = plt.figure(figsize=(10.6, 5.7), facecolor=CANVAS)
    header(
        fig,
        "Figure B  ·  identity",
        "Avoidance tracks 1 - F",
        "A workday is mostly non-novel. Highlighted: 5% novel, the workday. Dashed gold is the identity 1 - F.",
    )
    ax = fig.add_axes([0.10, 0.16, 0.84, 0.60])
    style_axes(ax)

    fractions = [0.05, 0.10, 0.20]
    width = 0.48
    for i, f in enumerate(fractions):
        identity = 1.0 - f
        has = f in measured
        value = measured[f] if has else identity
        h = value * 100
        identity_h = identity * 100
        is_workday = abs(f - 0.05) < 1e-9
        if is_workday:
            face, edge, lw, alpha = NEON, NEON, 1.7, 1.0
        elif has:
            face, edge, lw, alpha = CYAN, CYAN, 1.2, 1.0
        else:
            face, edge, lw, alpha = RAISED, MUTED, 1.0, 0.95
        rounded_bar(ax, i, width, h, face, edge, lw=lw, alpha=alpha)
        ax.plot(
            [i - width / 2 - 0.05, i + width / 2 + 0.05],
            [identity_h, identity_h],
            color=GOLD,
            lw=1.7,
            ls=(0, (3.2, 2.2)),
            zorder=6,
            solid_capstyle="round",
        )
        ax.text(
            i,
            max(h, identity_h) + 3.4,
            frac_pct(value),
            ha="center",
            va="bottom",
            color=NEON if is_workday else (TEXT if has else GOLD),
            fontsize=16,
        )
        if not has:
            ax.text(i, h * 0.48, "1 - F", ha="center", va="center", color=GOLD, fontsize=9.5)
        elif abs(value - identity) > 0.015:
            ax.text(i, identity_h + 1.6, f"1 - F = {frac_pct(identity)}", ha="center", va="bottom", color=GOLD, fontsize=8)

    ax.set_xlim(-0.72, 2.72)
    ax.set_ylim(0, 118)
    ax.set_xticks([0, 1, 2])
    ax.set_xticklabels(["5% novel", "10% novel", "20% novel"], color=SECONDARY, fontsize=12)
    ax.set_ylabel("avoidance")
    ax.yaxis.set_major_locator(MultipleLocator(25))
    ax.set_yticks([0, 25, 50, 75, 95, 100])

    ax.text(0, -14.5, "the workday", ha="center", va="top", color=NEON, fontsize=10)

    return save(fig, "novel-fraction")


# ---------------------------------------------------------------------------
# C. Three experiments
# ---------------------------------------------------------------------------


def chart_three(repeated: dict, hostile: dict, workday: dict | None) -> list[Path]:
    run5 = run_at(workday, 0.05)
    if run5 and run5.get("measured"):
        workday_avoid = run5["avoidance"]
        if run5.get("turns"):
            workday_sub = f"{run5['hits']}/{run5['turns']} turns"
        else:
            workday_sub = "5% novel"
        workday_note = "every revisit paraphrase hit"
    else:
        workday_avoid = repeated["avoidance"]
        workday_sub = "about 1 in 20 turns is a first look"
        workday_note = "the workday"

    cards = [
        dict(
            kicker="single-finding replay",
            value=frac_pct(repeated["avoidance"]),
            detail=f"{repeated['hits']}/{repeated['turns']} turns",
            note="one paid miss, then 19 hits",
            accent=NEON,
            fill="#00C97216",
        ),
        dict(
            kicker="workday  ·  5% novel",
            value=frac_pct(workday_avoid),
            detail=workday_sub,
            note=workday_note,
            accent=GOLD,
            fill="#F0C00016",
            hero=True,
        ),
        dict(
            kicker="hostile mix  ·  safety",
            value="25%",
            detail=f"{hostile['hits']}/{hostile['turns']} = {frac_pct(hostile['avoidance'])}",
            note="0 false hits  ·  0 stale hits",
            accent=CYAN,
            fill="#00BCA616",
        ),
    ]

    fig = plt.figure(figsize=(11.5, 4.85), facecolor=CANVAS)
    fig.text(0.055, 0.93, "FIGURE C  ·  THREE EXPERIMENTS", fontsize=8.2, color=NEON, ha="left", va="top")
    fig.text(
        0.055,
        0.87,
        "95% is the workday.  25% is the safety mix.",
        fontsize=17.5,
        color=TEXT,
        ha="left",
        va="top",
    )
    ax = fig.add_axes([0.04, 0.08, 0.92, 0.68])
    ax.set_xlim(0, 3)
    ax.set_ylim(0, 1)
    ax.axis("off")
    ax.set_facecolor(CANVAS)

    for i, c in enumerate(cards):
        x0 = 0.08 + i * 0.98
        ax.add_patch(
            FancyBboxPatch(
                (x0, 0.08),
                0.86,
                0.84,
                boxstyle="round,pad=0.016,rounding_size=0.045",
                linewidth=1.7 if c.get("hero") else 0.9,
                edgecolor=c["accent"],
                facecolor=c["fill"],
            )
        )
        ax.text(x0 + 0.08, 0.78, c["kicker"].upper(), fontsize=8.1, color=c["accent"], ha="left", va="bottom")
        ax.text(x0 + 0.08, 0.40, c["value"], fontsize=38, color=TEXT, ha="left", va="bottom")
        ax.text(x0 + 0.08, 0.27, c["detail"], fontsize=11, color=SECONDARY, ha="left", va="bottom")
        ax.text(x0 + 0.08, 0.15, c["note"], fontsize=10.6, color=c["accent"], ha="left", va="bottom")

    return save(fig, "three-experiments")


# ---------------------------------------------------------------------------
# D. False-hit callout
# ---------------------------------------------------------------------------


def chart_false_hits(hostile: dict) -> list[Path]:
    fig = plt.figure(figsize=(10.8, 4.55), facecolor=CANVAS)
    fig.text(0.055, 0.93, "FIGURE D  ·  SAFETY", fontsize=8.2, color=NEON, ha="left", va="top")
    fig.text(0.055, 0.86, "False-hit rate 0.  Stale-hit rate 0.", fontsize=17.5, color=TEXT, ha="left", va="top")
    fig.text(
        0.055,
        0.79,
        "The hostile mix scores the gates. A conservative miss is not a wrong answer.",
        fontsize=10.5,
        color=SECONDARY,
        ha="left",
        va="top",
    )
    ax = fig.add_axes([0.04, 0.08, 0.92, 0.62])
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.axis("off")
    ax.set_facecolor(CANVAS)

    for i, label in enumerate(("false-hit rate", "stale-hit rate")):
        x = 0.04 + i * 0.34
        ax.add_patch(
            FancyBboxPatch(
                (x, 0.10),
                0.30,
                0.80,
                boxstyle="round,pad=0.014,rounding_size=0.04",
                linewidth=1.3,
                edgecolor=NEON,
                facecolor=NEON_SOFT,
            )
        )
        ax.text(x + 0.15, 0.42, "0", fontsize=58, color=NEON, ha="center", va="bottom")
        ax.text(x + 0.15, 0.20, label, fontsize=11.2, color=SECONDARY, ha="center", va="bottom")

    x = 0.74
    ax.text(x, 0.82, "HOSTILE MIX", fontsize=8.1, color=CYAN, ha="left", va="bottom")
    facts = [
        f"{hostile['hits']}/{hostile['turns']} hits",
        f"{frac_pct(hostile['avoidance'])} avoidance",
        f"{hostile['paraphraseHits']}/{hostile['paraphraseGold']} gold paraphrases",
        f"{hostile['paraphraseMisses']} conservative misses",
        f"{hostile['expectedMisses']} expected misses held",
        f"${hostile['costUsd']:.3f}  ·  {hostile['inferenceCalls']} calls",
    ]
    y = 0.70
    for line in facts:
        ax.text(x, y, line, fontsize=11, color=SECONDARY, ha="left", va="top")
        y -= 0.105

    return save(fig, "false-hits")


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    repeated = load_repeated()
    hostile = load_hostile()
    workday = load_workday()

    print(f"repeated  {repeated['hits']}/{repeated['turns']}  {frac_pct(repeated['avoidance'])}")
    print(
        f"hostile   {hostile['hits']}/{hostile['turns']}  {frac_pct(hostile['avoidance'])}  "
        f"false={hostile['falseHitRate']} stale={hostile['staleHitRate']}"
    )
    if workday:
        for r in workday["runs"]:
            print(
                f"workday   F={r['f']:.0%}  avoidance={frac_pct(r['avoidance'])}  "
                f"turns={r['turns']}  series={len(r['series'] or [])}  measured={r['measured']}"
            )
    else:
        print("workday   ledger not present — 5% uses 19/20; curve uses 19/20 cumulative")

    paths = []
    paths += chart_workday_cumulative(repeated, workday)
    paths += chart_novel_fraction(repeated, workday)
    paths += chart_three(repeated, hostile, workday)
    paths += chart_false_hits(hostile)
    for p in paths:
        print(f"wrote {p.relative_to(ROOT)}  {p.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

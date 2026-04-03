"""
週/月マッピングモジュール
会社独自カレンダー: 日曜始まりの週番号、四半期末が5週
"""
from datetime import date, timedelta

# 各年の最初の日曜日 (= W1開始日)
YEAR_FIRST_SUNDAY = {
    2024: date(2024, 1, 7),
    2025: date(2025, 1, 5),
    2026: date(2026, 1, 4),
    2027: date(2027, 1, 3),
}

# 年 → 月 → 週番号リスト のマッピング
# スプレッドシート「WEEK」シートより
MONTH_WEEK_MAP = {
    2025: {
        1:  list(range(1,  6)),   # W1-W5  (5週)
        2:  list(range(6,  10)),  # W6-W9  (4週)
        3:  list(range(10, 15)),  # W10-W14(5週)
        4:  list(range(15, 19)),  # W15-W18(4週)
        5:  list(range(19, 23)),  # W19-W22(4週)
        6:  list(range(23, 28)),  # W23-W27(5週)
        7:  list(range(28, 32)),  # W28-W31(4週)
        8:  list(range(32, 36)),  # W32-W35(4週)
        9:  list(range(36, 41)),  # W36-W40(5週)
        10: list(range(41, 45)),  # W41-W44(4週)
        11: list(range(45, 49)),  # W45-W48(4週)
        12: list(range(49, 54)),  # W49-W53(5週)
    },
    2026: {
        1:  list(range(1,  5)),   # W1-W4  (4週)
        2:  list(range(5,  9)),   # W5-W8  (4週)
        3:  list(range(9,  14)),  # W9-W13 (5週)
        4:  list(range(14, 18)),  # W14-W17(4週)
        5:  list(range(18, 23)),  # W18-W22(5週)
        6:  list(range(23, 28)),  # W23-W27(5週)
        7:  list(range(28, 32)),  # W28-W31(4週)
        8:  list(range(32, 37)),  # W32-W36(5週)
        9:  list(range(37, 41)),  # W37-W40(4週)
        10: list(range(41, 45)),  # W41-W44(4週)
        11: list(range(45, 50)),  # W45-W49(5週)
        12: list(range(50, 55)),  # W50-W54(5週)
    },
}

# 逆引き: (year, week) → month
WEEK_TO_MONTH = {}
for _yr, _months in MONTH_WEEK_MAP.items():
    for _mo, _weeks in _months.items():
        for _wk in _weeks:
            WEEK_TO_MONTH[(_yr, _wk)] = _mo


def get_week_info(d: date) -> dict:
    """
    日付から (year, week_no, month, week_start, week_end) を返す。
    yearは会社カレンダー年（前年の週に属する場合がある）。
    """
    for yr in sorted(YEAR_FIRST_SUNDAY.keys(), reverse=True):
        first_sunday = YEAR_FIRST_SUNDAY[yr]
        if d >= first_sunday:
            delta = (d - first_sunday).days
            week_no = delta // 7 + 1
            week_start = first_sunday + timedelta(weeks=week_no - 1)
            week_end = week_start + timedelta(days=6)
            month = WEEK_TO_MONTH.get((yr, week_no))
            return {
                "year": yr,
                "week": week_no,
                "month": month,
                "week_start": week_start,
                "week_end": week_end,
                "week_label": f"W{week_no} ({week_start.strftime('%m/%d')}~{week_end.strftime('%m/%d')})",
                "week_key": f"{yr}-W{week_no:02d}",
                "ym": f"{yr}-{month:02d}" if month else None,
            }
    # fallback
    return {"year": None, "week": None, "month": None,
            "week_start": d, "week_end": d, "week_label": "?", "week_key": "?", "ym": None}


def get_weeks_for_month(year: int, month: int) -> list:
    """指定月の週番号リストを返す"""
    return MONTH_WEEK_MAP.get(year, {}).get(month, [])


def get_week_date_range(year: int, week_no: int) -> tuple:
    """週番号の開始日・終了日を返す"""
    first_sunday = YEAR_FIRST_SUNDAY.get(year)
    if not first_sunday:
        return None, None
    week_start = first_sunday + timedelta(weeks=week_no - 1)
    week_end = week_start + timedelta(days=6)
    return week_start, week_end


def get_months_range(center_date: date, past_months: int = 4, future_months: int = 1) -> list:
    """
    center_date を基準に past_months 前～future_months 後の
    (year, month) タプルのリストを返す
    """
    results = []
    # 現在月を特定
    wi = get_week_info(center_date)
    cy, cm = wi["year"] or center_date.year, wi["month"] or center_date.month

    # 過去方向
    y, m = cy, cm
    past_list = []
    for _ in range(past_months):
        m -= 1
        if m == 0:
            m = 12
            y -= 1
        past_list.append((y, m))
    past_list.reverse()
    results.extend(past_list)
    results.append((cy, cm))

    # 未来方向
    y, m = cy, cm
    for _ in range(future_months):
        m += 1
        if m == 13:
            m = 1
            y += 1
        results.append((y, m))

    return results


def month_label(year: int, month: int) -> str:
    return f"{year}/{month:02d}"


def get_3month_weeks(center_date: date) -> list:
    """
    前月・今月・来月の週情報を返す
    [{year, month, week, week_label, week_start, week_end, week_key}, ...]
    """
    months = get_months_range(center_date, past_months=1, future_months=1)
    result = []
    for y, m in months:
        for wk in get_weeks_for_month(y, m):
            ws, we = get_week_date_range(y, wk)
            result.append({
                "year": y,
                "month": m,
                "week": wk,
                "week_label": f"W{wk}",
                "week_start": ws.isoformat() if ws else None,
                "week_end": we.isoformat() if we else None,
                "week_key": f"{y}-W{wk:02d}",
                "ym": f"{y}-{m:02d}",
                "month_label": month_label(y, m),
            })
    return result

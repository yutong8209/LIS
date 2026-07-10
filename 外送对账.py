#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
外送对账：比对「外送机构汇总表」与「LIS 病人结果导出 CSV」

用法：
  python3 ~/脚本/外送对账.py
  python3 ~/脚本/外送对账.py --机构 ~/Downloads/外送机构汇总.xlsx --lis ~/Downloads/lis导出.csv
  python3 ~/脚本/外送对账.py --机构 a.xlsx --lis b.csv -o ~/Downloads/对账结果.xlsx

匹配策略（机构无医院检验号、条码也对不上时）：
  1) 患者姓名 + 日期（机构送检日 / LIS 核收日）
  2) 项目名模糊归一 + 内置别名表
  3) 金额：机构「标准物价」≈ 医院「报告费用/医嘱费用」（收费价）
     机构「结算金额」是机构结算折扣价，默认不与医院收费价直接比

输出工作表：
  使用说明 / 汇总 / 仅机构有 / 仅医院有 / 金额差异 / 项目差异 / 项目名对照
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import pandas as pd

# 机构项目名 → 医院常见项目/组合名（可继续往下加）
ITEM_ALIASES = {
    "微量元素检测5项": ["微量元素五项测定", "微量元素五项", "微量元素"],
    "铁三项": ["铁三项", "铁离子(Fe)测定", "总铁结合力(TiBC)测定", "不饱和铁结合力(UIBC)测定", "铁饱和度(ISAT)检测", "血清铁饱和度"],
    "N末端B型脑钠肽前体(NT-proBNP)测定": ["N端-B型钠尿肽前体", "脑利钠肽", "NT-proBNP", "N末端B型脑钠肽前体"],
    "N端-B型钠尿肽前体": ["N末端B型脑钠肽前体(NT-proBNP)测定", "脑利钠肽"],
    "25-羟基维生素D(VD(25-OH))测定": ["25羟基维生素D测定", "25-羟基维生素D[VD(25-OH)]", "25羟基维生素D"],
    "25羟基维生素D测定": ["25-羟基维生素D(VD(25-OH))测定", "25-羟基维生素D[VD(25-OH)]"],
    "血培养及鉴定": ["血培养及鉴定", "血培养（右）", "血培养（左）", "血培养(右)", "血培养(左)", "血培养"],
    "一般细菌培养及鉴定": ["一般细菌培养及鉴定", "一般细菌培养"],
    "喹硫平(Quetiapine)浓度测定": ["喹硫平", "喹硫平浓度测定"],
    "利培酮(Risperidone)浓度测定": ["利培酮", "利培酮浓度测定"],
    "奥卡西平(Oxcarbazepine)浓度测定": ["奥卡西平", "奥卡西平+10-羟基卡马西平", "奥卡西平浓度测定"],
    "卡马西平(CARB)浓度测定": ["卡马西平", "卡马西平浓度测定"],
    "阿立哌唑(Aripiprazole)浓度测定": ["阿立哌唑", "阿立哌唑浓度测定"],
    "氨磺必利(Amisulpride)浓度测定": ["氨磺必利", "氨磺必利浓度测定"],
    "齐拉西酮(Ziprasidone)浓度测定": ["齐拉西酮", "齐拉西酮浓度测定"],
    "乙型肝炎病毒DNA(HBV-DNA)测定": ["乙型肝炎病毒DNA", "HBV-DNA", "乙肝DNA"],
    "真菌(1、3)-β-D-葡聚糖检测(G试验)": ["真菌(1.3)-β-D-葡聚糖检测", "G试验", "真菌葡聚糖"],
    "血皮质醇(CORT)测定(8am)": ["血皮质醇(早8点)", "血皮质醇", "皮质醇"],
    "补体C3测定": ["补体C3"],
    "补体C4测定": ["补体C4"],
    "铜蓝蛋白(CER)测定": ["铜蓝蛋白"],
    "铁蛋白(FER)测定": ["铁蛋白"],
    "硒(Se)测定": ["硒"],
    "结核杆菌DNA(TB-DNA)检测": ["结核杆菌DNA", "TB-DNA"],
    "涂片找抗酸杆菌": ["涂片找抗酸杆菌", "结核菌涂片"],
    "哌罗匹隆(Perospirone)浓度测定": ["哌罗匹隆浓度测定", "哌罗匹隆"],
    "托吡酯(Topiramate)浓度测定": ["托吡酯浓度测定", "托吡酯"],
    "米那普仑(Milnacipran)浓度测定": ["米那普仑浓度测定", "米那普仑"],
    "药敏试验": ["血液药敏定性", "痰药敏定性", "尿液药敏定性", "药敏", "细菌一", "细菌二"],
    "痰培养及鉴定": ["痰培养", "痰培养及鉴定"],
    "尿培养及鉴定": ["尿培养", "尿培养及鉴定"],
}


def _norm_name(s: str) -> str:
    s = str(s or "").strip()
    if not s or s.lower() == "nan":
        return ""
    s = re.sub(r"[\(（][^）\)]*[\)）]", "", s)
    s = re.sub(r"(测定|检测|检验|定量|定性|浓度)", "", s)
    s = re.sub(r"[\s\-_/·•,，.。\[\]【】]", "", s)
    s = s.replace("（", "").replace("）", "").replace("(", "").replace(")", "")
    return s.lower()


def _build_alias_norm_map() -> dict[str, set[str]]:
    """归一名 → 一组等价归一名"""
    m: dict[str, set[str]] = {}
    for a, blist in ITEM_ALIASES.items():
        keys = {_norm_name(a), *(_norm_name(b) for b in blist)}
        keys.discard("")
        for k in keys:
            m.setdefault(k, set()).update(keys)
    return m


ALIAS_NORM = _build_alias_norm_map()


def _item_keys(name: str) -> set[str]:
    n = _norm_name(name)
    if not n:
        return set()
    return {n} | ALIAS_NORM.get(n, set())


def _read_tp(path: Path) -> pd.DataFrame:
    df = pd.read_excel(path, dtype=str)
    # 兼容首行即表头 / 无表头
    cols = {str(c).strip(): c for c in df.columns}
    rename = {}
    for want in ["送检单位", "送检日期", "患者", "条码号", "单项名称", "标准物价", "结算金额"]:
        if want in cols:
            rename[cols[want]] = want
        else:
            # 模糊找
            for c in df.columns:
                if want in str(c):
                    rename[c] = want
                    break
    df = df.rename(columns=rename)
    need = ["送检日期", "患者", "单项名称", "标准物价", "结算金额"]
    miss = [c for c in need if c not in df.columns]
    if miss:
        raise SystemExit(f"机构表缺少列: {miss}；实际列: {list(df.columns)}")
    if "条码号" not in df.columns:
        df["条码号"] = ""
    if "送检单位" not in df.columns:
        df["送检单位"] = ""

    df["患者"] = df["患者"].astype(str).str.strip().replace({"nan": ""})
    df["单项名称"] = df["单项名称"].astype(str).str.strip().replace({"nan": ""})
    df["条码号"] = (
        df["条码号"].astype(str).str.replace(r"\.0$", "", regex=True).str.strip().replace({"nan": ""})
    )
    df["日期"] = pd.to_datetime(df["送检日期"], errors="coerce").dt.normalize()
    df["标准物价"] = pd.to_numeric(df["标准物价"], errors="coerce").fillna(0.0)
    df["结算金额"] = pd.to_numeric(df["结算金额"], errors="coerce").fillna(0.0)
    df = df[df["患者"].ne("") & df["日期"].notna()].copy()
    df["来源"] = "机构"
    df["nk"] = df["单项名称"].map(_norm_name)
    return df.reset_index(drop=True)


def _read_lis(path: Path) -> pd.DataFrame:
    last_err = None
    df = None
    for enc in ("utf-8-sig", "utf-8", "gbk", "gb18030"):
        try:
            df = pd.read_csv(path, encoding=enc, dtype=str)
            break
        except Exception as e:
            last_err = e
    if df is None:
        raise SystemExit(f"无法读取 LIS CSV: {last_err}")

    # 仅外送（若有工作组列）
    if "工作组" in df.columns:
        wg = df["工作组"].astype(str)
        if (wg == "外送").any():
            df = df[wg == "外送"].copy()

    for c, default in [
        ("姓名", ""),
        ("项目", ""),
        ("组合", ""),
        ("检验号", ""),
        ("核收时间", ""),
        ("报告费用", "0"),
        ("医嘱费用", "0"),
        ("报告状态", ""),
        ("仪器", ""),
    ]:
        if c not in df.columns:
            df[c] = default

    df["姓名"] = df["姓名"].astype(str).str.strip().replace({"nan": ""})
    df["项目"] = df["项目"].astype(str).str.strip().replace({"nan": ""})
    df["组合"] = df["组合"].astype(str).str.strip().replace({"nan": ""})
    df["检验号"] = df["检验号"].astype(str).str.strip().replace({"nan": ""})
    df["日期"] = pd.to_datetime(df["核收时间"], errors="coerce").dt.normalize()
    df["报告费用"] = pd.to_numeric(df["报告费用"], errors="coerce").fillna(0.0)
    df["医嘱费用"] = pd.to_numeric(df["医嘱费用"], errors="coerce").fillna(0.0)
    df = df[df["姓名"].ne("") & df["日期"].notna()].copy()
    df["来源"] = "医院LIS"
    df["nk"] = df["项目"].map(_norm_name)
    df["nk_set"] = df["组合"].map(_norm_name)
    return df.reset_index(drop=True)


def _patient_day_agg_tp(tp: pd.DataFrame) -> pd.DataFrame:
    g = (
        tp.groupby(["患者", "日期"], as_index=False)
        .agg(
            机构标准物价=("标准物价", "sum"),
            机构结算金额=("结算金额", "sum"),
            机构明细条数=("单项名称", "count"),
            机构条码数=("条码号", "nunique"),
            机构项目=("单项名称", lambda s: "；".join(sorted(set(map(str, s))))),
        )
        .rename(columns={"患者": "姓名"})
    )
    return g


def _patient_day_agg_lis(lis: pd.DataFrame) -> pd.DataFrame:
    # 报告费用按检验号去重；医嘱费用按 检验号+组合 去重后再按患者日汇总
    by_lab = lis.drop_duplicates("检验号")[["姓名", "日期", "检验号", "报告费用"]].copy()
    by_ts = lis.drop_duplicates(["检验号", "组合"])[["姓名", "日期", "检验号", "组合", "医嘱费用"]].copy()
    g1 = by_lab.groupby(["姓名", "日期"], as_index=False).agg(
        医院报告费用=("报告费用", "sum"),
        医院标本数=("检验号", "nunique"),
    )
    g2 = by_ts.groupby(["姓名", "日期"], as_index=False).agg(
        医院医嘱费用=("医嘱费用", "sum"),
        医院组合数=("组合", "count"),
    )
    items = (
        lis.groupby(["姓名", "日期"], as_index=False)
        .agg(医院项目=("项目", lambda s: "；".join(sorted(set(x for x in map(str, s) if x and x != "nan")))))
    )
    return g1.merge(g2, on=["姓名", "日期"], how="outer").merge(items, on=["姓名", "日期"], how="outer")


def _items_match(tp_name: str, lis_item: str, lis_set: str) -> bool:
    a = _item_keys(tp_name)
    if not a:
        return False
    b = _item_keys(lis_item) | _item_keys(lis_set)
    return bool(a & b)


def compare(tp: pd.DataFrame, lis: pd.DataFrame, day_slack: int = 0) -> dict[str, pd.DataFrame]:
    tp_day = _patient_day_agg_tp(tp)
    lis_day = _patient_day_agg_lis(lis)

    # 精确日匹配
    merged = tp_day.merge(lis_day, on=["姓名", "日期"], how="outer", indicator=True)
    only_tp = merged[merged["_merge"] == "left_only"].drop(columns=["_merge"]).copy()
    only_lis = merged[merged["_merge"] == "right_only"].drop(columns=["_merge"]).copy()
    both = merged[merged["_merge"] == "both"].drop(columns=["_merge"]).copy()

    # 可选：日期 ±N 日补漏（先不做复杂再匹配，默认 0；有需要再开）
    if day_slack > 0 and (len(only_tp) or len(only_lis)):
        # 简单：把仅机构侧与仅医院侧按姓名、|日差|<=slack 再撮合一次
        extra_rows = []
        ot = only_tp.copy()
        ol = only_lis.copy()
        used_tp = set()
        used_lis = set()
        for i, r in ot.iterrows():
            cands = ol[
                (ol["姓名"] == r["姓名"])
                & ((ol["日期"] - r["日期"]).abs() <= pd.Timedelta(days=day_slack))
            ]
            if cands.empty:
                continue
            j = cands.iloc[0].name
            if j in used_lis:
                continue
            used_tp.add(i)
            used_lis.add(j)
            row = {**r.to_dict(), **{k: cands.iloc[0][k] for k in lis_day.columns if k not in ("姓名", "日期")}}
            row["日期说明"] = f"机构{r['日期'].date()} / 医院{cands.iloc[0]['日期'].date()}"
            extra_rows.append(row)
        if extra_rows:
            both = pd.concat([both, pd.DataFrame(extra_rows)], ignore_index=True)
            only_tp = ot.drop(index=list(used_tp))
            only_lis = ol.drop(index=list(used_lis))

    both["费用差_标准减医院"] = both["机构标准物价"].fillna(0) - both["医院报告费用"].fillna(0)
    both["是否金额一致"] = both["费用差_标准减医院"].abs().lt(0.02).map({True: "是", False: "否"})
    amt_diff = both[both["是否金额一致"] == "否"].sort_values("费用差_标准减医院", key=lambda s: s.abs(), ascending=False)

    # 项目级：在共有患者日内做模糊匹配
    tp_keys = set(zip(tp["患者"], tp["日期"]))
    lis_keys = set(zip(lis["姓名"], lis["日期"]))
    common_pd = tp_keys & lis_keys

    # 建 LIS 索引：姓名+日期 → rows
    lis_groups: dict[tuple, list[int]] = {}
    for i, r in lis.iterrows():
        lis_groups.setdefault((r["姓名"], r["日期"]), []).append(i)

    matched_tp = set()
    matched_lis = set()
    match_rows = []
    for (name, day) in common_pd:
        tsub = tp[(tp["患者"] == name) & (tp["日期"] == day)]
        lidx = lis_groups.get((name, day), [])
        used_local = set()
        for ti, tr in tsub.iterrows():
            hit = None
            for li in lidx:
                if li in used_local:
                    continue
                lr = lis.loc[li]
                if _items_match(tr["单项名称"], lr["项目"], lr["组合"]):
                    hit = li
                    break
            if hit is None:
                continue
            used_local.add(hit)
            matched_tp.add(ti)
            matched_lis.add(hit)
            lr = lis.loc[hit]
            hosp_fee = float(lr["医嘱费用"] or 0) or float(lr["报告费用"] or 0)
            match_rows.append(
                {
                    "姓名": name,
                    "日期": day,
                    "机构项目": tr["单项名称"],
                    "机构标准物价": tr["标准物价"],
                    "机构结算金额": tr["结算金额"],
                    "机构条码": tr["条码号"],
                    "医院项目": lr["项目"],
                    "医院组合": lr["组合"],
                    "医院检验号": lr["检验号"],
                    "医院医嘱费用": lr["医嘱费用"],
                    "医院报告费用": lr["报告费用"],
                    "费用差_标准减医嘱": float(tr["标准物价"]) - hosp_fee,
                }
            )

    item_matched = pd.DataFrame(match_rows)
    tp_only_items = tp.loc[~tp.index.isin(matched_tp)].copy()
    lis_only_items = lis.loc[~lis.index.isin(matched_lis)].copy()

    # 仅共有患者日内的未匹配项更有对账意义
    def in_common(df, name_col):
        return df[df.apply(lambda r: (r[name_col], r["日期"]) in common_pd, axis=1)] if len(df) else df

    tp_miss = in_common(tp_only_items, "患者")
    lis_miss = in_common(lis_only_items, "姓名")

    item_diff_tp = tp_miss[
        ["患者", "日期", "条码号", "单项名称", "标准物价", "结算金额"]
    ].rename(columns={"患者": "姓名", "单项名称": "项目", "标准物价": "金额"}).assign(侧="仅机构有项目")
    item_diff_lis = lis_miss[
        ["姓名", "日期", "检验号", "项目", "组合", "医嘱费用", "报告费用", "报告状态"]
    ].assign(侧="仅医院有项目")

    # 项目名对照
    tp_names = sorted(tp["单项名称"].dropna().unique())
    lis_names = sorted(set(lis["项目"].dropna().unique()) | set(lis["组合"].dropna().unique()))
    map_rows = []
    for t in tp_names:
        hits = [l for l in lis_names if _items_match(t, l, "")]
        map_rows.append(
            {
                "机构项目": t,
                "归一名": _norm_name(t),
                "是否匹配到医院名": "是" if hits else "否",
                "医院侧对应名": "；".join(hits[:8]),
            }
        )
    name_map = pd.DataFrame(map_rows).sort_values(["是否匹配到医院名", "机构项目"])

    # 汇总
    summary = pd.DataFrame(
        [
            {"指标": "机构明细行数", "数值": len(tp)},
            {"指标": "机构条码数", "数值": tp["条码号"].nunique()},
            {"指标": "机构患者日数", "数值": len(tp_day)},
            {"指标": "机构标准物价合计", "数值": round(tp["标准物价"].sum(), 2)},
            {"指标": "机构结算金额合计", "数值": round(tp["结算金额"].sum(), 2)},
            {"指标": "医院明细行数", "数值": len(lis)},
            {"指标": "医院检验号数", "数值": lis["检验号"].nunique()},
            {"指标": "医院患者日数", "数值": len(lis_day)},
            {"指标": "医院报告费用合计(按检验号去重)", "数值": round(lis.drop_duplicates("检验号")["报告费用"].sum(), 2)},
            {"指标": "医院医嘱费用合计(按检验号+组合去重)", "数值": round(lis.drop_duplicates(["检验号", "组合"])["医嘱费用"].sum(), 2)},
            {"指标": "患者日双方都有", "数值": len(both)},
            {"指标": "患者日仅机构有", "数值": len(only_tp)},
            {"指标": "患者日仅医院有", "数值": len(only_lis)},
            {"指标": "患者日金额一致", "数值": int((both["是否金额一致"] == "是").sum()) if len(both) else 0},
            {"指标": "患者日金额不一致", "数值": int((both["是否金额一致"] == "否").sum()) if len(both) else 0},
            {
                "指标": "匹配患者日 标准物价-医院报告费用 差额合计",
                "数值": round(float(both["费用差_标准减医院"].sum()), 2) if len(both) else 0,
            },
            {"指标": "项目级模糊匹配成功(机构行)", "数值": len(item_matched)},
            {"指标": "共有患者日内 仅机构有的项目行", "数值": len(item_diff_tp)},
            {"指标": "共有患者日内 仅医院有的项目行", "数值": len(item_diff_lis)},
            {"指标": "机构日期范围", "数值": f"{tp['日期'].min().date()} ~ {tp['日期'].max().date()}"},
            {"指标": "医院日期范围", "数值": f"{lis['日期'].min().date()} ~ {lis['日期'].max().date()}"},
        ]
    )

    guide = pd.DataFrame(
        {
            "说明": [
                "本表自动比对「外送机构汇总」与「LIS 结果导出(外送)」。",
                "① 金额主口径：机构【标准物价】≈ 医院【报告费用】（收费价）。",
                "② 机构【结算金额】多为折扣结算价（本院样例约 25%），不要直接和报告费用比。",
                "③ 机构【条码号】与医院【检验号】不是同一套号，脚本用 姓名+日期(+项目名模糊) 对齐。",
                "④ 先看【汇总】和【金额差异】；再看【仅机构有/仅医院有】找漏送、漏登、跨日。",
                "⑤ 【项目差异】：同一患者同一天两边项目对不上的明细（名称不同或条数不同）。",
                "⑥ 【项目名对照】：机构名在医院侧找不到对应时，可把别名补进脚本 ITEM_ALIASES。",
                "⑦ LIS 导出时请选与机构单月相同日期，工作组勾「外送」，导出 CSV。",
                "⑧ 医院报告费用在结果导出里是「每个项目行都重复」，脚本已按检验号去重汇总。",
                "⑨ 常见差：跨日（送检日≠核收日）、一个条码拆多个检验号、组合计价 vs 细项计价、名称不一致。",
            ]
        }
    )

    # 格式化日期
    def fmt_dates(df: pd.DataFrame) -> pd.DataFrame:
        if df is None or df.empty:
            return df
        out = df.copy()
        for c in out.columns:
            if pd.api.types.is_datetime64_any_dtype(out[c]):
                out[c] = out[c].dt.strftime("%Y-%m-%d")
        return out

    return {
        "使用说明": guide,
        "汇总": summary,
        "仅机构有": fmt_dates(only_tp.sort_values(["日期", "姓名"])),
        "仅医院有": fmt_dates(only_lis.sort_values(["日期", "姓名"])),
        "金额差异": fmt_dates(amt_diff),
        "患者日对照": fmt_dates(both.sort_values(["日期", "姓名"])),
        "项目匹配成功": fmt_dates(item_matched),
        "项目差异_仅机构": fmt_dates(item_diff_tp),
        "项目差异_仅医院": fmt_dates(item_diff_lis),
        "项目名对照": name_map,
    }


def _pick_files_gui():
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception:
        return None, None, None
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    tp = filedialog.askopenfilename(
        title="选择【外送机构汇总】Excel",
        filetypes=[("Excel", "*.xlsx *.xls"), ("All", "*.*")],
    )
    if not tp:
        return None, None, None
    lis = filedialog.askopenfilename(
        title="选择【LIS 结果导出】CSV",
        filetypes=[("CSV", "*.csv"), ("All", "*.*")],
    )
    if not lis:
        return None, None, None
    out = filedialog.asksaveasfilename(
        title="保存对账结果",
        defaultextension=".xlsx",
        initialfile="外送对账结果.xlsx",
        filetypes=[("Excel", "*.xlsx")],
    )
    root.destroy()
    return tp, lis, out


def main(argv=None):
    ap = argparse.ArgumentParser(description="外送机构汇总 vs LIS 结果导出 对账")
    ap.add_argument("--机构", dest="tp", help="外送机构汇总 xlsx")
    ap.add_argument("--lis", dest="lis", help="LIS 病人结果导出 csv")
    ap.add_argument("-o", "--输出", dest="out", help="对账结果 xlsx 路径")
    ap.add_argument("--日期容差", dest="slack", type=int, default=1, help="姓名匹配时允许的日差（送检日与核收日偏差），默认 1")
    args = ap.parse_args(argv)

    tp_path, lis_path, out_path = args.tp, args.lis, args.out
    if not tp_path or not lis_path:
        g_tp, g_lis, g_out = _pick_files_gui()
        tp_path = tp_path or g_tp
        lis_path = lis_path or g_lis
        out_path = out_path or g_out

    if not tp_path or not lis_path:
        # 尝试 Downloads 默认文件名
        dl = Path.home() / "Downloads"
        cand_tp = list(dl.glob("*外送*汇总*.xlsx")) + list(dl.glob("外送机构汇总.xlsx"))
        cand_lis = list(dl.glob("*lis*导出*.csv")) + list(dl.glob("*结果*.csv")) + list(dl.glob("lis*.csv"))
        if not tp_path and cand_tp:
            tp_path = str(sorted(cand_tp, key=lambda p: p.stat().st_mtime, reverse=True)[0])
            print("自动选用机构表:", tp_path)
        if not lis_path and cand_lis:
            lis_path = str(sorted(cand_lis, key=lambda p: p.stat().st_mtime, reverse=True)[0])
            print("自动选用 LIS 导出:", lis_path)

    if not tp_path or not lis_path:
        print("请指定 --机构 与 --lis，或在弹窗中选择文件。", file=sys.stderr)
        return 2

    tp_path = Path(tp_path).expanduser()
    lis_path = Path(lis_path).expanduser()
    if not out_path:
        out_path = tp_path.parent / f"外送对账结果_{pd.Timestamp.now():%Y%m%d_%H%M%S}.xlsx"
    else:
        out_path = Path(out_path).expanduser()

    print("读取机构表:", tp_path)
    tp = _read_tp(tp_path)
    print("读取 LIS 导出:", lis_path)
    lis = _read_lis(lis_path)
    print(f"机构 {len(tp)} 行 / LIS {len(lis)} 行，开始比对…")
    sheets = compare(tp, lis, day_slack=args.slack)

    with pd.ExcelWriter(out_path, engine="openpyxl") as w:
        for name, df in sheets.items():
            if df is None:
                df = pd.DataFrame()
            df.to_excel(w, sheet_name=name[:31], index=False)

    print("已生成:", out_path)
    s = sheets["汇总"]
    print(s.to_string(index=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

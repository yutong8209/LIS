#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
外送对账：比对「外送机构汇总表」与「LIS 病人结果导出 CSV」

用法：
  python3 ~/脚本/外送对账.py
  # 弹窗 ⌘ 多选：机构 xlsx + LIS csv（LIS 日期范围建议比机构单更宽）
  python3 ~/脚本/外送对账.py --机构 ~/Downloads/外送机构汇总.xlsx --lis ~/Downloads/lis导出.csv

核心目的（默认「少收」模式）：
  机构汇总表 = 固定基准
  医院 LIS 导出 = 对照（日期可更宽，不要求起止一致）
  只找：机构有、医院没有 → 估算医院少收多少
  不管：医院有、机构没有（损失不由我院承担）

匹配：姓名 + 项目名模糊/别名；日期只作参考（优先近的），不强制同一天。
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import pandas as pd

try:
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter
except ImportError:
    Workbook = None  # type: ignore

# 机构项目名 → 本院可接受的项目/组合名（单向，禁止共用套餐名把不同细项串在一起）
# 注意：不要把「贫血标志物」「铁三项」同时挂到多个互不相同的细项上（会交叉误匹配）
ITEM_ALIASES = {
    # 培养 / 药敏 / 涂片
    "血培养及鉴定": ["血培养及鉴定", "血培养（右）", "血培养（左）", "血培养(右)", "血培养(左)", "血培养"],
    "痰培养及鉴定": ["痰培养", "痰培养及鉴定"],
    "尿培养及鉴定": ["尿培养", "尿培养及鉴定"],
    "粪便培养及鉴定": ["粪便培养", "大便培养", "粪便培养(沙门氏菌、志贺氏菌)"],
    "一般细菌培养及鉴定": ["一般细菌培养", "一般细菌培养及鉴定"],
    # 本院血培养报告里「细菌一/二」常为培养鉴定/药敏结果行；血液药敏定性为独立药敏单
    "药敏试验": [
        "血液药敏定性", "痰药敏定性", "尿液药敏定性", "一般细菌药敏", "药敏",
        "细菌一", "细菌二",
    ],
    "涂片找抗酸杆菌": ["涂片找抗酸杆菌", "结核菌涂片"],
    # 感染 / DNA / 真菌
    "结核杆菌DNA(TB-DNA)检测": ["结核杆菌DNA", "TB-DNA", "各类病原体DNA测定", "各类病原体DNA测定（定性）", "各类病原体DNA测定（定量）"],
    "结核感染T细胞(TB-IGRA)检测": ["结核感染T细胞斑点检测", "结核感染T细胞检测判断", "TB-IGRA", "IGRA"],
    "乙型肝炎病毒DNA(HBV-DNA)测定": ["乙型肝炎DNA", "乙型肝炎DNA检测", "HBV-DNA", "乙肝DNA"],
    "真菌(1、3)-β-D-葡聚糖检测(G试验)": ["真菌(1.3)-β-D-葡聚糖检测", "G试验"],
    "曲霉菌半乳甘露聚糖检测(GM试验)": ["曲霉菌半乳甘露聚糖检测", "GM试验"],
    # 贫血三项（各自只对应本院同名细项，不共用贫血标志物以免交叉）
    "维生素B12(Vit B12)测定": ["血清维生素B12", "维生素B12", "VitB12"],
    "维生素B12测定": ["血清维生素B12", "维生素B12"],
    "叶酸(FOL)测定": ["叶酸", "血清叶酸"],
    "叶酸测定": ["叶酸", "血清叶酸"],
    "铁蛋白(FER)测定": ["铁蛋白", "血清铁蛋白"],
    "铁蛋白测定": ["铁蛋白", "血清铁蛋白"],
    # 铁三项细项
    "铁离子(Fe)测定": ["血清铁离子", "铁测定", "微量元素铁测定", "全血铁", "铁离子"],
    "总铁结合力(TiBC)测定": ["血清总铁结合力测定", "总铁结合力", "TiBC"],
    "不饱和铁结合力(UIBC)测定": ["血清不饱和铁结合力", "不饱和铁结合力", "UIBC"],
    "铁饱和度(ISAT)检测": ["血清铁饱和度", "铁饱和度", "ISAT"],
    # 微量元素
    "微量元素检测5项": ["微量元素五项测定", "微量元素五项"],
    "硒(Se)测定": ["硒", "微量元素硒测定"],
    "碘(I)测定": ["血清碘", "微量元素碘测定", "碘"],
    # 生化 / 免疫
    "N末端B型脑钠肽前体(NT-proBNP)测定": ["N端-B型钠尿肽前体", "脑利钠肽", "NT-proBNP"],
    "25-羟基维生素D(VD(25-OH))测定": ["25羟基维生素D测定", "25-羟基维生素D[VD(25-OH)]", "25羟基维生素D"],
    "补体C3测定": ["补体C3"],
    "补体C4测定": ["补体C4"],
    "铜蓝蛋白(CER)测定": ["铜蓝蛋白"],
    "空腹C肽(C-P)测定": ["空腹C肽", "C肽"],
    "促甲状腺受体抗体(TR-Ab)测定": ["促甲状腺受体抗体", "促甲状腺激素受体抗体", "TR-Ab", "TRAb"],
    "血皮质醇(CORT)测定(8am)": ["血皮质醇(早8点)", "血皮质醇", "皮质醇"],
    "抗核抗体检测14项": [
        "免疫测定", "抗核抗体", "抗核小体抗体", "抗U1nRNP抗体", "抗U1nRNP抗体[U1nRNP]",
        "抗Sm抗体", "抗Sm抗体[Sm]", "抗SS-A抗体", "抗SS-A抗体[SS-A]", "抗SS-B抗体", "抗SS-B抗体[SS-B]",
        "抗JO-1抗体", "抗JO-1抗体[Jo-1]", "抗ScL-70抗体", "抗ScL-70抗体[SCL-70]",
        "抗Ro52抗体", "抗Ro52抗体[Ro52]", "抗组蛋白抗体", "抗线粒体抗体Ⅱ型",
        "抗增殖细胞核抗原抗体", "抗CENP-B蛋白抗体", "抗PM-Scl抗体", "抗核糖体P蛋白抗体",
    ],
    # 精神药 / 抗癫痫药浓度
    "喹硫平(Quetiapine)浓度测定": ["喹硫平"],
    "利培酮(Risperidone)浓度测定": ["利培酮", "利培酮+9-羟基利培酮", "9-羟基利培酮"],
    "奥氮平(Olanza)浓度测定": ["奥氮平"],
    "奥卡西平(Oxcarbazepine)浓度测定": ["奥卡西平", "奥卡西平+10-羟基卡马西平", "10-羟基卡马西平"],
    "卡马西平(CARB)浓度测定": ["卡马西平"],  # 不要配到奥卡西平组合
    "阿立哌唑(Aripiprazole)浓度测定": ["阿立哌唑", "阿立哌唑+脱氢阿立哌唑", "脱氢阿立哌唑"],
    "氨磺必利(Amisulpride)浓度测定": ["氨磺必利"],
    "齐拉西酮(Ziprasidone)浓度测定": ["齐拉西酮"],
    "氯氮平(CLZ)浓度测定": ["氯氮平"],
    "丙戊酸(VPA)浓度测定": ["丙戊酸"],
    "帕利哌酮(Paliperidone)浓度测定": ["帕利哌酮"],
    "哌罗匹隆(Perospirone)浓度测定": ["哌罗匹隆", "哌罗匹隆浓度测定"],
    "托吡酯(Topiramate)浓度测定": ["托吡酯", "托吡酯浓度测定"],
    "米那普仑(Milnacipran)浓度测定": ["米那普仑", "米那普仑浓度测定"],
    "文拉法辛(Venlafaxine)浓度测定": ["文拉法辛", "去甲文拉法辛+0-去甲文拉法辛", "O-去甲文拉法辛", "0-去甲文拉法辛"],
    "氟西汀+去甲氟西汀(Fluoxetine+ norfluoxetine)浓度测定": ["氟西汀", "氟西汀+去甲氟西汀", "去甲氟西汀"],
    "氟伏沙明(Fluvoxamine)浓度测定": ["氟伏沙明"],
    "舍曲林(Sertraline)浓度测定": ["舍曲林"],
    "艾司西酞普兰(Escitalopram)浓度测定": ["艾司西酞普兰"],
    "左乙拉西坦(Levetiracetam)浓度测定": ["左乙拉西坦"],
    "布南色林(Blonaserin)浓度测定": ["布南色林"],
    "吡仑帕奈(Perampanel)浓度测定": ["吡仑帕奈"],
}


def _norm_name(s: str) -> str:
    s = str(s or "").strip()
    if not s or s.lower() == "nan":
        return ""
    # 先保留左右侧标记，避免「血培养（右）」被收成「血培养」后与组合行误等同
    s = re.sub(r"[（(]([左右上下])[)）]", r"\1", s)
    s = re.sub(r"[\(（][^）\)]*[\)）]", "", s)
    s = re.sub(r"\[[^\]]*\]", "", s)
    s = re.sub(r"(测定|检测|检验|定量|定性|浓度|及鉴定)", "", s)
    s = re.sub(r"[\s\-_/·•,，.。+＋]", "", s)
    s = s.replace("（", "").replace("）", "").replace("(", "").replace(")", "")
    s = s.replace("β", "β").replace("Β", "β")
    return s.lower()


def _alias_targets_for_institution(inst_name: str) -> set[str]:
    """机构项目 → 可接受的医院归一名集合（单向，不反向污染）。"""
    out = {_norm_name(inst_name)}
    inst_n = _norm_name(inst_name)
    for key, blist in ITEM_ALIASES.items():
        kn = _norm_name(key)
        if not kn:
            continue
        # 键完全相等，或机构名与键互相包含（长度够长）
        if kn == inst_n or (len(kn) >= 3 and len(inst_n) >= 3 and (kn in inst_n or inst_n in kn)):
            out.add(kn)
            for b in blist:
                bn = _norm_name(b)
                if bn:
                    out.add(bn)
    # 常见前缀：血清/全血
    if inst_n:
        if not inst_n.startswith("血清"):
            out.add("血清" + inst_n)
        if inst_n.startswith("血清"):
            out.add(inst_n[2:])
    out.discard("")
    return out


def _item_keys(name: str) -> set[str]:
    """兼容旧调用：医院侧键仅自身归一化（不再做反向别名合并）。"""
    n = _norm_name(name)
    return {n} if n else set()


def _score_one_side(inst_name: str, hosp_name: str) -> int:
    """机构名 vs 单个医院字段（项目 或 组合）。"""
    an = _norm_name(inst_name)
    bn = _norm_name(hosp_name)
    if not an or not bn:
        return 0
    targets = _alias_targets_for_institution(inst_name)
    if an == bn:
        return 100
    if bn in targets:
        return 90
    if bn == "血清" + an or bn == "全血" + an:
        return 85
    if bn.startswith("血清") and bn[2:] == an:
        return 85
    # 仅允许医院名以机构名开头（血培养→血培养左）；禁止 endswith（卡马西平≠羟基卡马西平）
    if len(an) >= 3 and bn.startswith(an):
        return 80
    if len(bn) >= 3 and an.startswith(bn) and len(bn) / max(len(an), 1) >= 0.7:
        return 75
    if an in ("碘", "硒", "铜", "锌", "钙", "镁") and (bn == an or an in bn):
        return 88
    return 0


def match_score(inst_name: str, lis_item: str, lis_set: str = "") -> int:
    """
    优先「项目」列命中。
    - 血培养只认项目名是培养，不靠组合去抢「细菌一」
    - 药敏可认「血液药敏定性」或培养单上的「细菌一/二」
    """
    si = _score_one_side(inst_name, lis_item)
    ss = _score_one_side(inst_name, lis_set)
    inst_n = _norm_name(inst_name)
    item_n = _norm_name(lis_item)

    # 机构=血培养：禁止仅靠组合命中去匹配「细菌一/二」行
    if "血培养" in inst_n or inst_n.endswith("培养"):
        if item_n in ("细菌一", "细菌二"):
            return 0
        if si >= 70:
            return si + 5
        # 组合命中且项目也是培养相关才行
        if ss >= 70 and ("培养" in item_n or item_n == inst_n):
            return max(ss - 10, 70)
        return si if si >= 70 else 0

    if si >= 70:
        return si + 5
    if ss >= 70:
        return max(ss - 15, 70)
    return max(si, ss)


def _items_match(tp_name: str, lis_item: str, lis_set: str) -> bool:
    """是否可视为同一项目（阈值 70）。"""
    return match_score(tp_name, lis_item, lis_set) >= 70


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
    """机构项目名 vs 医院项目/组合：别名集合相交，或归一化后互相包含。"""
    a = _item_keys(tp_name)
    if not a:
        return False
    b = _item_keys(lis_item) | _item_keys(lis_set)
    if a & b:
        return True
    # 归一化互相包含：维生素b12 ⊂ 血清维生素b12；粪便培养 ⊂ 粪便培养沙门…
    an = _norm_name(tp_name)
    candidates = {_norm_name(lis_item), _norm_name(lis_set)} | b
    candidates.discard("")
    if not an:
        return False
    for bn in candidates:
        if not bn:
            continue
        if len(an) >= 3 and len(bn) >= 3 and (an in bn or bn in an):
            return True
        # 微量元素单字（碘/硒等）
        if an in ("碘", "硒", "铜", "锌", "铁", "钙", "镁") and an in bn:
            return True
    return False


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


def _classify_input_paths(paths):
    """按扩展名区分机构表(xlsx/xls) 与 LIS 导出(csv)。"""
    tp_paths, lis_paths, other = [], [], []
    for p in paths:
        if not p:
            continue
        path = Path(p)
        ext = path.suffix.lower()
        if ext in (".xlsx", ".xls", ".xlsm"):
            tp_paths.append(path)
        elif ext == ".csv":
            lis_paths.append(path)
        else:
            other.append(path)
    return tp_paths, lis_paths, other


def _pick_files_gui():
    """
    少收模式选文件：
    一次弹窗 ⌘ 多选 机构汇总(xlsx) + LIS 导出(csv)。
    默认打开「下载」文件夹。
    """
    try:
        import tkinter as tk
        from tkinter import filedialog, messagebox
    except Exception:
        return [], [], None

    dl = Path.home() / "Downloads"
    if not dl.is_dir():
        dl = Path.home() / "下载"
    if not dl.is_dir():
        dl = Path.home()
    initial = str(dl)

    root = tk.Tk()
    root.withdraw()
    try:
        root.attributes("-topmost", True)
    except Exception:
        pass

    messagebox.showinfo(
        "外送少收分析",
        "请同时选择两类文件（⌘ 多选）：\n\n"
        "1. 外送机构汇总表（.xlsx）—— 基准\n"
        "2. LIS 病人结果导出（.csv）—— 日期建议比机构单更宽\n\n"
        "只统计「机构有、医院没有」的少收；\n"
        "医院多出来的不统计。",
    )

    paths = filedialog.askopenfilenames(
        title="少收分析：⌘ 多选【机构汇总 xlsx】+【LIS 导出 csv】",
        initialdir=initial,
        filetypes=[
            ("对账文件", "*.xlsx *.xls *.xlsm *.csv"),
            ("Excel 机构表", "*.xlsx *.xls *.xlsm"),
            ("CSV LIS导出", "*.csv"),
            ("所有文件", "*.*"),
        ],
    )
    if not paths:
        root.destroy()
        return [], [], None

    tp_paths, lis_paths, other = _classify_input_paths(paths)
    if other:
        messagebox.showwarning(
            "未识别的文件",
            "以下文件扩展名无法识别，已忽略：\n" + "\n".join(str(p.name) for p in other),
        )
    if not tp_paths or not lis_paths:
        if not tp_paths:
            extra = filedialog.askopenfilenames(
                title="还缺【机构汇总】Excel（基准账单）",
                initialdir=initial,
                filetypes=[("Excel", "*.xlsx *.xls *.xlsm"), ("所有文件", "*.*")],
            )
            tp_paths, _, _ = _classify_input_paths(list(extra or []))
        if not lis_paths:
            extra = filedialog.askopenfilenames(
                title="还缺【LIS 结果导出】CSV（日期宜更宽）",
                initialdir=initial,
                filetypes=[("CSV", "*.csv"), ("所有文件", "*.*")],
            )
            _, lis_paths, _ = _classify_input_paths(list(extra or []))

    if not tp_paths or not lis_paths:
        messagebox.showerror(
            "文件不齐",
            "少收分析需要同时有：\n"
            "· 机构汇总 .xlsx（基准）\n"
            "· LIS 导出 .csv（对照，日期可更宽）\n\n"
            "请 ⌘ 多选两类文件后再试。",
        )
        root.destroy()
        return [], [], None

    stamp = pd.Timestamp.now().strftime("%Y%m%d_%H%M%S")
    out = filedialog.asksaveasfilename(
        title="保存少收分析表",
        initialdir=initial,
        defaultextension=".xlsx",
        initialfile=f"外送少收分析_{stamp}.xlsx",
        filetypes=[("Excel", "*.xlsx")],
    )
    root.destroy()
    return tp_paths, lis_paths, out or None


def _load_tp_many(paths):
    frames = []
    for p in paths:
        print("读取机构表:", p)
        frames.append(_read_tp(p))
    if not frames:
        raise SystemExit("未读到机构表")
    if len(frames) == 1:
        return frames[0]
    return pd.concat(frames, ignore_index=True)


def _load_lis_many(paths):
    frames = []
    for p in paths:
        print("读取 LIS 导出:", p)
        frames.append(_read_lis(p))
    if not frames:
        raise SystemExit("未读到 LIS 导出")
    if len(frames) == 1:
        return frames[0]
    return pd.concat(frames, ignore_index=True)


def _merge_patient_days_with_slack(
    tp: pd.DataFrame, lis: pd.DataFrame, day_slack: int = 1
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """返回 (both, only_tp_day, only_lis_day, all_merged)。日期允许 ±day_slack。"""
    tp_day = _patient_day_agg_tp(tp)
    lis_day = _patient_day_agg_lis(lis)
    merged = tp_day.merge(lis_day, on=["姓名", "日期"], how="outer", indicator=True)
    only_tp = merged[merged["_merge"] == "left_only"].drop(columns=["_merge"]).copy()
    only_lis = merged[merged["_merge"] == "right_only"].drop(columns=["_merge"]).copy()
    both = merged[merged["_merge"] == "both"].drop(columns=["_merge"]).copy()

    if day_slack > 0 and (len(only_tp) or len(only_lis)):
        extra_rows = []
        ot, ol = only_tp.copy(), only_lis.copy()
        used_tp, used_lis = set(), set()
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
            row = {**r.to_dict()}
            for k in lis_day.columns:
                if k not in ("姓名", "日期"):
                    row[k] = cands.iloc[0][k]
            row["日期说明"] = f"机构{r['日期'].date()} / 医院{cands.iloc[0]['日期'].date()}"
            extra_rows.append(row)
        if extra_rows:
            both = pd.concat([both, pd.DataFrame(extra_rows)], ignore_index=True)
            only_tp = ot.drop(index=list(used_tp))
            only_lis = ol.drop(index=list(used_lis))

    both = both.copy()
    both["机构标准物价"] = both["机构标准物价"].fillna(0)
    both["医院报告费用"] = both["医院报告费用"].fillna(0)
    both["差额"] = both["机构标准物价"] - both["医院报告费用"]
    both["状态"] = both["差额"].abs().lt(0.02).map({True: "金额一致", False: "金额不一致"})
    only_tp = only_tp.copy()
    only_tp["状态"] = "仅机构有"
    only_tp["机构标准物价"] = only_tp["机构标准物价"].fillna(0)
    only_tp["医院报告费用"] = 0
    only_tp["差额"] = only_tp["机构标准物价"]
    only_lis = only_lis.copy()
    only_lis["状态"] = "仅医院有"
    only_lis["医院报告费用"] = only_lis["医院报告费用"].fillna(0)
    only_lis["机构标准物价"] = 0
    only_lis["差额"] = -only_lis["医院报告费用"]

    all_m = pd.concat([both, only_tp, only_lis], ignore_index=True, sort=False)
    return both, only_tp, only_lis, all_m


def _presence_details(
    tp: pd.DataFrame, lis: pd.DataFrame, only_tp_day: pd.DataFrame, only_lis_day: pd.DataFrame, day_slack: int = 1
) -> dict[str, pd.DataFrame]:
    """
    有/无对照明细：
    - 机构有医院无：整日在机构侧、医院侧对不上的明细行
    - 医院有机构无：整日在医院侧、机构侧对不上的标本/结果行
    - 病人级：整个周期内姓名只出现在一侧
    - 同日缺项：两边都有该患者日，但某项目只在一侧
    """
    # --- 病人级（忽略日期）---
    tp_names = set(tp["患者"].astype(str))
    lis_names = set(lis["姓名"].astype(str))
    only_name_tp = sorted(tp_names - lis_names)
    only_name_lis = sorted(lis_names - tp_names)

    def _tp_patient_rows(names):
        if not names:
            return pd.DataFrame(columns=["姓名", "机构条数", "标准物价合计", "结算合计", "条码示例", "项目汇总", "日期范围"])
        sub = tp[tp["患者"].isin(names)]
        g = sub.groupby("患者", as_index=False).agg(
            机构条数=("单项名称", "count"),
            标准物价合计=("标准物价", "sum"),
            结算合计=("结算金额", "sum"),
            条码示例=("条码号", lambda s: "、".join(list(dict.fromkeys(x for x in s if x))[:5])),
            项目汇总=("单项名称", lambda s: "；".join(sorted(set(s))[:12])),
            最早=("日期", "min"),
            最晚=("日期", "max"),
        )
        g["日期范围"] = g.apply(
            lambda r: f"{r['最早'].date()}~{r['最晚'].date()}" if hasattr(r["最早"], "date") else "",
            axis=1,
        )
        return g.rename(columns={"患者": "姓名"})[
            ["姓名", "机构条数", "标准物价合计", "结算合计", "条码示例", "项目汇总", "日期范围"]
        ].sort_values("姓名")

    def _lis_patient_rows(names):
        if not names:
            return pd.DataFrame(columns=["姓名", "医院标本数", "报告费用合计", "检验号示例", "项目汇总", "日期范围"])
        sub = lis[lis["姓名"].isin(names)]
        by_lab = sub.drop_duplicates("检验号")
        g1 = by_lab.groupby("姓名", as_index=False).agg(
            医院标本数=("检验号", "nunique"),
            报告费用合计=("报告费用", "sum"),
            检验号示例=("检验号", lambda s: "、".join(list(dict.fromkeys(s.astype(str)))[:5])),
            最早=("日期", "min"),
            最晚=("日期", "max"),
        )
        g2 = sub.groupby("姓名", as_index=False).agg(
            项目汇总=("项目", lambda s: "；".join(sorted(set(x for x in s if x))[:12]))
        )
        g = g1.merge(g2, on="姓名", how="left")
        g["日期范围"] = g.apply(
            lambda r: f"{r['最早'].date()}~{r['最晚'].date()}" if hasattr(r["最早"], "date") else "",
            axis=1,
        )
        return g[["姓名", "医院标本数", "报告费用合计", "检验号示例", "项目汇总", "日期范围"]].sort_values("姓名")

    # --- 患者日仅一侧 → 展开明细 ---
    only_tp_keys = set(zip(only_tp_day["姓名"], only_tp_day["日期"])) if len(only_tp_day) else set()
    only_lis_keys = set(zip(only_lis_day["姓名"], only_lis_day["日期"])) if len(only_lis_day) else set()

    inst_only_lines = []
    for (name, day) in sorted(only_tp_keys, key=lambda x: (str(x[1]), x[0])):
        sub = tp[(tp["患者"] == name) & (tp["日期"] == day)]
        # 该姓名在医院 ±slack 是否有任何记录（跨日提示）
        near = lis[
            (lis["姓名"] == name)
            & ((lis["日期"] - day).abs() <= pd.Timedelta(days=max(day_slack, 3)))
        ]
        near_hint = ""
        if len(near):
            days = sorted({d.strftime("%Y-%m-%d") if hasattr(d, "strftime") else str(d)[:10] for d in near["日期"].unique()})
            near_hint = "医院附近有记录：" + "、".join(days[:5])
        else:
            near_hint = "医院同期未找到该病人外送记录"
        for _, r in sub.iterrows():
            inst_only_lines.append(
                {
                    "姓名": name,
                    "送检日期": day,
                    "条码号": r["条码号"],
                    "机构项目": r["单项名称"],
                    "标准物价": r["标准物价"],
                    "结算金额": r["结算金额"],
                    "说明": near_hint,
                }
            )
    df_inst_only = pd.DataFrame(inst_only_lines)

    hosp_only_lines = []
    for (name, day) in sorted(only_lis_keys, key=lambda x: (str(x[1]), x[0])):
        sub = lis[(lis["姓名"] == name) & (lis["日期"] == day)]
        near = tp[
            (tp["患者"] == name)
            & ((tp["日期"] - day).abs() <= pd.Timedelta(days=max(day_slack, 3)))
        ]
        if len(near):
            days = sorted({d.strftime("%Y-%m-%d") if hasattr(d, "strftime") else str(d)[:10] for d in near["日期"].unique()})
            near_hint = "机构附近有记录：" + "、".join(days[:5])
        else:
            near_hint = "机构账单同期未找到该病人"
        # 按检验号去重展示费用，项目列合并
        for labno, g in sub.groupby("检验号", sort=False):
            first = g.iloc[0]
            items = "；".join(sorted(set(g["项目"].astype(str)) | set(g["组合"].astype(str))))
            hosp_only_lines.append(
                {
                    "姓名": name,
                    "核收日期": day,
                    "检验号": labno,
                    "报告状态": first.get("报告状态", ""),
                    "报告费用": first["报告费用"],
                    "组合项目": items[:120],
                    "说明": near_hint,
                }
            )
    df_hosp_only = pd.DataFrame(hosp_only_lines)

    # --- 同日都有，但项目只在一侧（用 exact 共有日；slack 日也算共有）---
    # 共有：姓名在 both 里出现的机构日 / 医院日
    both_days_tp = set()
    both_days_lis = set()
    # rebuild both with slack from only sets complement
    tp_all_keys = set(zip(tp["患者"], tp["日期"]))
    lis_all_keys = set(zip(lis["姓名"], lis["日期"]))
    # 对每个机构行找是否有模糊项目匹配（姓名+日期±slack）
    matched_tp_idx = set()
    matched_lis_idx = set()
    lis_by_name: dict[str, list[int]] = {}
    for i, r in lis.iterrows():
        lis_by_name.setdefault(r["姓名"], []).append(i)

    for ti, tr in tp.iterrows():
        cands = lis_by_name.get(tr["患者"], [])
        hit = None
        for li in cands:
            if li in matched_lis_idx:
                continue
            lr = lis.loc[li]
            if abs((lr["日期"] - tr["日期"]).days) > day_slack:
                continue
            if _items_match(tr["单项名称"], lr["项目"], lr["组合"]):
                hit = li
                break
        if hit is not None:
            matched_tp_idx.add(ti)
            matched_lis_idx.add(hit)

    # 未匹配且「对方有该人该日附近」→ 同日缺项；否则若整日仅一侧已在上面列出
    item_only_tp = []
    for ti, tr in tp.iterrows():
        if ti in matched_tp_idx:
            continue
        if (tr["患者"], tr["日期"]) in only_tp_keys:
            continue  # 已在机构有医院无
        # 医院是否有该人 ±slack
        has_near = any(
            abs((lis.loc[li, "日期"] - tr["日期"]).days) <= day_slack
            for li in lis_by_name.get(tr["患者"], [])
        )
        if not has_near:
            continue
        item_only_tp.append(
            {
                "姓名": tr["患者"],
                "日期": tr["日期"],
                "侧": "仅机构有此项目",
                "项目": tr["单项名称"],
                "条码号或检验号": tr["条码号"],
                "金额": tr["标准物价"],
                "说明": "同人同日(±容差)医院有其它结果，但匹配不到该项目",
            }
        )

    item_only_lis = []
    for li, lr in lis.iterrows():
        if li in matched_lis_idx:
            continue
        if (lr["姓名"], lr["日期"]) in only_lis_keys:
            continue
        has_near = (
            ((tp["患者"] == lr["姓名"]) & ((tp["日期"] - lr["日期"]).abs() <= pd.Timedelta(days=day_slack))).any()
        )
        if not has_near:
            continue
        item_only_lis.append(
            {
                "姓名": lr["姓名"],
                "日期": lr["日期"],
                "侧": "仅医院有此项目",
                "项目": lr["项目"] or lr["组合"],
                "条码号或检验号": lr["检验号"],
                "金额": lr["医嘱费用"] or lr["报告费用"],
                "说明": "同人同日(±容差)机构有其它项目，但匹配不到该项",
            }
        )

    df_item_gap = pd.concat(
        [pd.DataFrame(item_only_tp), pd.DataFrame(item_only_lis)],
        ignore_index=True,
        sort=False,
    )
    if len(df_item_gap):
        df_item_gap = df_item_gap.sort_values(["日期", "姓名", "侧"])

    return {
        "病人仅机构有": _tp_patient_rows(only_name_tp),
        "病人仅医院有": _lis_patient_rows(only_name_lis),
        "机构有医院无_明细": df_inst_only,
        "医院有机构无_明细": df_hosp_only,
        "同日项目缺失": df_item_gap if len(df_item_gap) else pd.DataFrame(),
        "stats": {
            "病人仅机构": len(only_name_tp),
            "病人仅医院": len(only_name_lis),
            "机构日明细行": len(df_inst_only),
            "医院标本行": len(df_hosp_only),
            "同日缺项行": len(df_item_gap) if len(df_item_gap) else 0,
            "项目匹配成功": len(matched_tp_idx),
        },
    }


def write_clean_report(
    out_path: Path,
    tp: pd.DataFrame,
    lis: pd.DataFrame,
    sheets: dict,
    src_label: str = "",
    day_slack: int = 1,
) -> Path:
    """生成简洁对账分析表（金额 + 有/无对照）。"""
    if Workbook is None:
        raise SystemExit("需要 openpyxl：pip3 install openpyxl")

    both, only_tp_day, only_lis_day, merged = _merge_patient_days_with_slack(tp, lis, day_slack)
    presence = _presence_details(tp, lis, only_tp_day, only_lis_day, day_slack)

    tp_std = float(tp["标准物价"].sum())
    tp_settle = float(tp["结算金额"].sum())
    lis_fee = float(lis.drop_duplicates("检验号")["报告费用"].sum())
    delta = tp_std - lis_fee

    n_both = len(both)
    n_ok = int((both["状态"] == "金额一致").sum()) if n_both else 0
    n_amt = int((both["状态"] == "金额不一致").sum()) if n_both else 0
    n_only_tp = len(only_tp_day)
    n_only_lis = len(only_lis_day)
    abs_diff = float(both.loc[both["状态"] == "金额不一致", "差额"].abs().sum()) if n_amt else 0.0
    pst = presence["stats"]

    issues = merged[merged["状态"] != "金额一致"].copy()
    issues["_o"] = issues["状态"].map({"金额不一致": 0, "仅机构有": 1, "仅医院有": 2})
    issues["absd"] = issues["差额"].abs()
    issues = issues.sort_values(["_o", "absd"], ascending=[True, False])

    nmap = sheets.get("项目名对照", pd.DataFrame())

    thin = Border(
        left=Side(style="thin", color="D0D7DE"),
        right=Side(style="thin", color="D0D7DE"),
        top=Side(style="thin", color="D0D7DE"),
        bottom=Side(style="thin", color="D0D7DE"),
    )
    fill_title = PatternFill("solid", fgColor="0F766E")
    fill_head = PatternFill("solid", fgColor="CCFBF1")
    fill_ok = PatternFill("solid", fgColor="DCFCE7")
    fill_bad = PatternFill("solid", fgColor="FEE2E2")
    fill_warn = PatternFill("solid", fgColor="FEF3C7")
    fill_info = PatternFill("solid", fgColor="E0F2FE")
    fill_card = PatternFill("solid", fgColor="F0FDFA")
    font_title = Font(name="Microsoft YaHei", size=16, bold=True, color="FFFFFF")
    font_h = Font(name="Microsoft YaHei", size=11, bold=True, color="134E4A")
    font_n = Font(name="Microsoft YaHei", size=10, color="1F2937")
    font_big = Font(name="Microsoft YaHei", size=20, bold=True, color="0F766E")
    font_big_bad = Font(name="Microsoft YaHei", size=20, bold=True, color="B91C1C")
    font_muted = Font(name="Microsoft YaHei", size=9, color="6B7280")
    font_white = Font(name="Microsoft YaHei", size=10, bold=True, color="FFFFFF")
    center = Alignment(horizontal="center", vertical="center", wrap_text=True)
    left = Alignment(horizontal="left", vertical="center", wrap_text=True)
    money_fmt = "#,##0.00"

    def set_widths(ws, widths):
        for i, w in enumerate(widths, 1):
            ws.column_dimensions[get_column_letter(i)].width = w

    def fmt_date(v):
        if hasattr(v, "strftime"):
            return v.strftime("%Y-%m-%d")
        return str(v)[:10]

    wb = Workbook()

    # ---- 一眼看懂 ----
    ws = wb.active
    ws.title = "一眼看懂"
    ws.sheet_view.showGridLines = False
    set_widths(ws, [18, 16, 16, 16, 16, 16, 24, 14])

    ws.merge_cells("A1:H1")
    ws["A1"] = "外送对账 · 一眼看懂"
    ws["A1"].font = font_title
    ws["A1"].fill = fill_title
    ws["A1"].alignment = Alignment(horizontal="left", vertical="center")
    ws.row_dimensions[1].height = 36

    ws.merge_cells("A2:H2")
    ws["A2"] = (
        f"{src_label}　　日期容差：±1天　　生成：{pd.Timestamp.now():%Y-%m-%d %H:%M}　　"
        f"机构 {tp['日期'].min().date()}~{tp['日期'].max().date()}　"
        f"医院 {lis['日期'].min().date()}~{lis['日期'].max().date()}"
    )
    ws["A2"].font = font_muted

    ws.merge_cells("A4:B4")
    ws["A4"] = "机构标准物价合计"
    ws.merge_cells("C4:D4")
    ws["C4"] = "医院报告费用合计"
    ws.merge_cells("E4:F4")
    ws["E4"] = "两边差额（机构−医院）"
    ws.merge_cells("G4:H4")
    ws["G4"] = "结论"
    for col in ("A4", "C4", "E4", "G4"):
        ws[col].font = font_h
        ws[col].fill = fill_card
        ws[col].alignment = center

    ws.merge_cells("A5:B5")
    ws["A5"] = tp_std
    ws["A5"].number_format = money_fmt
    ws["A5"].font = font_big
    ws.merge_cells("C5:D5")
    ws["C5"] = lis_fee
    ws["C5"].number_format = money_fmt
    ws["C5"].font = font_big
    ws.merge_cells("E5:F5")
    ws["E5"] = delta
    ws["E5"].number_format = money_fmt
    ws["E5"].font = font_big if abs(delta) < 1 else font_big_bad
    if abs(delta) < 50 and n_amt <= 5:
        conclusion, cfill = "大体一致，仅少量明细需核实", fill_ok
    elif abs(delta) < 1000:
        conclusion, cfill = "总金额接近，差异集中在少数患者日", fill_warn
    else:
        conclusion, cfill = "总金额偏差较大，请先看「待核实清单」", fill_bad
    ws.merge_cells("G5:H5")
    ws["G5"] = conclusion
    ws["G5"].font = Font(name="Microsoft YaHei", size=12, bold=True)
    ws["G5"].fill = cfill
    for r in (4, 5):
        for c in range(1, 9):
            cell = ws.cell(row=r, column=c)
            cell.border = thin
            cell.alignment = center
            if r == 5 and c <= 6:
                cell.fill = fill_card
    ws.row_dimensions[5].height = 40

    ws.merge_cells("A6:H6")
    ws["A6"] = (
        f"比对口径：机构「标准物价」≈ 医院「报告费用」（收费价）。"
        f"机构「结算金额」合计 {tp_settle:,.2f} 元是折扣回款，不要和医院收费直接比。"
        f"条码号≠检验号，按 姓名+日期 对齐。"
    )
    ws["A6"].font = font_muted
    ws.row_dimensions[6].height = 30

    ws["A8"] = "金额匹配"
    ws["A8"].font = Font(name="Microsoft YaHei", size=12, bold=True, color="0F766E")
    headers = ["患者日双方都有", "其中金额一致", "其中金额不一致", "仅机构有(日)", "仅医院有(日)", "不一致金额合计(|差|)"]
    vals = [n_both, n_ok, n_amt, n_only_tp, n_only_lis, abs_diff]
    for i, h in enumerate(headers, 1):
        cell = ws.cell(row=9, column=i, value=h)
        cell.font = font_h
        cell.fill = fill_head
        cell.border = thin
        cell.alignment = center
    for i, v in enumerate(vals, 1):
        cell = ws.cell(row=10, column=i, value=v)
        cell.font = font_n
        cell.border = thin
        cell.alignment = center
        if i == 2:
            cell.fill = fill_ok
        if i == 3 and v:
            cell.fill = fill_bad
        if i in (4, 5) and v:
            cell.fill = fill_warn if i == 4 else fill_info
        if i == 6:
            cell.number_format = money_fmt
            cell.fill = fill_warn

    ws["A12"] = "有/无对照（谁多了谁少了）"
    ws["A12"].font = Font(name="Microsoft YaHei", size=12, bold=True, color="0F766E")
    h2 = ["病人只在机构", "病人只在医院", "机构有·医院无(明细行)", "医院有·机构无(标本)", "同日项目缺失", "项目模糊匹配成功"]
    v2 = [
        pst["病人仅机构"],
        pst["病人仅医院"],
        pst["机构日明细行"],
        pst["医院标本行"],
        pst["同日缺项行"],
        pst["项目匹配成功"],
    ]
    for i, h in enumerate(h2, 1):
        cell = ws.cell(row=13, column=i, value=h)
        cell.font = font_h
        cell.fill = fill_head
        cell.border = thin
        cell.alignment = center
    for i, v in enumerate(v2, 1):
        cell = ws.cell(row=14, column=i, value=v)
        cell.font = font_n
        cell.border = thin
        cell.alignment = center
        if v and i in (1, 3):
            cell.fill = fill_warn
        if v and i in (2, 4):
            cell.fill = fill_info
        if v and i == 5:
            cell.fill = fill_bad

    ws["A16"] = "怎么看"
    ws["A16"].font = Font(name="Microsoft YaHei", size=12, bold=True, color="0F766E")
    tips = [
        "1. 金额：看上方总差额 +「待核实清单」里红色「金额不一致」。",
        "2. 「机构有·医院无」：机构账单有、医院外送记录对不上（漏登/跨日/未进外送组）。",
        "3. 「医院有·机构无」：医院 LIS 有外送结果、机构表没有（下月账单/未结算/未送检）。",
        "4. 「同日项目缺失」：同一人差不多同一天两边都有，但某个项目只出现在一侧。",
        "5. 「病人只在…」：整个导出周期内姓名只出现在一侧（比按天更狠的漏项）。",
        "6. 说明列若写「附近有记录」多半是送检日与核收日差了几天，不是真失踪。",
    ]
    for i, t in enumerate(tips):
        r = 17 + i
        ws.merge_cells(f"A{r}:H{r}")
        ws[f"A{r}"] = t
        ws[f"A{r}"].font = font_n

    # ---- 待核实清单 ----
    ws2 = wb.create_sheet("待核实清单")
    ws2.sheet_view.showGridLines = False
    set_widths(ws2, [12, 12, 12, 14, 14, 10, 10, 10, 34, 34])
    ws2.merge_cells("A1:J1")
    ws2["A1"] = f"待核实清单（只显示有差异 · 共 {len(issues)} 条）"
    ws2["A1"].font = font_title
    ws2["A1"].fill = fill_title
    ws2.row_dimensions[1].height = 32
    ws2.merge_cells("A2:J2")
    ws2["A2"] = f"金额不一致 {n_amt} · 仅机构 {n_only_tp} · 仅医院 {n_only_lis} · 不一致金额合计 {abs_diff:,.2f}"
    ws2["A2"].font = font_muted

    cols = ["状态", "姓名", "日期", "机构标准物价", "医院报告费用", "差额", "机构条数", "医院标本数", "机构项目", "医院项目"]
    for i, h in enumerate(cols, 1):
        cell = ws2.cell(row=4, column=i, value=h)
        cell.font = font_white
        cell.fill = fill_title
        cell.alignment = center
        cell.border = thin
    ws2.freeze_panes = "A5"
    if len(issues) == 0:
        ws2["A5"] = "没有差异，全部金额一致"
        ws2["A5"].font = Font(name="Microsoft YaHei", size=12, bold=True, color="15803D")
    else:
        ws2.auto_filter.ref = f"A4:J{4 + len(issues)}"
        for ri, (_, row) in enumerate(issues.iterrows(), 5):
            status = row["状态"]
            fill = fill_bad if status == "金额不一致" else (fill_warn if status == "仅机构有" else fill_info)
            vals = [
                status,
                row["姓名"],
                fmt_date(row["日期"]),
                float(row["机构标准物价"] or 0),
                float(row["医院报告费用"] or 0),
                float(row["差额"] or 0),
                int(row["机构明细条数"]) if pd.notna(row.get("机构明细条数")) else "",
                int(row["医院标本数"]) if pd.notna(row.get("医院标本数")) else "",
                str(row.get("机构项目") or "")[:100],
                str(row.get("医院项目") or "")[:100],
            ]
            for ci, v in enumerate(vals, 1):
                cell = ws2.cell(row=ri, column=ci, value=v)
                cell.font = font_n if ci > 1 else Font(name="Microsoft YaHei", size=10, bold=True)
                cell.border = thin
                cell.fill = fill
                cell.alignment = center if ci <= 8 else left
                if ci in (4, 5, 6) and v != "":
                    cell.number_format = money_fmt

    def _write_table(ws, title, subtitle, headers, rows, money_cols=(), date_cols=(), fill_default=None):
        ws.sheet_view.showGridLines = False
        ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=max(len(headers), 1))
        ws.cell(row=1, column=1, value=title).font = font_title
        ws.cell(row=1, column=1).fill = fill_title
        ws.row_dimensions[1].height = 30
        ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=max(len(headers), 1))
        ws.cell(row=2, column=1, value=subtitle).font = font_muted
        for i, h in enumerate(headers, 1):
            cell = ws.cell(row=4, column=i, value=h)
            cell.font = font_white
            cell.fill = fill_title
            cell.alignment = center
            cell.border = thin
        ws.freeze_panes = "A5"
        if not rows:
            ws.cell(row=5, column=1, value="（无）").font = Font(
                name="Microsoft YaHei", size=12, bold=True, color="15803D"
            )
            return
        ws.auto_filter.ref = f"A4:{get_column_letter(len(headers))}{4 + len(rows)}"
        for ri, row in enumerate(rows, 5):
            for ci, h in enumerate(headers, 1):
                v = row.get(h, "")
                if h in date_cols and v != "" and v is not None:
                    v = fmt_date(v)
                cell = ws.cell(row=ri, column=ci, value=v if v is not None else "")
                cell.font = font_n
                cell.border = thin
                cell.fill = fill_default or fill_white
                cell.alignment = center if ci <= 6 else left
                if h in money_cols and v != "" and v is not None:
                    try:
                        cell.value = float(v)
                        cell.number_format = money_fmt
                    except Exception:
                        pass

    fill_white = PatternFill("solid", fgColor="FFFFFF")

    # ---- 机构有·医院无 ----
    ws_a = wb.create_sheet("机构有·医院无")
    set_widths(ws_a, [10, 12, 16, 28, 12, 12, 40])
    df_a = presence["机构有医院无_明细"]
    rows_a = df_a.to_dict("records") if len(df_a) else []
    # normalize keys for header
    _write_table(
        ws_a,
        f"机构有 · 医院无（{len(rows_a)} 行明细）",
        "机构账单里有这些项目/条码，但按姓名+日期(±容差)在医院外送导出里对不上。看「说明」是否其实只是跨日。",
        ["姓名", "送检日期", "条码号", "机构项目", "标准物价", "结算金额", "说明"],
        rows_a,
        money_cols=("标准物价", "结算金额"),
        date_cols=("送检日期",),
        fill_default=fill_warn,
    )
    # 病人级附录
    df_pa = presence["病人仅机构有"]
    if len(df_pa):
        start = 6 + max(len(rows_a), 1)
        ws_a.cell(row=start, column=1, value="【附录】整个周期姓名只出现在机构、医院一次都没有：").font = font_h
        for i, h in enumerate(["姓名", "机构条数", "标准物价合计", "结算合计", "条码示例", "项目汇总", "日期范围"], 1):
            cell = ws_a.cell(row=start + 1, column=i, value=h)
            cell.font = font_white
            cell.fill = fill_title
        for ri, (_, row) in enumerate(df_pa.iterrows(), start + 2):
            for ci, h in enumerate(["姓名", "机构条数", "标准物价合计", "结算合计", "条码示例", "项目汇总", "日期范围"], 1):
                cell = ws_a.cell(row=ri, column=ci, value=row[h])
                cell.font = font_n
                cell.fill = fill_warn
                cell.border = thin
                if h in ("标准物价合计", "结算合计"):
                    cell.number_format = money_fmt

    # ---- 医院有·机构无 ----
    ws_b = wb.create_sheet("医院有·机构无")
    set_widths(ws_b, [10, 12, 14, 10, 12, 36, 40])
    df_b = presence["医院有机构无_明细"]
    rows_b = df_b.to_dict("records") if len(df_b) else []
    _write_table(
        ws_b,
        f"医院有 · 机构无（{len(rows_b)} 条标本）",
        "医院 LIS 外送导出有这些检验号/结果，但机构汇总表按姓名+日期(±容差)对不上。可能下月才出账、或未送该机构。",
        ["姓名", "核收日期", "检验号", "报告状态", "报告费用", "组合项目", "说明"],
        rows_b,
        money_cols=("报告费用",),
        date_cols=("核收日期",),
        fill_default=fill_info,
    )
    df_pb = presence["病人仅医院有"]
    if len(df_pb):
        start = 6 + max(len(rows_b), 1)
        ws_b.cell(row=start, column=1, value="【附录】整个周期姓名只出现在医院、机构一次都没有：").font = font_h
        for i, h in enumerate(["姓名", "医院标本数", "报告费用合计", "检验号示例", "项目汇总", "日期范围"], 1):
            cell = ws_b.cell(row=start + 1, column=i, value=h)
            cell.font = font_white
            cell.fill = fill_title
        for ri, (_, row) in enumerate(df_pb.iterrows(), start + 2):
            for ci, h in enumerate(["姓名", "医院标本数", "报告费用合计", "检验号示例", "项目汇总", "日期范围"], 1):
                cell = ws_b.cell(row=ri, column=ci, value=row[h])
                cell.font = font_n
                cell.fill = fill_info
                cell.border = thin
                if h == "报告费用合计":
                    cell.number_format = money_fmt

    # ---- 同日项目缺失 ----
    ws_c = wb.create_sheet("同日项目缺失")
    set_widths(ws_c, [10, 12, 16, 28, 16, 12, 40])
    df_c = presence["同日项目缺失"]
    rows_c = df_c.to_dict("records") if len(df_c) else []
    _write_table(
        ws_c,
        f"同日项目缺失（{len(rows_c)} 行）",
        "同一病人在日期容差内两边都有记录，但某一项目/结果只出现在一侧（名称不同也会落这里）。",
        ["姓名", "日期", "侧", "项目", "条码号或检验号", "金额", "说明"],
        rows_c,
        money_cols=("金额",),
        date_cols=("日期",),
        fill_default=fill_bad,
    )

    # ---- 项目名提示 ----
    ws3 = wb.create_sheet("项目名提示")
    ws3.sheet_view.showGridLines = False
    set_widths(ws3, [40, 10, 50])
    ws3.merge_cells("A1:C1")
    ws3["A1"] = "机构项目名能否对上医院（否=优先人工核对/补别名）"
    ws3["A1"].font = font_title
    ws3["A1"].fill = fill_title
    ws3.row_dimensions[1].height = 30
    for i, h in enumerate(["机构项目", "匹配?", "医院侧对应名"], 1):
        cell = ws3.cell(row=3, column=i, value=h)
        cell.font = font_white
        cell.fill = fill_title
        cell.alignment = center
    if len(nmap):
        nm = nmap.copy()
        nm["_o"] = nm["是否匹配到医院名"].map({"否": 0, "是": 1})
        nm = nm.sort_values(["_o", "机构项目"])
        for ri, (_, row) in enumerate(nm.iterrows(), 4):
            ok = row["是否匹配到医院名"] == "是"
            fill = fill_ok if ok else fill_warn
            for ci, v in enumerate(
                [
                    row["机构项目"],
                    row["是否匹配到医院名"],
                    row.get("医院侧对应名") or "（未匹配）",
                ],
                1,
            ):
                cell = ws3.cell(row=ri, column=ci, value=v)
                cell.font = font_n
                cell.fill = fill
                cell.border = thin
                cell.alignment = left if ci != 2 else center

    # ---- 底稿 ----
    ws4 = wb.create_sheet("底稿_全部患者日")
    ws4.sheet_view.showGridLines = False
    set_widths(ws4, [12, 12, 12, 14, 14, 10, 10, 36, 36])
    ws4.merge_cells("A1:I1")
    ws4["A1"] = "全部患者日（含金额一致，抽查用）"
    ws4["A1"].font = font_title
    ws4["A1"].fill = fill_title
    ws4.row_dimensions[1].height = 28
    heads = ["状态", "姓名", "日期", "机构标准物价", "医院报告费用", "差额", "机构条数", "机构项目", "医院项目"]
    for i, h in enumerate(heads, 1):
        cell = ws4.cell(row=3, column=i, value=h)
        cell.font = font_white
        cell.fill = fill_title
        cell.alignment = center
    alld = merged.copy()
    alld["_o"] = alld["状态"].map({"金额不一致": 0, "仅机构有": 1, "仅医院有": 2, "金额一致": 3})
    alld = alld.sort_values(["_o", "日期", "姓名"])
    ws4.auto_filter.ref = f"A3:I{3 + len(alld)}"
    ws4.freeze_panes = "A4"
    for ri, (_, row) in enumerate(alld.iterrows(), 4):
        status = row["状态"]
        fill = {
            "金额一致": fill_ok,
            "金额不一致": fill_bad,
            "仅机构有": fill_warn,
            "仅医院有": fill_info,
        }[status]
        vals = [
            status,
            row["姓名"],
            fmt_date(row["日期"]),
            float(row["机构标准物价"] or 0),
            float(row["医院报告费用"] or 0),
            float(row["差额"] or 0),
            int(row["机构明细条数"]) if pd.notna(row.get("机构明细条数")) else "",
            str(row.get("机构项目") or "")[:100],
            str(row.get("医院项目") or "")[:100],
        ]
        for ci, v in enumerate(vals, 1):
            cell = ws4.cell(row=ri, column=ci, value=v)
            cell.font = font_n
            cell.fill = fill
            cell.border = thin
            cell.alignment = center if ci <= 7 else left
            if ci in (4, 5, 6):
                cell.number_format = money_fmt

    out_path = Path(out_path)
    wb.save(out_path)
    return out_path


def match_institution_baseline(tp: pd.DataFrame, lis: pd.DataFrame) -> dict:
    """
    以机构表为基准：逐行在医院侧找姓名+项目（模糊）匹配。
    日期不强制同一天，只在多个候选时优先选核收日最接近送检日的。
    医院有而机构没有的一律忽略。
    """
    lis = lis.reset_index(drop=True)
    used_lis: set[int] = set()
    lis_by_name: dict[str, list[int]] = {}
    for i, r in lis.iterrows():
        lis_by_name.setdefault(str(r["姓名"]), []).append(i)

    matched_rows = []
    missing_rows = []

    # 稳定顺序：按送检日、姓名
    tp_sorted = tp.sort_values(["日期", "患者", "单项名称"]).reset_index()
    for _, tr in tp_sorted.iterrows():
        ti = int(tr["index"])
        name = str(tr["患者"])
        cands = []
        for li in lis_by_name.get(name, []):
            if li in used_lis:
                continue
            lr = lis.loc[li]
            score = match_score(tr["单项名称"], lr["项目"], lr["组合"])
            if score < 70:
                continue
            day_diff = abs((lr["日期"] - tr["日期"]).days) if pd.notna(lr["日期"]) and pd.notna(tr["日期"]) else 9999
            # 先比匹配分，再比日差（同分优先日期近）
            cands.append((-score, day_diff, li, score))
        if not cands:
            missing_rows.append(
                {
                    "姓名": name,
                    "送检日期": tr["日期"],
                    "条码号": tr["条码号"],
                    "机构项目": tr["单项名称"],
                    "标准物价": float(tr["标准物价"] or 0),
                    "结算金额": float(tr["结算金额"] or 0),
                    "匹配结果": "医院未找到",
                    "说明": "在宽日期 LIS 导出中，按姓名+项目未匹配到对应记录（可能漏收/未登记外送/名称差异）",
                }
            )
            continue
        cands.sort()
        _, day_diff, li, score = cands[0]
        used_lis.add(li)
        lr = lis.loc[li]
        matched_rows.append(
            {
                "姓名": name,
                "送检日期": tr["日期"],
                "条码号": tr["条码号"],
                "机构项目": tr["单项名称"],
                "标准物价": float(tr["标准物价"] or 0),
                "结算金额": float(tr["结算金额"] or 0),
                "医院核收日": lr["日期"],
                "医院检验号": lr["检验号"],
                "医院项目": lr["项目"],
                "医院组合": lr["组合"],
                "日差天数": day_diff if day_diff < 9999 else "",
                "匹配分": score,
                "匹配结果": "已匹配",
            }
        )

    df_miss = pd.DataFrame(missing_rows)
    df_ok = pd.DataFrame(matched_rows)
    miss_std = float(df_miss["标准物价"].sum()) if len(df_miss) else 0.0
    miss_settle = float(df_miss["结算金额"].sum()) if len(df_miss) else 0.0
    ok_std = float(df_ok["标准物价"].sum()) if len(df_ok) else 0.0
    total_std = float(tp["标准物价"].sum())
    total_settle = float(tp["结算金额"].sum())

    # 按病人汇总少收
    if len(df_miss):
        by_pat = (
            df_miss.groupby("姓名", as_index=False)
            .agg(
                少收项目数=("机构项目", "count"),
                少收标准物价=("标准物价", "sum"),
                少收结算金额=("结算金额", "sum"),
                条码=("条码号", lambda s: "、".join(list(dict.fromkeys(x for x in s if x))[:6])),
                项目=("机构项目", lambda s: "；".join(s.astype(str))),
                送检日期=("送检日期", lambda s: "、".join(sorted({d.strftime("%Y-%m-%d") if hasattr(d, "strftime") else str(d)[:10] for d in s}))),
            )
            .sort_values("少收标准物价", ascending=False)
        )
    else:
        by_pat = pd.DataFrame()

    # 按项目汇总少收
    if len(df_miss):
        by_item = (
            df_miss.groupby("机构项目", as_index=False)
            .agg(次数=("姓名", "count"), 少收标准物价=("标准物价", "sum"), 少收结算金额=("结算金额", "sum"))
            .sort_values("少收标准物价", ascending=False)
        )
    else:
        by_item = pd.DataFrame()

    return {
        "matched": df_ok,
        "missing": df_miss,
        "by_patient": by_pat,
        "by_item": by_item,
        "stats": {
            "机构总行数": len(tp),
            "已匹配行数": len(df_ok),
            "未匹配行数": len(df_miss),
            "匹配率": round(100.0 * len(df_ok) / len(tp), 1) if len(tp) else 0,
            "机构标准物价合计": total_std,
            "机构结算金额合计": total_settle,
            "已匹配标准物价": ok_std,
            "少收标准物价": miss_std,
            "少收结算金额": miss_settle,
            "机构日期": f"{tp['日期'].min().date()} ~ {tp['日期'].max().date()}",
            "医院日期": f"{lis['日期'].min().date()} ~ {lis['日期'].max().date()}",
        },
    }


def write_shortfall_report(out_path: Path, tp: pd.DataFrame, lis: pd.DataFrame, src_label: str = "") -> Path:
    """只输出：医院相对机构少收了什么 / 多少钱。"""
    if Workbook is None:
        raise SystemExit("需要 openpyxl：pip3 install openpyxl")

    result = match_institution_baseline(tp, lis)
    st = result["stats"]
    df_miss = result["missing"]
    df_ok = result["matched"]
    by_pat = result["by_patient"]
    by_item = result["by_item"]

    thin = Border(
        left=Side(style="thin", color="D0D7DE"),
        right=Side(style="thin", color="D0D7DE"),
        top=Side(style="thin", color="D0D7DE"),
        bottom=Side(style="thin", color="D0D7DE"),
    )
    fill_title = PatternFill("solid", fgColor="B91C1C")
    fill_ok_t = PatternFill("solid", fgColor="0F766E")
    fill_head = PatternFill("solid", fgColor="FEE2E2")
    fill_ok = PatternFill("solid", fgColor="DCFCE7")
    fill_bad = PatternFill("solid", fgColor="FEE2E2")
    fill_warn = PatternFill("solid", fgColor="FEF3C7")
    fill_card = PatternFill("solid", fgColor="FEF2F2")
    font_title = Font(name="Microsoft YaHei", size=16, bold=True, color="FFFFFF")
    font_h = Font(name="Microsoft YaHei", size=11, bold=True, color="7F1D1D")
    font_n = Font(name="Microsoft YaHei", size=10, color="1F2937")
    font_big = Font(name="Microsoft YaHei", size=22, bold=True, color="B91C1C")
    font_big_ok = Font(name="Microsoft YaHei", size=18, bold=True, color="0F766E")
    font_muted = Font(name="Microsoft YaHei", size=9, color="6B7280")
    font_white = Font(name="Microsoft YaHei", size=10, bold=True, color="FFFFFF")
    center = Alignment(horizontal="center", vertical="center", wrap_text=True)
    left = Alignment(horizontal="left", vertical="center", wrap_text=True)
    money_fmt = "#,##0.00"

    def set_widths(ws, widths):
        for i, w in enumerate(widths, 1):
            ws.column_dimensions[get_column_letter(i)].width = w

    def fmt_date(v):
        if hasattr(v, "strftime"):
            return v.strftime("%Y-%m-%d")
        s = str(v)
        return s[:10] if s and s != "NaT" else ""

    def write_rows(ws, start_row, headers, records, money_cols=(), date_cols=(), fill=None):
        for i, h in enumerate(headers, 1):
            cell = ws.cell(row=start_row, column=i, value=h)
            cell.font = font_white
            cell.fill = fill_title
            cell.alignment = center
            cell.border = thin
        if not records:
            ws.cell(row=start_row + 1, column=1, value="（无 · 全部在医院侧找到了）").font = Font(
                name="Microsoft YaHei", size=12, bold=True, color="15803D"
            )
            return start_row + 1
        for ri, row in enumerate(records, start_row + 1):
            for ci, h in enumerate(headers, 1):
                v = row.get(h, "")
                if h in date_cols:
                    v = fmt_date(v)
                cell = ws.cell(row=ri, column=ci, value=v if v is not None else "")
                cell.font = font_n
                cell.border = thin
                cell.fill = fill or fill_bad
                cell.alignment = center if ci <= 5 else left
                if h in money_cols and v != "" and v is not None:
                    try:
                        cell.value = float(v)
                        cell.number_format = money_fmt
                    except Exception:
                        pass
        ws.auto_filter.ref = f"A{start_row}:{get_column_letter(len(headers))}{start_row + len(records)}"
        ws.freeze_panes = f"A{start_row + 1}"
        return start_row + len(records)

    wb = Workbook()

    # ===== 1. 一眼看懂 =====
    ws = wb.active
    ws.title = "一眼看懂"
    ws.sheet_view.showGridLines = False
    set_widths(ws, [18, 16, 16, 16, 16, 16, 20, 14])

    ws.merge_cells("A1:H1")
    ws["A1"] = "外送少收分析 · 以机构账单为基准"
    ws["A1"].font = font_title
    ws["A1"].fill = fill_title
    ws.row_dimensions[1].height = 36

    ws.merge_cells("A2:H2")
    ws["A2"] = (
        f"{src_label}　　生成：{pd.Timestamp.now():%Y-%m-%d %H:%M}\n"
        f"机构账单（基准）{st['机构日期']}　　医院 LIS（对照，宜更宽）{st['医院日期']}"
    )
    ws["A2"].font = font_muted
    ws["A2"].alignment = left
    ws.row_dimensions[2].height = 34

    ws.merge_cells("A4:B4")
    ws["A4"] = "机构标准物价合计"
    ws.merge_cells("C4:D4")
    ws["C4"] = "已在医院匹配到"
    ws.merge_cells("E4:F4")
    ws["E4"] = "医院少收（标准物价）"
    ws.merge_cells("G4:H4")
    ws["G4"] = "医院少收（结算金额）"
    for addr in ("A4", "C4", "E4", "G4"):
        ws[addr].font = font_h
        ws[addr].fill = fill_card
        ws[addr].alignment = center

    ws.merge_cells("A5:B5")
    ws["A5"] = st["机构标准物价合计"]
    ws["A5"].number_format = money_fmt
    ws["A5"].font = Font(name="Microsoft YaHei", size=18, bold=True, color="1F2937")
    ws.merge_cells("C5:D5")
    ws["C5"] = st["已匹配标准物价"]
    ws["C5"].number_format = money_fmt
    ws["C5"].font = font_big_ok
    ws.merge_cells("E5:F5")
    ws["E5"] = st["少收标准物价"]
    ws["E5"].number_format = money_fmt
    ws["E5"].font = font_big
    ws.merge_cells("G5:H5")
    ws["G5"] = st["少收结算金额"]
    ws["G5"].number_format = money_fmt
    ws["G5"].font = font_big
    for r in (4, 5):
        for c in range(1, 9):
            cell = ws.cell(row=r, column=c)
            cell.border = thin
            cell.alignment = center
            if r == 5:
                cell.fill = fill_card
    ws.row_dimensions[5].height = 44

    ws.merge_cells("A6:H6")
    ws["A6"] = (
        "规则：机构表固定为基准；医院日期可更宽，不要求起止一致。"
        "只统计「机构有、医院没有」→ 视为我院可能少收。"
        "「医院有、机构没有」不统计（不由我院承担）。"
        "金额优先看「标准物价」（收费价）；「结算金额」是机构折扣回款口径，供参考。"
        "匹配键：姓名 + 项目名（模糊/别名），日期仅作远近排序，不卡死同一天。"
    )
    ws["A6"].font = font_muted
    ws["A6"].alignment = left
    ws.row_dimensions[6].height = 48

    ws["A8"] = "匹配概况"
    ws["A8"].font = Font(name="Microsoft YaHei", size=12, bold=True, color="B91C1C")
    headers = ["机构总行数", "已匹配", "未匹配(少收明细)", "匹配率%", "少收涉及病人数", "少收涉及项目种数"]
    vals = [
        st["机构总行数"],
        st["已匹配行数"],
        st["未匹配行数"],
        st["匹配率"],
        len(by_pat) if len(by_pat) else 0,
        len(by_item) if len(by_item) else 0,
    ]
    for i, h in enumerate(headers, 1):
        cell = ws.cell(row=9, column=i, value=h)
        cell.font = font_h
        cell.fill = fill_head
        cell.border = thin
        cell.alignment = center
    for i, v in enumerate(vals, 1):
        cell = ws.cell(row=10, column=i, value=v)
        cell.font = font_n
        cell.border = thin
        cell.alignment = center
        if i == 2:
            cell.fill = fill_ok
        if i == 3 and v:
            cell.fill = fill_bad

    if st["少收标准物价"] <= 0.01:
        conclusion = "机构账单项目在医院侧均能匹配到，未发现明显少收。"
        cfill = fill_ok
    elif st["匹配率"] >= 95:
        conclusion = "大部分已匹配，少量未匹配请看「少收明细」。"
        cfill = fill_warn
    else:
        conclusion = "存在未匹配项目，请按「少收明细 / 按病人汇总」核实是否漏收。"
        cfill = fill_bad
    ws.merge_cells("A12:H12")
    ws["A12"] = "结论：" + conclusion
    ws["A12"].font = Font(name="Microsoft YaHei", size=12, bold=True)
    ws["A12"].fill = cfill
    ws["A12"].alignment = left

    tips = [
        "1. 打开「少收明细」：机构有、医院没有的每一行（标准物价可加总=少收收费额）。",
        "2. 「按病人汇总」「按项目汇总」：看哪些人、哪些项目贡献了少收。",
        "3. 「已匹配清单」：已对上的，可抽查日差是否合理（培养/药敏跨很多天也正常）。",
        "4. 若名称差太多导致误判未匹配，把别名补进脚本 ITEM_ALIASES 后再跑。",
    ]
    ws["A14"] = "怎么用"
    ws["A14"].font = Font(name="Microsoft YaHei", size=12, bold=True, color="B91C1C")
    for i, t in enumerate(tips):
        r = 15 + i
        ws.merge_cells(f"A{r}:H{r}")
        ws[f"A{r}"] = t
        ws[f"A{r}"].font = font_n

    # ===== 2. 少收明细 =====
    ws2 = wb.create_sheet("少收明细")
    ws2.sheet_view.showGridLines = False
    set_widths(ws2, [10, 12, 16, 28, 12, 12, 12, 40])
    ws2.merge_cells("A1:H1")
    ws2["A1"] = f"少收明细 · 机构有且医院未匹配（{st['未匹配行数']} 行）· 少收标准物价 {st['少收标准物价']:,.2f}"
    ws2["A1"].font = font_title
    ws2["A1"].fill = fill_title
    ws2.row_dimensions[1].height = 32
    ws2.merge_cells("A2:H2")
    ws2["A2"] = "这是你要找的核心表：只含机构账单有、我院宽日期导出里对不上的项目。"
    ws2["A2"].font = font_muted
    miss_records = df_miss.to_dict("records") if len(df_miss) else []
    write_rows(
        ws2,
        4,
        ["姓名", "送检日期", "条码号", "机构项目", "标准物价", "结算金额", "匹配结果", "说明"],
        miss_records,
        money_cols=("标准物价", "结算金额"),
        date_cols=("送检日期",),
        fill=fill_bad,
    )

    # ===== 3. 按病人 =====
    ws3 = wb.create_sheet("按病人汇总")
    ws3.sheet_view.showGridLines = False
    set_widths(ws3, [12, 12, 14, 14, 24, 40, 24])
    ws3.merge_cells("A1:G1")
    ws3["A1"] = "少收按病人汇总（按少收标准物价从高到低）"
    ws3["A1"].font = font_title
    ws3["A1"].fill = fill_title
    pat_records = by_pat.to_dict("records") if len(by_pat) else []
    # rename keys to Chinese headers already in by_pat
    write_rows(
        ws3,
        3,
        ["姓名", "少收项目数", "少收标准物价", "少收结算金额", "条码", "项目", "送检日期"],
        pat_records,
        money_cols=("少收标准物价", "少收结算金额"),
        fill=fill_warn,
    )

    # ===== 4. 按项目 =====
    ws4 = wb.create_sheet("按项目汇总")
    ws4.sheet_view.showGridLines = False
    set_widths(ws4, [36, 10, 14, 14])
    ws4.merge_cells("A1:D1")
    ws4["A1"] = "少收按机构项目汇总"
    ws4["A1"].font = font_title
    ws4["A1"].fill = fill_title
    item_records = by_item.to_dict("records") if len(by_item) else []
    write_rows(
        ws4,
        3,
        ["机构项目", "次数", "少收标准物价", "少收结算金额"],
        item_records,
        money_cols=("少收标准物价", "少收结算金额"),
        fill=fill_warn,
    )

    # ===== 5. 项目名称对照（机构 → 本院）=====
    ws_map = wb.create_sheet("项目名称对照")
    ws_map.sheet_view.showGridLines = False
    set_widths(ws_map, [40, 14, 50])
    ws_map.merge_cells("A1:C1")
    ws_map["A1"] = "机构项目名 → 本院可匹配名（别名表 + 规则）"
    ws_map["A1"].font = font_title
    ws_map["A1"].fill = fill_ok_t
    for i, h in enumerate(["机构项目", "对照方式", "本院对应示例"], 1):
        cell = ws_map.cell(row=3, column=i, value=h)
        cell.font = font_white
        cell.fill = fill_ok_t
        cell.alignment = center
    # 用本次数据中的机构项目列表
    inst_names = sorted(tp["单项名称"].dropna().unique())
    lis_names = sorted(set(lis["项目"].dropna().astype(str)) | set(lis["组合"].dropna().astype(str)))
    for ri, name in enumerate(inst_names, 4):
        hits = []
        for ln in lis_names:
            sc = match_score(name, ln, "")
            if sc >= 70:
                hits.append((sc, ln))
        hits = sorted(hits, reverse=True)[:8]
        how = "别名/规则" if hits else "未建立对照"
        sample = "；".join(f"{n}({s})" for s, n in hits) if hits else "（无）"
        fill = fill_ok if hits else fill_bad
        for ci, v in enumerate([name, how, sample], 1):
            cell = ws_map.cell(row=ri, column=ci, value=v)
            cell.font = font_n
            cell.fill = fill
            cell.border = thin
            cell.alignment = left if ci != 2 else center

    # ===== 6. 已匹配（抽查）=====
    ws5 = wb.create_sheet("已匹配清单")
    ws5.sheet_view.showGridLines = False
    set_widths(ws5, [10, 12, 14, 24, 12, 12, 12, 14, 20, 20, 10])
    ws5.merge_cells("A1:K1")
    ws5["A1"] = f"已匹配清单（{st['已匹配行数']} 行，抽查用 · 医院有、机构没有的不在此表）"
    ws5["A1"].font = Font(name="Microsoft YaHei", size=14, bold=True, color="FFFFFF")
    ws5["A1"].fill = fill_ok_t
    ok_records = df_ok.to_dict("records") if len(df_ok) else []
    write_rows(
        ws5,
        3,
        [
            "姓名",
            "送检日期",
            "条码号",
            "机构项目",
            "标准物价",
            "结算金额",
            "医院核收日",
            "医院检验号",
            "医院项目",
            "医院组合",
            "日差天数",
        ],
        ok_records,
        money_cols=("标准物价", "结算金额"),
        date_cols=("送检日期", "医院核收日"),
        fill=fill_ok,
    )
    # retitle header fill green for this sheet
    for c in range(1, 12):
        cell = ws5.cell(row=3, column=c)
        cell.fill = fill_ok_t

    out_path = Path(out_path)
    wb.save(out_path)
    return out_path, st


def main(argv=None):
    ap = argparse.ArgumentParser(description="外送少收分析：以机构账单为基准")
    ap.add_argument("--机构", dest="tp", nargs="*", default=None, help="外送机构汇总 xlsx（可多个）")
    ap.add_argument("--lis", dest="lis", nargs="*", default=None, help="LIS 病人结果导出 csv（日期宜更宽）")
    ap.add_argument("-o", "--输出", dest="out", help="结果 xlsx 路径")
    ap.add_argument("--日期容差", dest="slack", type=int, default=1, help="仅 --双向 模式使用")
    ap.add_argument("--双向", dest="bidirectional", action="store_true", help="旧版双向对账（含医院多出的）")
    ap.add_argument("--详细", dest="verbose", action="store_true", help="双向模式下额外输出底表")
    args = ap.parse_args(argv)

    tp_paths = [Path(p).expanduser() for p in (args.tp or [])]
    lis_paths = [Path(p).expanduser() for p in (args.lis or [])]
    out_path = args.out
    used_gui = False

    if not tp_paths or not lis_paths:
        g_tp, g_lis, g_out = _pick_files_gui()
        used_gui = True
        if not tp_paths:
            tp_paths = list(g_tp or [])
        if not lis_paths:
            lis_paths = list(g_lis or [])
        out_path = out_path or g_out

    if not tp_paths or not lis_paths:
        dl = Path.home() / "Downloads"
        cand_tp = list(dl.glob("*外送*汇总*.xlsx")) + list(dl.glob("外送机构汇总.xlsx"))
        cand_lis = list(dl.glob("*lis*导出*.csv")) + list(dl.glob("*结果*.csv")) + list(dl.glob("lis*.csv"))
        if not tp_paths and cand_tp:
            tp_paths = [sorted(cand_tp, key=lambda p: p.stat().st_mtime, reverse=True)[0]]
            print("自动选用机构表:", tp_paths[0])
        if not lis_paths and cand_lis:
            lis_paths = [sorted(cand_lis, key=lambda p: p.stat().st_mtime, reverse=True)[0]]
            print("自动选用 LIS 导出:", lis_paths[0])

    if not tp_paths or not lis_paths:
        print("请同时选择机构 xlsx 与 LIS csv。", file=sys.stderr)
        return 2

    if not out_path:
        out_path = tp_paths[0].parent / f"外送少收分析_{pd.Timestamp.now():%Y%m%d_%H%M%S}.xlsx"
    else:
        out_path = Path(out_path).expanduser()

    tp = _load_tp_many(tp_paths)
    lis = _load_lis_many(lis_paths)
    print(f"机构 {len(tp)} 行 / 医院 {len(lis)} 行")
    print(f"机构日期 {tp['日期'].min().date()}~{tp['日期'].max().date()}  医院日期 {lis['日期'].min().date()}~{lis['日期'].max().date()}")
    src_label = "机构：" + "、".join(p.name for p in tp_paths) + "　LIS：" + "、".join(p.name for p in lis_paths)

    if args.bidirectional:
        raw_sheets = compare(tp, lis, day_slack=args.slack)
        write_clean_report(out_path, tp, lis, raw_sheets, src_label=src_label, day_slack=args.slack)
        print("已生成双向分析表:", out_path)
        return 0

    out_path, st = write_shortfall_report(out_path, tp, lis, src_label=src_label)
    print("已生成少收分析表:", out_path)
    print(
        f"机构标准物价 {st['机构标准物价合计']:,.2f} | 已匹配 {st['已匹配标准物价']:,.2f} | "
        f"少收(标准物价) {st['少收标准物价']:,.2f} | 少收(结算) {st['少收结算金额']:,.2f} | "
        f"匹配 {st['已匹配行数']}/{st['机构总行数']} ({st['匹配率']}%)"
    )
    # 仅弹窗选文件时显示完成摘要（避免命令行被对话框卡住）
    if used_gui:
        try:
            import tkinter as tk
            from tkinter import messagebox

            root = tk.Tk()
            root.withdraw()
            messagebox.showinfo(
                "少收分析完成",
                f"已保存：\n{out_path}\n\n"
                f"机构标准物价：{st['机构标准物价合计']:,.2f}\n"
                f"已匹配金额：{st['已匹配标准物价']:,.2f}\n"
                f"医院少收（标准物价）：{st['少收标准物价']:,.2f}\n"
                f"医院少收（结算参考）：{st['少收结算金额']:,.2f}\n"
                f"匹配：{st['已匹配行数']}/{st['机构总行数']}（{st['匹配率']}%）\n\n"
                f"请看工作表：一眼看懂 / 少收明细",
            )
            root.destroy()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

# Windows 整包转移安装说明

把 Mac 上的 **LIS 工具箱** 整套拷到 Windows 使用。包含：

| 模块 | 做什么 | 怎么启动 |
|------|--------|----------|
| **审核工作台** | 批审、F4 异常审、工作台 | 浏览器 + 油猴脚本 |
| **病人结果导出** | 筛选导出（含外送组） | 同上，点「结果」 |
| **质控导出** | 质控数据 xlsx / ZIP | 同上 + **必须开 serve** |
| **外送少收分析** | 机构账单 vs LIS 导出对账 | 双击 **`外送对账.bat`**（独立，可不装油猴） |

脚本版本以 `iMedicalLIS-enhancer.user.js` 文件头 `@version` 为准。

---

## 0. 建议：整夹拷贝

从 U 盘 / 网盘 / `git clone` 把整个目录拷到 Windows，例如：

```text
D:\LIS脚本\
```

**不要只拷一个 user.js**，否则质控、对账会缺文件。

---

## 1. 需要保留的文件（清单）

### 1.1 审核 + 结果导出 + 质控（浏览器）

```text
D:\LIS脚本\
├── iMedicalLIS-enhancer.user.js   ← 油猴主脚本（必拷）
├── serve.py                       ← 本机小服务器（必拷）
├── start_serve.bat                ← 双击启动 serve（必拷）
└── vendor\
    └── xlsx.full.min.js           ← 质控 Excel 必需（必拷）
```

可选：

- `vendor/jszip.min.js`（当前 ZIP 多为纯 JS，可不拷）
- `质控模板\`（上传模板，与脚本导出独立）
- `HANDTEST.md`（手测清单）

### 1.2 外送少收分析（桌面小工具）

```text
D:\LIS脚本\
├── 外送对账.py                    ← 主程序（必拷）
└── 外送对账.bat                   ← 双击运行（必拷）
```

### 1.3 说明文档（建议一起拷）

```text
Windows安装-含质控.md              ← 本文
AGENTS.md                          ← 总览
requirements.txt                   ← Python 依赖列表
```

---

## 2. 安装 Python 3（只装一次）

1. 打开 https://www.python.org/downloads/  
2. 安装时**勾选** `Add python.exe to PATH`  
3. 打开「命令提示符」验证：

```bat
python --version
```

能显示 `Python 3.x` 即可。

### 安装 Python 依赖

在脚本目录执行：

```bat
cd /d D:\LIS脚本
python -m pip install -r requirements.txt
```

至少需要（外送对账用）：

```bat
python -m pip install pandas openpyxl
```

说明：

- **`serve.py`（审核/质控更新）**：主要用标准库，不装包也能跑 serve  
- **`外送对账.bat`**：需要 `pandas`、`openpyxl`；缺了 bat 会尝试自动安装  

---

## 3. 模块 A：审核 + 结果导出 + 质控（油猴）

### 3.1 启动本机服务

**质控导出、脚本在线更新依赖 serve。**  
每次要用前启动，并**保持窗口不关**。

- 双击 `start_serve.bat`  
  或：

```bat
cd /d D:\LIS脚本
python serve.py
```

成功时类似：

```text
地址: http://localhost:8765/
SheetJS: http://localhost:8765/vendor/xlsx.full.min.js
```

浏览器自检：

| 地址 | 期望 |
|------|------|
| http://localhost:8765/iMedicalLIS-enhancer.user.js | 一大段脚本源码 |
| http://localhost:8765/vendor/xlsx.full.min.js | 开头含 `xlsx.js` / `SheetJS` |

可把 `start_serve.bat` 放到「启动」文件夹，开机自动开。

#### 3.1.1 后台启动 / 停止（8.8.32 起新增）

不想让控制台窗口一直占着，可以：

- **后台启动**：双击 **`start_serve_bg.bat`** —— serve.py 在**最小化窗口**里运行（任务栏标题 `LIS-serve`），日志写入脚本目录的 `serve.log`。启动后它会把日志开头回显一遍，若 Python 没装好（如商店假占位符）会直接看到报错
- **停止**：双击 **`stop_serve.bat`**（按 8765 端口找到进程结束），或右键任务栏 `LIS-serve` 窗口关闭
- **判断是否在运行**：浏览器打开 http://localhost:8765/iMedicalLIS-enhancer.user.js 能看到脚本源码即在线

⚠️ 注意区分「闪退」和「后台运行」：`start_serve.bat` 是**前台服务**，成功时窗口会**一直开着**显示横幅；如果双击后窗口一闪而过，说明有报错（最常见是未装 Python 或商店假 python），请按住 **Shift + 右键**脚本文件夹 →「在此处打开 PowerShell 窗口」→ 手动运行 `python serve.py` 查看具体错误。

⚠️ **bat 编码说明**：所有 `.bat` 均为 **GBK 编码 + CRLF 换行**（中文版 cmd 原生格式）。若用编辑器修改后**另存为 UTF-8，会重现「'xxx' 不是内部或外部命令」式乱码报错**（cmd 按 GBK 解析 UTF-8 中文字节会错位）。改完 bat 请保持 ANSI/GBK 编码保存。

### 3.2 安装 Tampermonkey 与脚本

1. Edge / Chrome 安装扩展 **Tampermonkey**  
2. 安装脚本（二选一）：

**方式 A（推荐，方便更新）**  
- 先启动 `start_serve.bat`  
- 浏览器打开：http://localhost:8765/iMedicalLIS-enhancer.user.js  
- 按提示「安装 / 重新安装」

**方式 B**  
- Tampermonkey → 添加新脚本 → 粘贴 `iMedicalLIS-enhancer.user.js` 全文 → 保存  

3. 检查 `@match` 是否包含本院 LIS 地址，例如：

```text
// @match  http://10.0.29.100/iMedicalLIS/*
// @match  http://192.168.31.111:9111/iMedicalLIS/*
```

若 Windows 访问的 IP/端口不同，在 Tampermonkey 里改或增加一行。

4. 打开 LIS，**Ctrl+F5** 强制刷新，确认生效（浮动钮、质控 📊、「结果」等）。

### 3.3 审核功能

| 功能 | 入口 |
|------|------|
| 审核工作台 | 页面浮动按钮 |
| 一键批审 / F4 | 工作台（正常可审 / 异常待审） |
| 病人结果筛选导出 | 「结果」按钮（含 **外送** 工作组） |

CA / 审核密码：在脚本设置里保存；需本机 CA 与医院要求一致。

### 3.4 质控导出

1. **serve 已启动**  
2. 进入 LIS **质控相关页面**  
3. 打开「质控数据导出」  
4. 选月份、项目 → **检测映射** → **开始导出**  
5. 单文件下载或 **打包 ZIP**  

若提示「SheetJS 未加载」：开 serve → 检查 `vendor\xlsx.full.min.js` → TM 检查更新 → LIS Ctrl+F5。

### 3.5 结果导出（给外送对账用）

1. 点 **「结果」**  
2. 日期选 **比机构账单更宽**（前后多几天～半个月）  
3. 勾 **外送**（或只勾外送仪器）  
4. 查询 → **导出 CSV**  
5. 文件一般在浏览器「下载」文件夹  

---

## 4. 模块 B：外送少收分析（独立工具）

**不依赖** 当天是否开着 serve、是否打开 LIS（分析时只要两份表）。

### 4.1 原理

| 项目 | 说明 |
|------|------|
| **基准** | 外送机构汇总表 `.xlsx` |
| **对照** | LIS 结果导出 `.csv`（日期宜更宽） |
| **只查** | 机构有、医院没有 → **可能少收** |
| **不查** | 医院有、机构没有 |
| **匹配** | 姓名 + 项目名（别名/模糊），日期不强制同一天 |

结果表主要页：

- **一眼看懂** — 少收总额  
- **少收明细** — 核心清单  
- **按病人汇总 / 按项目汇总**  
- **项目名称对照**  
- **已匹配清单**  

### 4.2 日常操作

1. 准备好：机构 `.xlsx` + LIS `.csv`（见 §3.5）  
2. 双击 **`外送对账.bat`**  
3. 弹窗里用 **Ctrl 多选** 两个文件  
4. 保存 `外送少收分析_时间戳.xlsx`  
5. 看摘要与「少收明细」  

命令行示例：

```bat
cd /d D:\LIS脚本
python 外送对账.py --机构 "%USERPROFILE%\Downloads\外送机构汇总.xlsx" --lis "%USERPROFILE%\Downloads\lis 导出.csv" -o "%USERPROFILE%\Downloads\外送少收分析.xlsx"
```

### 4.3 外送对账常见问题

| 现象 | 处理 |
|------|------|
| bat 一闪而过 | 在目录打开 cmd 再运行 bat，看是否缺 Python |
| 缺 pandas / openpyxl | `python -m pip install pandas openpyxl` |
| 少收为 0 仍觉得有漏 | 看「项目名称对照」；加宽 LIS 日期；新项目名需补 `ITEM_ALIASES` |
| 中文控制台乱码 | 以生成的 Excel 为准 |

---

## 5. 日常检查清单（整套）

| 步骤 | 审核/结果 | 质控 | 外送对账 |
|------|-----------|------|----------|
| ① 开 `start_serve.bat` | 建议（更新脚本） | **必须** | 不必 |
| ② 开浏览器进 LIS | 要 | 要 | 导出 CSV 时要 |
| ③ Ctrl+F5 | 要 | 要 | 导出时建议 |
| ④ 业务操作 | 批审 / 结果导出 | 质控导出 | 双击 `外送对账.bat` |
| ⑤ 下班 | 可关 serve | 可关 serve | — |

---

## 6. 更新（Win）

### 油猴脚本 / 质控

1. 覆盖新的 `iMedicalLIS-enhancer.user.js`（及有变化的 `vendor\`）  
2. serve 运行中：Tampermonkey → **检查更新** / 重新打开 install URL  
3. LIS 强制刷新  

### 外送对账

覆盖新的 `外送对账.py`（和如有改动的 `外送对账.bat`）即可，无需重装油猴。

---

## 7. 常见问题（总表）

| 现象 | 处理 |
|------|------|
| 质控 SheetJS 未加载 | 开 serve；检查 vendor\xlsx；重装脚本；Ctrl+F5 |
| ZIP 无反应 | 升级脚本到较新版本（纯 JS 打包） |
| 脚本不出现 | 查 @match、TM 已启用、是否装在当前浏览器 |
| 批审数字不准 | 以列表是否审完为准 |
| 两台电脑 | 各拷一份工具箱；浏览器本地配置不共用 |
| 外送对账找不到 Python | 重装 Python 并勾选 PATH |

---

## 8. 与 Mac 的差异

| | Mac | Windows |
|--|-----|---------|
| 启动 serve | `start_serve_mac.command` | `start_serve.bat` |
| 外送对账 | `外送对账.command` | **`外送对账.bat`** |
| 文件多选 | ⌘ | **Ctrl** |
| Python | 多为 `python3` | 多为 `python` / `py -3` |
| 路径 | `~/脚本` | 任意盘符目录 |

功能与对账逻辑相同；浏览器本地存储、记住的密码等 **不跨电脑同步**。

---

## 9. 给同事的最小拷贝包

**只要审核+质控：**

```text
iMedicalLIS-enhancer.user.js
serve.py
start_serve.bat
vendor\xlsx.full.min.js
Windows安装-含质控.md
```

**只要外送对账：**

```text
外送对账.py
外送对账.bat
Windows安装-含质控.md   （看第 4 节即可）
```

**整套（推荐）：** 整个 `LIS脚本` 文件夹 + 本文。

# Windows 安装说明（审核 + 质控导出）

适用于把本工具箱拷到 Windows，在浏览器里用 **iMedicalLIS 增强助手**（含质控数据导出 / ZIP 打包）。

当前脚本版本以文件头 `@version` 为准（如 7.59.3）。

---

## 1. 需要拷贝的文件

把整个文件夹拷过去最省事，至少保证：

```text
某目录\LIS脚本\          （名字随意）
├── iMedicalLIS-enhancer.user.js   ← 油猴脚本
├── serve.py                       ← 本机小服务器
├── start_serve.bat                ← 双击启动（Windows）
└── vendor\
    └── xlsx.full.min.js           ← 质控导出 Excel 必需
```

可选：

- `vendor/jszip.min.js`（当前 ZIP 已是纯 JS，可不拷）
- `质控模板\`（上传模板，与脚本导出独立）
- `AGENTS.md` / `HANDTEST.md`（说明）

---

## 2. 安装 Python 3

1. 打开 https://www.python.org/downloads/  
2. 安装时**勾选** `Add python.exe to PATH`  
3. 打开「命令提示符」验证：

```bat
python --version
```

能显示 `Python 3.x` 即可（`serve.py` 只用标准库，不用 pip 装包）。

---

## 3. 启动本机服务（质控必需）

**每次要用质控导出前，先启动服务，并保持窗口不关。**

- 双击 `start_serve.bat`  
  或在该目录执行：

```bat
python serve.py
```

成功时窗口会显示类似：

```text
地址: http://localhost:8765/
SheetJS: http://localhost:8765/vendor/xlsx.full.min.js
```

浏览器自检（任选）：

| 地址 | 期望 |
|------|------|
| http://localhost:8765/iMedicalLIS-enhancer.user.js | 一大段脚本源码 |
| http://localhost:8765/vendor/xlsx.full.min.js | 开头含 `xlsx.js` / `SheetJS` |

若 404 或打不开：

- 确认 bat 窗口还在跑  
- 确认 `vendor\xlsx.full.min.js` 在 serve 同目录下  
- 换用管理员以外的普通用户再开一次  

可把 `start_serve.bat` 放到「启动」文件夹，开机自动开服务。

---

## 4. 安装 Tampermonkey 与脚本

1. Edge / Chrome 安装扩展 **Tampermonkey**  
2. 安装脚本（二选一）：

**方式 A（推荐，方便更新）**  
- 先启动 `start_serve.bat`  
- 浏览器打开：http://localhost:8765/iMedicalLIS-enhancer.user.js  
- 按提示「安装 / 重新安装」

**方式 B**  
- Tampermonkey → 添加新脚本 → 粘贴 `iMedicalLIS-enhancer.user.js` 全文 → 保存  

3. 检查脚本头 `@match` 是否包含本院 LIS 地址，例如：

```text
// @match  http://10.0.29.100/iMedicalLIS/*
// @match  http://192.168.31.111:9111/iMedicalLIS/*
```

若 Windows 访问的 IP/端口不同，在 Tampermonkey 里改或增加一行。

4. 打开 LIS 页面并**强制刷新**（Ctrl+F5），确认脚本生效（如右下角浮动按钮、质控 📊 等）。

---

## 5. 质控导出怎么用

1. **serve 已启动**  
2. 进入 LIS **质控相关页面**（脚本会显示质控导出入口）  
3. 打开「质控数据导出」面板  
4. 选月份、项目 → **检测映射** → **开始导出**  
5. 可点各文件「下载」，或 **打包下载 ZIP**  

若提示「SheetJS 未加载」：

1. 启动 / 重启 `start_serve.bat`  
2. 浏览器打开 xlsx 地址确认能访问  
3. Tampermonkey 里对脚本点「检查更新」或重装  
4. LIS 页面 Ctrl+F5  

批号、操作者等配置保存在**本机该浏览器**，换电脑要重新保存一次。

---

## 6. 审核功能（同一脚本）

不依赖 SheetJS，但建议仍开着 serve 以便更新脚本：

| 功能 | 入口 |
|------|------|
| 审核工作台 | 页面浮动按钮 |
| 一键批审 | 工作台内 |
| 异常 F4 / Enter | 异常列表 |
| 顶部悬停小条 | 已关闭，请用工作台 |

CA / 审核密码：在脚本设置里保存；需本机 CA 环境与医院要求一致。

---

## 7. 日常检查清单

| 步骤 | 说明 |
|------|------|
| ① 开 serve | 双击 `start_serve.bat`，窗口保持 |
| ② 开浏览器 | 能上内网 LIS |
| ③ 打开 LIS | Ctrl+F5 刷新 |
| ④ 质控导出 | 映射 → 导出 → 单下/ZIP |
| ⑤ 下班 | 可关 serve 窗口 |

---

## 8. 更新脚本（Win）

1. 覆盖新的 `iMedicalLIS-enhancer.user.js`（及如有变化的 `vendor\`）  
2. serve 运行中：Tampermonkey → 该脚本 → **检查更新** / 重新打开 install URL  
3. LIS 强制刷新  

---

## 9. 常见问题

| 现象 | 处理 |
|------|------|
| 质控报 SheetJS 未加载 | 开 serve；检查 vendor\xlsx；刷新/重装脚本 |
| ZIP 无反应 / 旧版卡住 | 升级到 ≥7.59.3（纯 JS 打包，不依赖 JSZip） |
| 脚本不出现 | 检查 @match、TM 已启用、是否装在当前浏览器 |
| 批审数字不准 | 以列表是否消失为准 |
| 两台电脑 | 各装一份脚本 + 各开自己的 localhost:8765 |

---

## 10. 与 Mac 的差异

| | Mac | Windows |
|--|-----|---------|
| 启动 serve | `start_serve_mac.command` | `start_serve.bat` |
| Python 命令 | 多为 `python3` | 多为 `python` / `py -3` |
| 路径 | `~/脚本` | 任意盘符目录均可 |

功能相同，配置不共用（浏览器本地存储各自独立）。

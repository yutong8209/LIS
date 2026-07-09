# vendor

本地第三方库，由 `serve.py` 在 `http://localhost:8765/vendor/` 提供，供 Tampermonkey `@require` 使用（医院内网可不访问公网 CDN）。

| 文件 | 用途 |
|------|------|
| `xlsx.full.min.js` | SheetJS 0.20.3，质控 Excel 导出 |
| `jszip.min.js` | JSZip 3.10.1，质控表格一键 ZIP 打包 |

更新：
```bash
curl -fsSL -o vendor/xlsx.full.min.js \
  "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js"
curl -fsSL -o vendor/jszip.min.js \
  "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"
```

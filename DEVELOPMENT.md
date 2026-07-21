# 开发工具配置说明

## 已安装的工具

### ESLint v10.7.0
代码质量检查工具，用于发现潜在问题和错误。

**使用方法：**
```bash
# 检查单个文件
eslint iMedicalLIS-enhancer.user.js

# 检查所有 JS 文件
eslint .

# 自动修复可修复的问题
eslint --fix iMedicalLIS-enhancer.user.js
```

### Prettier v3.9.5
代码格式化工具，用于统一代码风格。

**使用方法：**
```bash
# 检查格式
prettier --check iMedicalLIS-enhancer.user.js

# 格式化文件
prettier --write iMedicalLIS-enhancer.user.js

# 格式化所有文件
prettier --write .
```

## 配置文件说明

| 文件 | 用途 |
|------|------|
| `eslint.config.js` | ESLint 配置，定义代码规则和全局变量 |
| `.prettierrc` | Prettier 配置，定义代码格式规则 |
| `.prettierignore` | Prettier 忽略的文件列表 |

## 常用规则

### ESLint 规则
- `no-unused-vars`: 未使用的变量（警告）
- `no-undef`: 未定义的变量（警告）
- `semi`: 必须使用分号
- `quotes`: 使用单引号
- `indent`: 2 空格缩进

### Prettier 规则
- 使用单引号
- 2 空格缩进
- 行宽 120 字符
- 无尾随逗号

## 建议的工作流程

1. **编写代码时**：ESLint 会实时提示问题
2. **保存前**：运行 `prettier --write` 格式化代码
3. **提交前**：运行 `eslint .` 检查所有文件

## 快捷命令

```bash
# 检查并格式化
eslint --fix iMedicalLIS-enhancer.user.js && prettier --write iMedicalLIS-enhancer.user.js

# 检查所有文件
eslint . && prettier --check .
```

## Tampermonkey 开发提示

- 脚本顶部的 `==UserScript==` 块不会被 ESLint/Prettier 修改
- GM_* 函数已在 ESLint 配置中声明为全局变量
- `unsafeWindow` 已配置为只读全局变量

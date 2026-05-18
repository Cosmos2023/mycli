# mycli Toolset Design

> 精简工具集：从 20 个合并为 15 个，对标 Claude Code / Codex / Cline 实现。
> 调研来源：Claude Code v2.1.88 源码泄露分析、Codex CLI Rust 源码、Cline/Roo Code 源码。

## 1. Final Tool List

| # | 工具 | 类别 | 说明 |
|---|---|---|---|
| 1 | Read | 读取 | 读文件。支持 offset/limit。合并原 read_file_range |
| 2 | Edit | 编辑 | search-and-replace。合并原 replace_in_file + append_file |
| 3 | Write | 写入 | 创建或覆盖文件。合并原 create_file |
| 4 | Grep | 搜索 | ripgrep 搜索文件内容。默认返回文件名，非内容 |
| 5 | Glob | 搜索 | 按文件名模式找文件 |
| 6 | LS | 浏览 | 列目录（非递归），绝对路径 |
| 7 | Bash | 执行 | Shell 命令。包揽 git、文件操作 |
| 8 | KillShell | 控制 | 杀掉挂起的 Bash 后台进程 |
| 9 | WebSearch | 外部 | 联网搜索。DeepSeek 端点服务端执行 |
| 10 | WebFetch | 外部 | 获取 URL 内容。HTML→Markdown。15min LRU 缓存 |
| 11 | Lint | 验证 | 跑 linter，返回结构化诊断 |
| 12 | AskUserQuestion | 交互 | 多选问答。隐式"Other"选项 |
| 13 | Plan | 规划 | 更新任务进度 |
| 14 | EnterPlanMode | 规划 | 进入规划模式 |
| 15 | ExitPlanMode | 规划 | 退出规划模式 |

---

## 2. 逐工具详细设计

### 2.1 Read

**对标**：Claude Code FileReadTool（多模态：文本+图片+PDF+Jupyter）。Codex 的 indentation mode 暂不加。

**Schema**：
```json
{
    "name": "Read",
    "parameters": {
        "file_path": {"type": "string", "required": true, "description": "Absolute path"},
        "offset": {"type": "integer", "required": false, "description": "Start line (1-based). Text files only."},
        "limit": {"type": "integer", "required": false, "description": "Max lines (default 2000). Text files only."},
        "pages": {"type": "string", "required": false, "description": "Page range for PDF, e.g. '1-5'"}
    }
}
```

**支持的文件类型**：

| 类型 | 扩展名 | 处理方式 | 输出格式 |
|---|---|---|---|
| **纯文本** | .py .js .ts .go .rs .java .c .cpp .h .json .yaml .toml .xml .html .css .sh .bash .zsh .conf .ini .cfg .env .txt .log .rst .tex .sql .rb .php .swift .kt .scala .r .lua .zig 等 | 直接读取 | `cat -n` 风格行号 |
| **Markdown** | .md .mdx .markdown | 直接读取。渲染为格式化文本（可选） | `cat -n` |
| **CSV / TSV** | .csv .tsv | 解析为表格 | 表头 + 前 20 行 + 行列统计 |
| **JSON** | .json | 直接读取。大文件可 pretty-print 前 N 行 | `cat -n` |
| **PDF** | .pdf | PyMuPDF 提取文本 | 逐页文本 + `pages` 参数分页。最多 20 页/次 |
| **Excel** | .xlsx .xls | openpyxl 解析 | Sheet 列表 + 每 Sheet 前 50 行 + 行列统计 |
| **Word** | .docx | python-docx 提取文本 | 段落文本 |
| **Jupyter** | .ipynb | nbformat 解析 | 所有 cell：代码 + markdown + 输出 |
| **图片** | .png .jpg .jpeg .gif .webp .svg | — | 暂不支持。等模型多模态能力确认后再加 |

**未知扩展名处理**：
- 先尝试 UTF-8 解码 → 成功则当文本处理
- 失败则尝试 latin-1 → 成功则当文本处理
- 失败则返回 `[Cannot read binary file: {path}. Type: {detected_mime_type}]`

**行为细则**：

- **默认**：offset 不传 → 从第 1 行开始。limit 不传 → 最多 2000 行（文本文件）
- **行截断**：单行 >2000 字符 → 截断并追加 `[... truncated]`
- **文件不存在**：报错 `[File not found: {path}]`
- **目录**：报错 `[Path is a directory. Use LS to browse.]`
- **截断通知**：内容超过 limit 时追加 `... (output truncated, showing N of M+ lines)`
- **PDF 分页参数**：`pages: "1-5"` 读 1-5 页。不传默认读前 20 页。超过 20 页报错提示分页
- **Excel 多 Sheet**：先列出 Sheet 名称，模型自行选择读哪个。默认读第一个 Sheet
- **Jupyter**：返回所有 cell 的代码 + markdown + 输出文本

**L1 截断**（文本/结构化文件）：
| 文件大小 | 策略 |
|---|---|
| < 15K 字符（~4K tokens） | 全文保留 |
| 15K–60K 字符 | head(8K) + tail(4K)，中间省略标注 |
| > 60K 字符 | 报错 `[File too large. Use offset/limit to read specific sections.]` |

**L1 截断**（表格文件：CSV/Excel）：
| 大小 | 策略 |
|---|---|
| ≤50 行 | 全文保留 |
| >50 行 | 前 20 行 + 后 10 行 + `[Total: N rows × M columns]` |

---

### 2.2 Edit

**对标**：Claude Code FileEditTool——old_string/new_string 精确匹配。不用 Codex 的自定义 diff 格式。

**Schema**：
```json
{
    "name": "Edit",
    "parameters": {
        "file_path": {"type": "string", "required": true, "description": "Absolute path"},
        "old_string": {"type": "string", "required": true, "description": "Exact text to find"},
        "new_string": {"type": "string", "required": true, "description": "Replacement text"},
        "replace_all": {"type": "boolean", "required": false, "description": "Replace all occurrences (default false)"}
    }
}
```

**行为细则**：

- **唯一性**（replace_all=false）：old_string 必须精确且唯一。
  - 0 次匹配 → `Error: String not found in file.`
  - 2+ 次匹配 → `Error: Multiple matches found. Add more context to make unique.`
  - 1 次唯一匹配 → 执行替换
- **追加**：old_string="" + 文件为空 + new_string 非空 → 创建文件
  - old_string="" + 文件非空 → 报错 `Error: File has existing content. Use Edit with old_string to modify.`
- **删除**：new_string="" → 删除 old_string。自动移除尾部多余换行
- **预读要求**：模型必须先 Read 过目标文件（当前 turn 或之前 turn）
- **预处理**：去除行号前缀（模型可能从 Read 输出复制）；去除尾部空白（`.md`/`.mdx` 除外）
- **replace_all=true**：一次替换所有匹配。仅在需要批量操作时使用

**为什么不用 Codex 的 diff 格式**：old_string 方案更防幻觉——模型必须引用真实存在的代码。diff 格式模型可能编造行号和上下文。

---

### 2.3 Write

**对标**：Claude Code FileWriteTool。

**Schema**：
```json
{
    "name": "Write",
    "parameters": {
        "file_path": {"type": "string", "required": true, "description": "Absolute path"},
        "content": {"type": "string", "required": true, "description": "Full file content"}
    }
}
```

**行为细则**：

- **自动建目录**：父目录不存在 → 自动创建（`mkdir -p`）
- **覆盖确认**：文件已存在 → 权限提示（NeedsChoice 级别）
- **换行符保持**：保留 CRLF/LF
- **与 Edit 的区别**：Write 是完整创建/覆盖。Edit 是精确修改已知文件。新增文件 → Write；修改已有文件 → Edit

---

### 2.4 Grep

**对标**：Claude Code GrepTool——**默认返回文件名，不是内容**。这是最大差异点。

**引擎**：ripgrep（`rg`）。

**Schema**：
```json
{
    "name": "Grep",
    "parameters": {
        "pattern": {"type": "string", "required": true, "description": "Search pattern (ripgrep regex syntax)"},
        "path": {"type": "string", "required": false, "description": "File or directory to search. Default: workspace root"},
        "include": {"type": "string", "required": false, "description": "File pattern filter, e.g. '*.py'"},
        "output_mode": {"type": "string", "required": false, "description": "'files_with_matches' (default) or 'content'"},
        "-C": {"type": "integer", "required": false, "description": "Context lines (only for content mode)"},
        "-i": {"type": "boolean", "required": false, "description": "Case-insensitive"},
        "head_limit": {"type": "integer", "required": false, "description": "Max results (default 50)"}
    }
}
```

**行为细则**：

- **默认模式**：`output_mode = "files_with_matches"`——只返回匹配文件路径列表。模型自己决定 Read 哪个
- **结果上限**：50 个文件（files_with_matches）或 50 条匹配（content 模式）。超出标注 `[truncated: N more matches]`
- **content 模式**：-C 3（前后各 3 行上下文）。仅在模型明确需要看内容时才用
- **排除目录**：自动跳过 `.git`、`node_modules`、`__pycache__`、`.venv`、`dist`、`build`
- **.gitignore 感知**：默认遵循 gitignore。可通过配置关闭
- **返回 truncated 标志**：让模型知道结果不完整——缩小搜索范围或指定路径

**为什么默认返回文件名**（Claude Code 的核心设计决策）：
1. 省 token——匹配结果可能有几千行，全放上下文就是自杀
2. 逼模型 Read——先看搜索结果定位文件，再精确读取。这比 grep 全文上下文更有利于缓存
3. 模型经常会基于 grep 结果直接推理而不读原文——这容易幻觉

---

### 2.5 Glob

**对标**：Claude Code GlobTool。

**Schema**：
```json
{
    "name": "Glob",
    "parameters": {
        "pattern": {"type": "string", "required": true, "description": "Glob pattern, e.g. 'src/**/*.py'"},
        "path": {"type": "string", "required": false, "description": "Search root. Default: workspace root"}
    }
}
```

**行为细则**：

- **排序**：按修改时间降序（最近修改的在前）
- **上限**：200 个文件。超出标注 `[truncated: N more files]`
- **隐藏文件**：默认可见（`.env`、`.gitignore` 等）。安全由权限层控制，不由 Glob 静默过滤
- **不支持 .gitignore**：Glob 是文件查找工具，不是 grep——忽略 gitignore 能帮模型发现未被追踪的文件
- **模式语法**：标准 glob。`**` 递归。`{ts,tsx}` 多模式

---

### 2.6 LS

**对标**：Claude Code LSTool——非递归，绝对路径。

**Schema**：
```json
{
    "name": "LS",
    "parameters": {
        "path": {"type": "string", "required": true, "description": "Absolute path to directory"}
    }
}
```

**行为细则**：

- **非递归**：只列当前目录内容。递归用 Glob
- **绝对路径**：不接受相对路径
- **排序**：按修改时间降序
- **输出格式**：`{"dirs": [...], "files": [...], "total": N}`。目录和文件分开
- **上限**：>50 条时只列出前 5 个目录和前 5 个文件 + total 计数
- **权限**：AUTO_ALLOW（纯读操作）

---

### 2.7 Bash

**对标**：Claude Code BashTool——120s 超时，禁止命令重定向，后台运行支持。

**Schema**：
```json
{
    "name": "Bash",
    "parameters": {
        "command": {"type": "string", "required": true, "description": "Shell command"},
        "description": {"type": "string", "required": false, "description": "Short description (5-10 words)"},
        "timeout": {"type": "integer", "required": false, "description": "Timeout in seconds (default 120, max 600)"},
        "run_in_background": {"type": "boolean", "required": false, "description": "Run without blocking (default false)"},
        "workdir": {"type": "string", "required": false, "description": "Working directory. Default: project root"}
    }
}
```

**行为细则**：

- **Shell**：用户默认 shell（`$SHELL` 或 `/bin/bash`）。每个命令独立进程，cwd 持久但环境变量不持久
- **超时**：默认 120s，最大 600s。超时返回 `[Command timed out after Ns]`
- **后台运行**：`run_in_background: true` → 返回 `bash_id`。用 BashOutput 读增量输出，KillShell 终止
- **L1 截断**：10,000 字符 head_tail（head 6K + tail 4K）。超过写磁盘，Read 读完整版
- **stderr 和 stdout 都捕获**：退出码 ≠0 时 stderr 展示在前

**危险命令检测（对标 Claude Code 23 项检查，mycli 先做最基本的）**：

| 危险模式 | 行为 |
|---|---|
| `rm -rf /` 或 `rm -rf /*` | 拦截，报错 |
| `git push --force` 到 main/master | NeedsChoice |
| `curl ... \| bash` 或 `wget ... \| sh` | NeedsChoice |
| `chmod 777` 在项目根目录 | NeedsChoice |
| `sudo` 任何命令 | NeedsChoice |
| `git reset --hard` | NeedsChoice |

**禁止命令（有专用工具的走 Bash 浪费 token）**：

| Bash 中的命令 | 替代 |
|---|---|
| `cat`/`head`/`tail` 读文件 | Read |
| `grep`/`rg` | Grep |
| `ls` | LS |
| `find` 按文件名找 | Glob |
| `sed -i` | Edit |

注意：`git diff`、`git status`、`git log`、`rm`、`mv`、`mkdir` 不在禁止列表中——它们走 Bash。

---

### 2.8 KillShell

**对标**：Claude Code KillShell / BashOutput。

**Schema**：
```json
{
    "name": "KillShell",
    "parameters": {
        "shell_id": {"type": "string", "required": true, "description": "Background shell ID to kill"}
    }
}
```

**行为细则**：

- 先发 SIGTERM，等 2s，不退出再 SIGKILL
- 杀完后返回 `[Shell {id} killed. Exit code: {code}]`
- **注意 Claude Code 的坑**（issue #11716）：杀进程后 system-reminder 可能残留。mycli 实现时杀掉进程后必须同步清理所有关联的 reminder/notification

**配合工具**：`/bashes` 命令列出所有后台进程及其状态（非工具，CLI 命令）。

---

### 2.9 WebSearch

**对标**：Claude Code WebSearchTool + Codex web_search via Responses API。

**双端点适配**：

| Provider | 端点 | 实现 |
|---|---|---|
| DeepSeek | `/anthropic/v1/messages` | 注册 `type: "web_search_20250305"`，服务端执行。`max_uses: 3` |
| OpenAI | `/v1/chat/completions` | 注册 function calling + 后端接 SerpAPI 或 Bing |
| 其他 | Chat Completions | 同 OpenAI fallback |

**Schema**（provider-neutral）：
```json
{
    "name": "WebSearch",
    "parameters": {
        "query": {"type": "string", "required": true, "description": "Search query"},
        "allowed_domains": {"type": "array", "items": {"type": "string"}, "description": "Limit results to these domains"},
        "blocked_domains": {"type": "array", "items": {"type": "string"}, "description": "Exclude these domains"}
    }
}
```

**结果格式**：只返回标题 + URL。模型需要具体内容时调用 WebFetch。Claude Code 也是这么做的——WebSearch 不回传页面全文。

---

### 2.10 WebFetch

**对标**：Claude Code WebFetchTool——Turndown HTML→Markdown，15min LRU，Haiku 摘要。

**Schema**：
```json
{
    "name": "WebFetch",
    "parameters": {
        "url": {"type": "string", "required": true, "description": "URL to fetch"},
        "prompt": {"type": "string", "required": false, "description": "What information to extract from the page"}
    }
}
```

**行为细则**：

- **URL 验证**：自动 HTTP→HTTPS 升级。裁剪凭证（`user:pass@`）
- **HTML→Markdown**：Turndown 或 html2text
- **大小限制**：响应 >5MB 截断。Markdown 转换后 >100KB 截断
- **缓存**：15 分钟 LRU。相同 URL 不重复请求
- **重定向**：同域自动跟进。跨域返回 `[Redirect to: {url}]`
- **prompt 参数**：如果传了 `prompt`，用轻量模型（如 deepseek-lite）提取 prompt 相关的信息。不传就返回全文 Markdown
- **L1 截断**：20,000 字符

---

### 2.11 Lint

**对标**：Claude Code LSPTool（9 种操作）太重。mycli 用 Bash 跑 linter + 结构化输出。

**Schema**：
```json
{
    "name": "Lint",
    "parameters": {
        "paths": {"type": "string", "required": false, "description": "File or directory to check. Default: most recently edited file"}
    }
}
```

**行为细则**：

- **实现**：后台跑 `ruff check`（Python）、`eslint`（JS/TS）。不是 LSP 集成
- **输出**：结构化 JSON——`[{file, line, column, message, rule}]`
- **上限**：最多 30 条诊断。超出标注 `[truncated: N more diagnostics]`
- **不传 paths**：自动检查最近 Edit/Write 过的文件
- **权限**：AUTO_ALLOW（纯读操作）

---

### 2.12 AskUserQuestion

**对标**：Claude Code AskUserQuestionTool——多选 + 隐式 Other。

**Schema**：
```json
{
    "name": "AskUserQuestion",
    "parameters": {
        "question": {"type": "string", "required": true, "description": "The question to ask"},
        "header": {"type": "string", "required": false, "description": "Short label (max 12 chars)"},
        "options": {"type": "array", "items": {"type": "object", "properties": {
            "label": {"type": "string"},
            "description": {"type": "string"}
        }}, "required": true, "description": "2-4 options"},
        "multiSelect": {"type": "boolean", "required": false, "description": "Allow multiple selections (default false)"}
    }
}
```

**行为细则**：

- **选项数量**：2-4 个。自动追加隐式 "Other" 选项（用户可输入自定义文本）
- **默认无**：不设默认值——必须等用户明确选择
- **响应格式**：`{answers: {"label": "...", "notes": "..."}}`。multiSelect 时 answers 是数组
- **权限**：ALWAYS_ASK（本身就是交互工具，不需要额外确认）

---

### 2.13-15 Plan / EnterPlanMode / ExitPlanMode

保持当前实现，不改。

---

## 3. L1 截断总览

| 工具 | 上限 | 策略 |
|---|---|---|
| Read | <15K 全文；15-60K head_tail；>60K 报错 | 三档分级 |
| Edit | 不改 | 返回 diff 摘要 |
| Write | 不改 | 返回成功/失败 |
| Grep | 50 条文件 / 50 条匹配 + truncated flag | top_n |
| Glob | 200 个文件 + truncated flag | top_n |
| LS | 无硬限（输出天然短） | compact_json |
| Bash | 10,000 chars head_tail + 磁盘持久化 | head_tail |
| KillShell | — | 无 |
| WebSearch | 服务端控制 max_uses:3 / SerpAPI top 10 | 服务端 |
| WebFetch | 20,000 chars | head |
| Lint | 30 条诊断 | top_n |
| AskUserQuestion | — | 无 |

---

## 4. 并发安全

```python
CONCURRENCY_SAFE = {
    "Read", "Grep", "Glob", "LS",
    "WebSearch", "WebFetch",
    "Lint",
}
# Edit, Write, Bash, KillShell — 不可并行
```

---

## 5. 权限分级

| 级别 | 工具 |
|---|---|
| AUTO_ALLOW | Read, Grep, Glob, LS, WebSearch, WebFetch, Lint, Plan, EnterPlanMode, ExitPlanMode |
| NEEDS_CHOICE | Edit, Write（覆盖已有文件时）, Bash（危险命令检测触发时） |
| ALWAYS_ASK | KillShell, AskUserQuestion |

---

## 6. 文件变更

| 操作 | 文件 | 说明 |
|---|---|---|
| 新建 | `tools/read/` | Read 拆为子模块：`text.py`, `csv_handler.py`, `pdf_handler.py`, `excel_handler.py`, `docx_handler.py`, `ipynb_handler.py` |
| 新建 | `tools/kill_shell.py` | KillShell |
| 新建 | `tools/web_search.py` | WebSearch（双端点适配） |
| 新建 | `tools/web_fetch.py` | WebFetch（Turndown + LRU） |
| 新建 | `tools/lint.py` | Lint |
| 新建 | `tools/ask_user_question.py` | AskUserQuestion |
| 重命名 | read_file.py → read.py | 合并 read_file_range |
| 重命名 | edit_file.py → edit.py | 合并 replace_in_file + append_file |
| 重命名 | write_file.py → write.py | 合并 create_file |
| 重命名 | search_text.py → grep.py | 改用 ripgrep，默认返回文件名 |
| 重命名 | list_directory.py → ls.py | 非递归 + compact JSON |
| 重命名 | run_shell.py → bash.py | 加危险命令检测 + 后台运行 |
| 重命名 | update_plan.py → plan.py | 命名对齐 |
| 保留 | plan_mode.py | EnterPlanMode + ExitPlanMode 都在此文件 |
| 删除 | read_file_range.py, replace_in_file.py, append_file.py, create_file.py, delete_path.py, move_path.py, mkdir.py, git_diff.py, git_log.py, git_status.py | 详见第 2 节合并说明 |

---

## 8. Read 工具依赖

| 依赖 | 用途 | 安装 |
|---|---|---|
| `PyMuPDF` (fitz) | PDF 文本提取 | `pip install PyMuPDF` |
| `openpyxl` | Excel .xlsx 读取 | `pip install openpyxl` |
| `python-docx` | Word .docx 读取 | `pip install python-docx` |
| `nbformat` | Jupyter .ipynb 解析 | `pip install nbformat` |
| `python-magic` | MIME type 检测（未知文件类型判断） | `pip install python-magic` |

所有依赖在首次使用对应文件类型时才加载（lazy import）。纯文本文件零额外依赖。

## 9. 与 Claude Code 的关键差异

| 差异 | Claude Code | mycli | 原因 |
|---|---|---|---|
| Grep 默认 | files_with_matches | ✅ 跟 | 省 token + 逼模型 Read |
| Edit 格式 | old_string/new_string | ✅ 跟 | 防幻觉 |
| Get 格式 | apply_patch diff | ❌ 不跟 | 过于复杂，模型容易编造行号 |
| Write | 独立工具 | ✅ 跟 | Codex 缺这个不好用 |
| Lint | LSPTool（9 种操作） | Bash 跑 linter | LSP 太重 |
| 沙箱 | Bubblewrap | 权限提示 | 先保持简单 |
| 多模态 Read | 图片/PDF/Jupyter 原生 | 先文本 | DeepSeek 多模态能力待确认 |

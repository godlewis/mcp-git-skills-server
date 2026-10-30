# mcp-git-skills-server

把 **Git 仓库管理的业务技能** 通过 MCP 协议暴露给 AI Agent 的技能服务器。

- **对齐 MCP 官方标准**：实现 [SEP-2640 Skills Extension](https://github.com/modelcontextprotocol/ext-skills)（`io.modelcontextprotocol/skills`，状态 Final），支持 `skills/list` / `skills/get` / `resources/directory/read` 与标准 `skill://` URI
- **三重兼容通道**：标准 Skills 扩展 + Resources（三层渐进式披露）+ Tools（六个工具），覆盖所有 MCP 客户端；兼容通道可按配置关闭
- **Git 驱动生命周期**：技能内容完全由 Git 仓库承载，服务自身不存储业务数据；`git pull` 热更新无需重启，支持分支切换、启动自动拉取开关
- **多仓库聚合**：多个技能仓库按命名空间隔离聚合对外，单仓库故障不影响整体服务
- **生产基线**：路径穿越/软链接防护、文件 digest（SHA-256）清单、分级日志与密钥脱敏、多层级配置体系

> v0.2.x（POC）用户升级零成本：旧环境变量 `SKILLS_REPO_PATH` / `SKILLS_REPO_URL` 继续生效，旧 `git-skills://` URI 与四个原生工具原样保留。

## 快速开始

```bash
npm install
npm run build

# 方式一：环境变量（POC 兼容）
SKILLS_REPO_PATH=./skills-repo npm start

# 方式二：配置文件
cp skills-server.example.yaml skills-server.yaml   # 按需修改
npm start
```

在 Claude Code 中注册（示例）：

```json
{
  "mcpServers": {
    "git-skills": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-git-skills-server/dist/index.js"],
      "env": { "SKILLS_REPO_PATH": "/absolute/path/to/skills-repo" }
    }
  }
}
```

## 技能仓库格式

技能 = 仓库中的一个目录，根目录含 `SKILL.md`（YAML front matter 遵循 [Agent Skills 规范](https://agentskills.io/specification)）：

```markdown
---
name: purchase-apply          # 必填，小写字母/数字/连字符，必须与目录名一致
description: 当用户需要创建采购申请时使用…   # 必填，触发时机
summary: 采购申请全流程处理                  # 可选，一句话摘要
tags: [采购]                                 # 可选，分类标签
version: 1.0.0                               # 可选，默认 1.0.0
triggers: [采购申请, 下单]                    # 可选，触发关键词
author: lewis                                # 可选，维护人
---

# 流程正文（三层渐进式披露的第二层）

详细规则见 references/budget-rules.md（第三层子文档，按需读取）
```

- front matter **逐字段透传**给标准客户端（SEP-2640 要求），新增字段无需改服务器
- 校验失败的技能自动跳过并输出告警，不影响其他技能
- 支持嵌套技能（子目录中再放 `SKILL.md`，平铺发布）
- 每技能限额：512 个文件 / 16 MiB（SEP-2640 Limits）

## 客户端能力矩阵

| 客户端能力 | 使用方式 |
|---|---|
| 支持 SEP-2640 扩展 | `skills/list`、`skills/get`，经 `resources/read` 读取文件，`resources/directory/read` 列目录 |
| 仅支持 Resources | 读 `skill://{namespace}/catalog` 目录 → 按 URI 读取 SKILL.md → 子文档 |
| 仅支持 Tools | `list_skills` → `load_skill` → `read_skill_file` / `list_skill_files` |
| 弱客户端（都不是） | `npm run metadata` 导出技能清单片段，手动粘贴进 system prompt |

### 标准扩展方法（SEP-2640）

| 方法 | 说明 |
|---|---|
| `skills/list` | 分页枚举技能条目（frontmatter 透传 + 完整文件清单含 SHA-256 digest 与字节数），支持 cursor 分页 |
| `skills/get` | 按 SKILL.md 的 URI 返回单技能条目；未知 URI 返回 `-32602` |
| `resources/directory/read` | 列出目录资源直接子项（子目录 `inode/directory`），需服务器声明 `directoryRead: true`（本服务器已声明） |

### URI 规范（双前缀）

```
skill://{namespace}/{skill-path}/SKILL.md        标准前缀（SEP-2640），authority = 命名空间
skill://{namespace}/{skill-path}/{file-path}     技能子文件
skill://{namespace}/catalog                      该仓库的技能目录索引
git-skills://skills/{skill_id}/SKILL.md          兼容前缀（v0.2 POC，可配置关闭）
git-skills://skills/{skill_id}/files/{file_path} 兼容前缀子文件
git-skills://catalog                             兼容前缀目录（聚合全部仓库）
```

`{skill-path}` 最后一段必须等于 front matter 的 `name`（SEP-2640 硬约束）。多仓库模式下技能 ID 为 `{namespace}/{skill-path}`；单仓库下裸 ID 直通，跨仓库重名时工具会报错并列出候选命名空间。

### 工具清单

| 工具 | 说明 |
|---|---|
| `list_skills` | 第一层目录；支持 `keyword`（模糊匹配名称/描述/标签）、`tag`、`repo`、`sort=mtime` 服务端过滤 |
| `load_skill` | 第二层；`mode=full`（默认）完整正文，`mode=summary` 仅返回元数据 + 标题大纲 |
| `read_skill_file` | 第三层子文档，带路径安全校验 |
| `list_skill_files` | 子文档元数据预览（路径、大小、更新时间） |
| `pull_skills` | 拉取更新，返回技能级明细（新增/修改/删除）；可选 `repo`、`branch`（运行时切分支） |
| `get_skills_version` | 各仓库当前分支、commit、最近提交时间 |

## 配置

优先级：**命令行参数 > 环境变量 > 配置文件 > 默认值**。配置文件查找顺序：`--config <path>` > `SKILLS_CONFIG` > `./skills-server.yaml`（完整示例见 `skills-server.example.yaml`）。

```yaml
logLevel: info              # debug | info | warn | error（env: SKILLS_LOG_LEVEL）
autoPullOnStartup: true     # 启动自动 pull（需求 3.3）
pageSize: 100               # skills/list 分页大小
compat:
  legacyTools: true         # 保留 POC 四个原生工具
  legacyGitSkillsUris: true # 保留 git-skills:// 前缀
repos:                      # 多仓库（需求 3.2），namespace 唯一
  - namespace: default
    path: ./skills-repo
    # url: https://github.com/your-org/skills.git
    # branch: main
    # auth:
    #   username: git-bot
    #   password: ${GIT_BOT_TOKEN}   # 支持 ${ENV_VAR} 插值；密钥自动从日志脱敏
```

## 开发

```bash
npm run build       # tsc 编译到 dist/
npm run typecheck   # 仅类型检查
npm test            # 单元测试（node:test，34 项）
npm run smoke       # 冒烟测试（启动真实 stdio server 全链路验证，54 项）
npm run metadata    # 导出 system prompt 技能清单片段
```

### 代码结构（四层）

```
src/
├── index.ts                 入口：四层装配
├── cli.ts                   弱客户端元数据导出
├── infrastructure/          配置体系、分级日志（密钥脱敏）
├── storage/                 路径安全校验、技能扫描（front matter/digest/限额）、Git 仓库封装
├── services/                技能目录聚合（多仓库/ID 解析/检索/分页/渲染）、Git 编排
└── protocol/                MCP Server 装配、SEP-2640 扩展、Resources 通道、Tools 通道
```

### 已知边界（后续里程碑）

- P1 规划：SSE/Streamable HTTP 多传输、API Key 认证与权限分组、审计日志、Prometheus 指标、Docker 部署
- P2 规划：语义检索、技能依赖编排、多租户、Webhook 通知
- Commit Hash 历史版本读取：deferred（需求 3.3 可选项）
- SDK 稳定版（1.32.x）早于 SEP-2640 合并（2026-09-13），扩展方法经底层 handler + 自带 schema 实现；SDK 2.x 稳定后可切换官方实现
- 私有仓库认证采用"remote url 临时改写 + 仓库级操作串行化"，凭据不落盘；彻底方案（per-invocation 凭据注入）列为 P1 backlog
- 安全基线：路径读取双重边界（仓库根 + 技能目录）、软链接/隐藏目录（.git）禁入、超限技能（512 文件/16MiB）不发布

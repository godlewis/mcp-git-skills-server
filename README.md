# MCP Git Skills Server (POC)

一个 POC 级 MCP Server：从本地 Git 仓库读取"业务技能（Skill）"，通过 **MCP Resources + Tools 双通道**实现**三层渐进式披露**。技能内容完全由 Git 管理（支持 pull 更新），Server 自身不存储任何技能内容，且无缓存——pull 之后新技能立即可见，无需重启。

- 运行时：Node.js ≥ 20
- 语言：TypeScript
- MCP SDK：[@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)（stdio 传输）
- 技能格式：SKILL.md + YAML front matter（与 Anthropic Agent Skills 社区格式兼容）

## 三层渐进式披露设计

| 层级 | Resources 通道 | Tools 通道 | 对应代码 |
|---|---|---|---|
| 第一层：技能索引 Catalog | resource `git-skills://catalog`（唯一 concrete resource） | 工具 `list_skills` | `src/skill-registry.ts` 扫描生成；渲染在 `src/catalog-parser.ts` |
| 第二层：SKILL.md 技能流程 | 模板 `git-skills://skills/{skill_id}/SKILL.md` + `resources/read` | 工具 `load_skill(skill_id)` | `src/resource-handler.ts` 的 `getSkillDoc()` |
| 第三层：子文档 | 模板 `git-skills://skills/{skill_id}/files/{file_path}` + `resources/read` | 工具 `read_skill_file(skill_id, file_path)`；`list_skill_files(skill_id)` 用于发现 | `src/resource-handler.ts` 的 `getSkillFile()`（含路径安全校验） |

两条通道读的是同一份仓库文件，按客户端能力任选：

- **Resources 通道**（规范路线）：`resources/list` 只返回 catalog 一个资源，子文档以模板形式存在，在 SKILL.md 被读取前对模型完全不可见。
- **Tools 通道**（兼容路线）：所有 MCP 客户端都会把 tools 透传给模型。工具调用失败以 `isError` 结果返回友好消息，模型可以读取并重试。

工作方式：模型先看 Catalog（每个条目含**触发时机**），判断命中后加载该技能的 SKILL.md；SKILL.md 正文引用的子文档（如 `references/budget-rules.md`）此时仍不可见，执行到具体步骤时才按引用读取。

## 技能仓库结构

```
skills-repo/
├── purchase-apply/
│   ├── SKILL.md                # front matter 提供技能元数据（name/description/summary）
│   └── references/             # 第三层：子文档
├── stock-check/…
└── expense-report/…
```

技能元数据来自每个 SKILL.md 开头的 YAML front matter（**name 与 description 必填**，description 即触发时机）：

```markdown
---
name: 采购申请处理
description: 当用户需要创建采购申请、提交采购草稿、查询采购预算是否充足时使用。
summary: 处理采购全流程：预算校验→物料库存核对→创建采购草稿→审批流程指引
---

# 采购申请处理流程
（正文…）
```

- **无需维护独立索引文件**：Catalog 由 Server 扫描各技能目录的 front matter 动态生成，永远与仓库实际内容一致，不会漂移；社区 Agent Skills 仓库可直接使用。
- **动态发现**：每次读取 Catalog 都重新扫描文件系统，`git pull` 或手动新增/删除技能目录后立即生效，无需重启。
- **容错**：缺少 front matter 或缺少必填字段的技能会被跳过并在 stderr 记录警告，不影响其他技能。

## 构建

```bash
npm install
npm run build
```

## 启动参数（环境变量）

| 变量 | 必填 | 说明 |
|---|---|---|
| `SKILLS_REPO_PATH` | 是 | 本地 Git 技能仓库路径 |
| `SKILLS_REPO_URL` | 否 | 远程 Git 仓库 URL。配置后：目录不存在时自动 clone，已存在时启动自动 pull |

快速本地启动（POC 自带示例技能仓库）：

```bash
# Git Bash
SKILLS_REPO_PATH=/d/path/to/mcp-git-skills-server/skills-repo npm start

# PowerShell
$env:SKILLS_REPO_PATH="D:\path\to\mcp-git-skills-server\skills-repo"; npm start
```

## 在 Claude Code 中配置

在 MCP 配置文件（`.mcp.json` 或 `~/.claude.json` 的 `mcpServers`）中加入：

```json
{
  "mcpServers": {
    "git-skills": {
      "command": "node",
      "args": ["/path/to/mcp-git-skills-server/dist/index.js"],
      "env": {
        "SKILLS_REPO_PATH": "/path/to/skills-repo"
      }
    }
  }
}
```

如需启动时自动同步远程仓库，追加 `"SKILLS_REPO_URL": "https://git.example.com/team/skills-repo.git"`。

## 用 MCP Inspector 验证

```bash
npx @modelcontextprotocol/inspector node dist/index.js
# 在 Inspector UI 的 env 中填入 SKILLS_REPO_PATH 后 Connect
```

逐项验证（详见 [test/manual-test.md](test/manual-test.md)）：

1. **第一层**：`resources/list` 只返回 `git-skills://catalog`；读取它（或调用 `list_skills`）返回带 SKILL.md 完整 URI 的技能目录。
2. **第二层**：读取 `git-skills://skills/purchase-apply/SKILL.md`（或 `load_skill("purchase-apply")`）返回完整流程。
3. **第三层**：读取 `git-skills://skills/purchase-apply/files/references/budget-rules.md`（或 `read_skill_file`）返回子文档内容。
4. **动态发现**：在 skills-repo 里新增一个带 front matter 的技能目录，重新读取 Catalog 立即出现，无需重启。
5. **错误处理**：不存在的 URI 返回友好错误；`../`、绝对路径等越权读取被路径安全校验拒绝。
6. **Git 更新**：`pull_skills` 工具执行 git pull 并返回状态。

## 给弱客户端生成 system prompt 片段

当目标 agent 既不支持 Resources 也不支持 Tools 时，可用 CLI 把"第一层"打印成可粘贴的 system prompt 片段：

```bash
SKILLS_REPO_PATH=/path/to/skills-repo npm run metadata
```

技能更新后重新执行即可（按需生成，不是手工维护）。

## 项目结构

```
mcp-git-skills-server/
├── src/
│   ├── index.ts              # MCP Server 入口：Resources + Tools 双通道注册与分发
│   ├── skill-registry.ts     # 扫描发现：解析 SKILL.md front matter（无缓存，动态）
│   ├── catalog-parser.ts     # 第一层：渲染带 URI 的技能目录
│   ├── resource-handler.ts   # 双通道共用的数据层：三层读取 + 路径安全校验
│   ├── git-manager.ts        # Git clone/pull 逻辑（simple-git）
│   └── cli.ts                # npm run metadata：打印 system prompt 技能清单片段
├── skills-repo/              # POC 示例技能仓库（普通目录；如需练习 git pull，进入后自行 git init）
├── test/
│   ├── smoke-test.mjs        # 自动验收：34 项检查（两条通道 + 动态发现 + 安全）
│   └── manual-test.md        # 手动测试步骤
├── package.json
└── tsconfig.json
```

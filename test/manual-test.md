# 手动测试步骤

前置条件：`npm run build` 已通过。Server 对技能的发现与读取都是动态的（无缓存），所有步骤无需重启。

## 1. 启动 MCP Inspector 并连接 Server

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

在 Inspector 的 Environment 中配置 `SKILLS_REPO_PATH`（指向 `skills-repo` 的绝对路径），点击 Connect。

## 2. 第一层：技能索引 Catalog

- 调用 `resources/list`：**确认只看到 `git-skills://catalog` 一个资源**。
- 调用 `resources/templates/list`：**确认返回两个模板**（`git-skills://skills/{skill_id}/SKILL.md` 与 `git-skills://skills/{skill_id}/files/{file_path}`）。
- 读取 `git-skills://catalog`：确认返回 Markdown 目录，包含 3 个技能（expense-report / purchase-apply / stock-check），每个条目有**触发时机**和 SKILL.md 的完整 URI。
- 调用工具 `list_skills`：确认返回与 Catalog 相同的目录内容（双通道一致）。

## 3. 第二层：SKILL.md

模拟"用户要做采购申请"的场景：根据 Catalog 中 purchase-apply 的触发时机判断命中，然后：

- 读取 `git-skills://skills/purchase-apply/SKILL.md`（Resources 通道），或调用 `load_skill(skill_id="purchase-apply")`（Tools 通道）。
- 确认返回完整流程：前置条件、三个步骤（预算校验 → 库存核对 → 创建采购草稿）、注意事项，并且内容中**引用了子文档**（`references/budget-rules.md`、`references/stock-thresholds.md`、`references/draft-fields.md`、`references/approval-matrix.md`）。
- `load_skill` 的返回应已剥离 front matter，并附有子文档读取方法的提示。

## 4. 第三层：子文档

模拟执行到步骤 1（预算校验），按 SKILL.md 中的引用读取：

- 读取 `git-skills://skills/purchase-apply/files/references/budget-rules.md`，或调用 `read_skill_file(skill_id="purchase-apply", file_path="references/budget-rules.md")`。
- 确认返回预算校验的详细规则（80% 阈值、跨月申请等）。
- 调用 `list_skill_files(skill_id="purchase-apply")`：确认列出该技能全部 4 个子文档。

## 5. 动态发现（Git 闭环的关键）

1. 在 `skills-repo` 下新建目录 `demo-skill/`，写入一个带 front matter 的 SKILL.md（name/description 必填）。
2. 重新读取 `git-skills://catalog` 或调用 `list_skills`：**新技能立即出现，无需重启 Server**。
3. 再新建 `demo-broken/`，其中 SKILL.md **不带** front matter：重新读取 Catalog，确认该技能被跳过（Server stderr 会出现"跳过技能"警告，其他技能不受影响）。
4. 删除这两个目录，确认 Catalog 同步消失。

## 6. 错误处理与路径安全

- 读取不存在的技能：`git-skills://skills/not-exist/SKILL.md` → 友好错误，且**错误信息里列出当前可用技能**。
- 读取不存在的子文档：`git-skills://skills/purchase-apply/files/references/no-such.md` → 友好错误。
- 读取无法识别的 URI：`git-skills://whatever` → 友好错误（URI 无法识别）。
- **路径越权**（Resources 与 Tools 通道都要试）：
  - `git-skills://skills/purchase-apply/files/../../catalog.md`
  - `git-skills://skills/purchase-apply/files/../../etc/passwd`
  - `read_skill_file(file_path="C:/Windows/win.ini")`（Windows 绝对路径绕过）
  - **确认全部被拒绝**（返回"路径越权访问被拒绝"，而不是文件内容）。
- 工具通道调用 `load_skill` 不带参数 → 返回 `isError` 结果，消息指明缺少 `skill_id`。

## 7. pull_skills 工具

- 在 Inspector 的 Tools 中调用 `pull_skills`：
  - 示例仓库未配置远程时，返回"仓库未配置远程，跳过 pull"的说明（不报错）。
  - 若配置了 `SKILLS_REPO_URL` 且有新提交，返回是否有更新及更新文件列表；pull 下来的新技能**立即**可被 Catalog 发现（见步骤 5）。

## 8. Git 内容更新验证

1. 修改 `skills-repo/purchase-apply/references/budget-rules.md`（比如把 80% 改成 90%），保存。
2. 重新读取该子文档：**确认拿到修改后的最新内容**（Server 无缓存，每次读取直接读仓库文件）。
3. （可选）`git -C skills-repo add -A && git -C skills-repo commit -m "update"` 提交变更，再调用 `pull_skills` 确认状态返回正常。

## 9. CLI 元数据命令（可选）

```bash
SKILLS_REPO_PATH="$(pwd)/skills-repo" npm run metadata
```

确认输出可粘贴到 agent system prompt 的技能清单片段（含每个技能的名称与触发时机）。

## 10. 自动化冒烟测试（可选）

```bash
node test/smoke-test.mjs
```

预期：34 项检查全部 PASS（Resources 通道 17 项、Tools 通道 11 项、动态发现 3 项、内容更新 1 项等）。

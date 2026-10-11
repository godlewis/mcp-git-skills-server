/**
 * cli.ts — 元数据 CLI：把技能仓库扫描结果打印成可粘贴到 agent system prompt 的技能清单片段。
 *
 * 用途：当目标 agent/客户端既不支持 MCP Resources 也不支持 MCP Tools 时（渐进式披露两条通道都不可用），
 * 可以用本命令生成"第一层"快照手动放进 system prompt；技能更新后重新执行即可。
 *
 * 用法：SKILLS_REPO_PATH=<repo> npm run metadata
 *   或：node dist/cli.js <repo-path>
 */

import { scanSkills } from "./skill-registry.js";

async function main(): Promise<void> {
  const repoPath = process.argv[2] ?? process.env.SKILLS_REPO_PATH;
  if (!repoPath) {
    console.error("用法: node dist/cli.js <skills-repo-path>，或设置环境变量 SKILLS_REPO_PATH");
    process.exit(1);
  }

  const { entries, warnings } = await scanSkills(repoPath);
  for (const warning of warnings) {
    console.error(`[git-skills] ${warning}`);
  }
  if (entries.length === 0) {
    console.error(`[git-skills] 在 ${repoPath} 中没有发现有效技能`);
    process.exit(1);
  }

  const lines = [
    "## 可用技能",
    "",
    "当用户任务匹配某个技能的触发时机时，先加载该技能的详细流程再执行。",
    "",
  ];
  for (const entry of entries) {
    lines.push(`- **${entry.name} (${entry.skillId})**: ${entry.whenToUse}`);
  }
  console.log(lines.join("\n"));
}

main().catch((error: Error) => {
  console.error(`[git-skills] 执行失败: ${error.message}`);
  process.exit(1);
});

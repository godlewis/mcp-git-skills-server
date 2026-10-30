/**
 * cli.ts — 元数据 CLI：把技能仓库扫描结果打印成可粘贴到 agent system prompt 的技能清单片段。
 *
 * 用途：当目标 agent/客户端既不支持 MCP Resources 也不支持 MCP Tools 时（渐进式披露三条
 * 通道都不可用），可以用本命令生成"第一层"快照手动放进 system prompt；技能更新后重新执行即可。
 *
 * 用法：
 *   npm run metadata                          —— 走配置体系（--config / SKILLS_CONFIG / 默认文件）
 *   node dist/cli.js <skills-repo-path>       —— POC 兼容用法：直接指定仓库路径（default 命名空间）
 */

import { loadConfig, parseCliArgs } from "./infrastructure/config.js";
import { Logger } from "./infrastructure/logger.js";
import { SkillCatalog } from "./services/skill-catalog.js";

async function main(): Promise<void> {
  const repoPathArg = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : undefined;
  let catalog: SkillCatalog;

  if (repoPathArg) {
    catalog = new SkillCatalog(
      [{ namespace: "default", path: repoPathArg }],
      new Logger("error"),
    );
  } else {
    const { config, warnings } = loadConfig(parseCliArgs(process.argv.slice(2)), process.env);
    for (const warning of warnings) {
      process.stderr.write(`[git-skills] ${warning}\n`);
    }
    catalog = new SkillCatalog(config.repos, new Logger("error"));
  }

  const { skills, warnings: scanWarnings } = await catalog.scanAll();
  for (const warning of scanWarnings) {
    process.stderr.write(`[git-skills] ${warning}\n`);
  }
  if (skills.length === 0) {
    process.stderr.write("[git-skills] 没有发现有效技能\n");
    process.exit(1);
  }

  const lines = [
    "## 可用技能",
    "",
    "当用户任务匹配某个技能的触发时机时，先加载该技能的详细流程再执行。",
    "",
  ];
  for (const skill of skills) {
    lines.push(`- **${catalog.displayId(skill)}**: ${String(skill.frontmatter["description"] ?? "")}`);
  }
  console.log(lines.join("\n"));
}

main().catch((error: Error) => {
  process.stderr.write(`[git-skills] 执行失败: ${error.message}\n`);
  process.exit(1);
});

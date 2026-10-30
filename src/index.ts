/**
 * index.ts — MCP Server 入口（stdio 传输）。
 *
 * 四层装配（需求文档 8.1）：
 * 基础设施层（配置/日志）→ 存储层（Git 仓库/扫描）→ 服务层（目录聚合/Git 编排）→ 协议层（MCP Server）
 *
 * 客户端访问通道（三重兼容，需求文档 2.5）：
 * - 通道 A（标准）：SEP-2640 Skills 扩展 — skills/list、skills/get、resources/directory/read
 * - 通道 B（Resources）：skill://{ns}/catalog 与 git-skills://catalog 等 URI，三层渐进式披露
 * - 通道 C（Tools）：list_skills / load_skill / read_skill_file / list_skill_files / pull_skills / get_skills_version
 *
 * 另有 cli.ts：把技能清单导出为可粘贴到 system prompt 的元数据片段（弱客户端兜底）。
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, parseCliArgs } from "./infrastructure/config.js";
import { Logger } from "./infrastructure/logger.js";
import { SkillCatalog } from "./services/skill-catalog.js";
import { GitManager } from "./services/git-manager.js";
import { buildMcpServer, SERVER_VERSION } from "./protocol/mcp-server.js";

async function main(): Promise<void> {
  // ---- 基础设施层：配置（命令行 > 环境变量 > 配置文件 > 默认值） ----
  const cli = parseCliArgs(process.argv.slice(2));
  const { config, secrets, warnings } = loadConfig(cli, process.env);
  const log = new Logger(config.logLevel, secrets);
  for (const warning of warnings) {
    log.warn(warning);
  }

  // 启动配置摘要（脱敏后），便于确认运行参数
  const repoSummary = config.repos
    .map((r) => {
      const remote = r.url ? `(远程${r.branch ? `@${r.branch}` : ""})` : "(本地)";
      return `${r.namespace}=${r.path}${remote}`;
    })
    .join(", ");
  log.info(
    `配置摘要: 仓库 [${repoSummary}], 自动pull=${config.autoPullOnStartup}, 兼容通道 tools=${config.compat.legacyTools}/uris=${config.compat.legacyGitSkillsUris}, pageSize=${config.pageSize}`,
  );

  // ---- 存储层 + 服务层：Git 编排与技能目录 ----
  const gitManager = new GitManager(config.repos, log, config.autoPullOnStartup);
  const sync = await gitManager.startupSync();
  if (sync.failed.length > 0) {
    // 单仓库失败不影响整体服务（需求文档 3.2 / 9.3），仅记录并继续
    log.error(`启动同步: ${sync.failed.length} 个仓库失败 [${sync.failed.map((f) => f.namespace).join(", ")}]`);
  }
  const catalog = new SkillCatalog(config.repos, log, {
    legacyGitSkillsUris: config.compat.legacyGitSkillsUris,
  });

  // ---- 协议层：MCP Server ----
  const server = buildMcpServer({ catalog, gitManager, config });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info(`MCP Server 已启动（stdio 传输，v${SERVER_VERSION}）`);
}

main().catch((error: Error) => {
  process.stderr.write(`[git-skills] 启动失败: ${error.message}\n`);
  process.exit(1);
});

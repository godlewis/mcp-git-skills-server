/**
 * index.ts — MCP Server 入口（stdio 传输）。
 *
 * 三层渐进式披露有两条等价通道，读的是同一份 Git 仓库内容（resource-handler.ts）：
 *
 * 通道 A（MCP Resources，规范路线）：
 * - 第一层：resources/list           → 只暴露 git-skills://catalog 一个 concrete resource
 * - 第二/三层：resources/templates/list → 暴露 SKILL.md 与 files 两个 URI 模板
 * - 按需读取：resources/read          → 按三层分支读取 Git 仓库中的文件
 *
 * 通道 B（MCP Tools，兼容路线）：对不支持 Resources 的客户端，提供等价的 4 个工具
 * - list_skills / load_skill / read_skill_file / list_skill_files
 *
 * 另有 pull_skills 工具：手动拉取最新技能内容（git pull）。
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GitManager } from "./git-manager.js";
import { ResourceHandler } from "./resource-handler.js";

// ---------------------------------------------------------------------------
// 通道 A 第一层：resources/list 唯一返回的 concrete resource
// ---------------------------------------------------------------------------
const CATALOG_RESOURCE = {
  uri: "git-skills://catalog",
  name: "技能目录",
  description: "所有可用业务技能的索引，包含触发时机说明。按需读取。",
  mimeType: "text/markdown",
} as const;

// ---------------------------------------------------------------------------
// 通道 A 第二层 / 第三层：resources/templates/list 返回的两个 URI 模板
// 模型一开始只看到 Catalog，读完目录后按其中的 URI 规则按需构造具体 URI 读取
// ---------------------------------------------------------------------------
const RESOURCE_TEMPLATES = [
  {
    uriTemplate: "git-skills://skills/{skill_id}/SKILL.md",
    name: "技能详细流程",
    description: "读取指定技能的完整 SKILL.md 流程文档",
  },
  {
    uriTemplate: "git-skills://skills/{skill_id}/files/{file_path}",
    name: "技能子文档",
    description: "读取技能引用的参考文档，如规则、模板、检查清单",
  },
] as const;

// ---------------------------------------------------------------------------
// 通道 B + Git 闭环：全部工具定义
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "list_skills",
    description:
      "列出所有可用业务技能及其触发时机（第一层目录）。先根据用户任务判断是否命中某个技能，再调用 load_skill 加载详细流程。",
    inputSchema: { type: "object" as const, properties: {}, required: [] as string[] },
  },
  {
    name: "load_skill",
    description:
      "加载指定技能的完整流程文档（SKILL.md 正文，第二层）。先用 list_skills 根据触发时机确认要加载哪个技能。",
    inputSchema: {
      type: "object" as const,
      properties: { skill_id: { type: "string", description: "技能唯一标识，如 purchase-apply" } },
      required: ["skill_id"],
    },
  },
  {
    name: "read_skill_file",
    description:
      "读取技能引用的子文档（第三层），如 SKILL.md 中提到的规则、模板、检查清单。file_path 为相对技能目录的路径，如 references/budget-rules.md。",
    inputSchema: {
      type: "object" as const,
      properties: {
        skill_id: { type: "string", description: "技能唯一标识" },
        file_path: { type: "string", description: "技能内相对路径，如 references/budget-rules.md" },
      },
      required: ["skill_id", "file_path"],
    },
  },
  {
    name: "list_skill_files",
    description: "列出指定技能下全部子文档的相对路径。当 SKILL.md 没有明确列出引用文件时，用它发现可用资料。",
    inputSchema: {
      type: "object" as const,
      properties: { skill_id: { type: "string", description: "技能唯一标识" } },
      required: ["skill_id"],
    },
  },
  {
    name: "pull_skills",
    description: "从远程 Git 仓库拉取最新的技能内容（git pull），返回是否有新提交及更新的文件列表。",
    inputSchema: { type: "object" as const, properties: {}, required: [] as string[] },
  },
] as const;

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: `错误: ${message}` }], isError: true };
}

function requireString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`参数 ${field} 必须是非空字符串`);
  }
  return value;
}

async function main(): Promise<void> {
  // 启动参数：环境变量 SKILLS_REPO_PATH（必填）、SKILLS_REPO_URL（可选）
  const repoPath = process.env.SKILLS_REPO_PATH;
  if (!repoPath) {
    console.error("[git-skills] 缺少必填环境变量 SKILLS_REPO_PATH（本地 Git 技能仓库路径）");
    process.exit(1);
  }
  const repoUrl = process.env.SKILLS_REPO_URL;

  const gitManager = new GitManager(repoPath, repoUrl);
  const handler = new ResourceHandler(repoPath);

  try {
    await gitManager.syncOnStartup();
  } catch (error) {
    console.error(`[git-skills] 启动时同步技能仓库失败: ${(error as Error).message}`);
    process.exit(1);
  }
  console.error(`[git-skills] 技能仓库就绪: ${repoPath}`);

  const server = new Server(
    { name: "git-skills-server", version: "0.2.0" },
    { capabilities: { resources: {}, tools: {} } },
  );

  // ---- 通道 A：Resources ----
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [CATALOG_RESOURCE],
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [...RESOURCE_TEMPLATES],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const content = await handler.read(request.params.uri);
    return {
      contents: [{ uri: request.params.uri, mimeType: content.mimeType, text: content.text }],
    };
  });

  // ---- 通道 B：Tools ----
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((tool) => ({ ...tool })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case "list_skills":
          return textResult(await handler.getCatalogText());

        case "load_skill": {
          const skillId = requireString(args, "skill_id");
          const body = await handler.getSkillDocBody(skillId);
          return textResult(
            `${body}\n\n---\n（以上是 ${skillId} 的完整流程。执行中如需查看该技能引用的子文档，用 read_skill_file 读取；不确定有哪些子文档时，用 list_skill_files 查看。）`,
          );
        }

        case "read_skill_file": {
          const skillId = requireString(args, "skill_id");
          const filePath = requireString(args, "file_path");
          return textResult(await handler.getSkillFile(skillId, filePath));
        }

        case "list_skill_files": {
          const skillId = requireString(args, "skill_id");
          const files = await handler.listSkillFiles(skillId);
          return textResult(
            files.length > 0
              ? `技能 ${skillId} 的子文档：\n${files.map((file) => `- ${file}`).join("\n")}`
              : `技能 ${skillId} 没有子文档。`,
          );
        }

        case "pull_skills": {
          const result = await gitManager.pull();
          return textResult(
            `${result.message}\n更新文件: ${result.changedFiles.length > 0 ? result.changedFiles.join(", ") : "无"}`,
          );
        }

        default:
          throw new McpError(ErrorCode.InvalidParams, `未知工具: ${name}`);
      }
    } catch (error) {
      // 工具错误以 isError 结果返回，模型能读到消息并重试，而不是拿到不可读的协议错误
      return errorResult((error as Error).message);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[git-skills] MCP Server 已启动（stdio 传输）");
}

main().catch((error: Error) => {
  console.error(`[git-skills] 启动失败: ${error.message}`);
  process.exit(1);
});

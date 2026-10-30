/**
 * tools.ts — 协议层：MCP Tools 通道（原 POC 通道 B，向下兼容 + 增强）。
 *
 * 工具清单（legacy 四件套可通过 compat.legacyTools 关闭，需求文档 2.5）：
 * - list_skills（增强）：keyword/tag/repo 服务端过滤 + 排序（需求文档 3.4）
 * - load_skill（增强）：mode=summary 摘要模式——front matter + 标题大纲（需求文档 3.1）
 * - read_skill_file / list_skill_files（增强）：子文件元数据预览（需求文档 3.1）
 * - pull_skills（增强）：可选 repo/branch 切分支 + 拉取，返回技能级更新明细（需求文档 3.3）
 * - get_skills_version（新增）：当前分支 / commit / 更新时间（需求文档 3.3）
 */

import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SkillCatalog } from "../services/skill-catalog.js";
import type { GitManager } from "../services/git-manager.js";
import { stripFrontMatter } from "../storage/skills-scanner.js";
import type { CompatConfig } from "../types.js";

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 属于 POC 原生工具的标记，受 compat.legacyTools 开关控制 */
  legacy: boolean;
}

const TOOLS: ToolDefinition[] = [
  {
    name: "list_skills",
    description:
      "列出可用业务技能及其触发时机（第一层目录）。支持 keyword 关键词模糊匹配（匹配名称/描述/标签）、tag 标签精准过滤、repo 按仓库筛选、sort=mtime 按更新时间排序。先根据用户任务判断是否命中某个技能，再调用 load_skill 加载详细流程。",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "关键词模糊匹配 name/description/summary/tags" },
        tag: { type: "string", description: "按标签精准过滤" },
        repo: { type: "string", description: "按仓库命名空间筛选" },
        sort: { type: "string", enum: ["name", "mtime"], description: "排序方式，mtime 为按更新时间降序" },
      },
    },
    legacy: true,
  },
  {
    name: "load_skill",
    description:
      "加载指定技能的流程文档（第二层）。默认 mode=full 返回完整正文；mode=summary 仅返回元数据与标题大纲（摘要模式）。先用 list_skills 确认要加载哪个技能。",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string", description: "技能 ID，如 purchase-apply；多仓库时可用 命名空间/技能ID" },
        mode: { type: "string", enum: ["summary", "full"], description: "summary=摘要大纲，full=完整正文（默认）" },
      },
      required: ["skill_id"],
    },
    legacy: true,
  },
  {
    name: "read_skill_file",
    description:
      "读取技能引用的子文档（第三层），如 SKILL.md 中提到的规则、模板、检查清单。file_path 为相对技能目录的路径，如 references/budget-rules.md。",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string", description: "技能 ID" },
        file_path: { type: "string", description: "技能内相对路径，如 references/budget-rules.md" },
      },
      required: ["skill_id", "file_path"],
    },
    legacy: true,
  },
  {
    name: "list_skill_files",
    description: "列出指定技能下全部子文档的名称、大小与更新时间（元数据预览，内容需 read_skill_file 读取）。",
    inputSchema: {
      type: "object",
      properties: { skill_id: { type: "string", description: "技能 ID" } },
      required: ["skill_id"],
    },
    legacy: true,
  },
  {
    name: "pull_skills",
    description:
      "从远程 Git 仓库拉取最新技能内容，返回技能级更新明细（新增/修改/删除了哪些技能）。可选 repo 指定仓库、branch 指定分支（拉取前切换分支）。",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "仓库命名空间；省略则拉取全部仓库" },
        branch: { type: "string", description: "拉取前切换到该分支（需求文档 3.3 运行时切分支）" },
      },
    },
    legacy: false,
  },
  {
    name: "get_skills_version",
    description: "查询技能仓库当前版本状态：分支、commit、最近提交时间。",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string", description: "仓库命名空间；省略则查询全部仓库" } },
    },
    legacy: false,
  },
];

export interface ToolsDeps {
  catalog: SkillCatalog;
  gitManager: GitManager;
  compat: CompatConfig;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: `错误: ${message}` }], isError: true };
}

function requireString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new McpError(ErrorCode.InvalidParams, `参数 ${field} 必须是非空字符串`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function formatBytes(size: number): string {
  return size >= 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`;
}

async function dispatchTool(deps: ToolsDeps, name: string, args: Record<string, unknown>): Promise<string> {
  const { catalog, gitManager } = deps;
  switch (name) {
    case "list_skills": {
      const { skills } = await catalog.scanAll();
      const filtered = catalog.filterSkills(skills, {
        keyword: optionalString(args, "keyword"),
        tag: optionalString(args, "tag"),
        repo: optionalString(args, "repo"),
        sort: optionalString(args, "sort"),
      });
      return catalog.renderCatalog(filtered);
    }

    case "load_skill": {
      const skillId = requireString(args, "skill_id");
      const skill = await catalog.resolveById(skillId);
      const mode = optionalString(args, "mode") ?? "full";
      if (mode === "summary") {
        return catalog.renderSummary(skill);
      }
      if (mode !== "full") {
        throw new McpError(ErrorCode.InvalidParams, `参数 mode 只支持 summary 或 full，收到: ${mode}`);
      }
      const body = await catalog.readSkillFileChecked(skill, "SKILL.md");
      // 与 POC 行为一致：剥掉 front matter 只给正文（摘要模式的元数据走 mode=summary）
      const content = stripFrontMatter(body);
      const manifestTip = skill.manifest.length > 1
        ? `可用子文档: ${skill.manifest.filter((e) => e.relPath !== "SKILL.md").map((e) => e.relPath).join(", ")}。执行中如需查看某个子文档，用 read_skill_file 读取。`
        : "该技能没有子文档。";
      return `${content}\n\n---\n（以上是 ${catalog.displayId(skill)} 的完整流程。${manifestTip}）`;
    }

    case "read_skill_file": {
      const skillId = requireString(args, "skill_id");
      const filePath = requireString(args, "file_path");
      const skill = await catalog.resolveById(skillId);
      return catalog.readSkillFileChecked(skill, filePath);
    }

    case "list_skill_files": {
      const skillId = requireString(args, "skill_id");
      const skill = await catalog.resolveById(skillId);
      const files = catalog.listSkillFiles(skill);
      if (files.length === 0) return `技能 ${catalog.displayId(skill)} 没有子文档。`;
      const lines = files.map(
        (file) =>
          `- ${file.relPath}（${formatBytes(file.size)}，更新于 ${new Date(file.mtimeMs).toISOString().slice(0, 19).replace("T", " ")}）`,
      );
      return `技能 ${catalog.displayId(skill)} 的子文档：\n${lines.join("\n")}`;
    }

    case "pull_skills": {
      return gitManager.pull({
        repo: optionalString(args, "repo"),
        branch: optionalString(args, "branch"),
      });
    }

    case "get_skills_version": {
      return gitManager.versionReport(optionalString(args, "repo"));
    }

    default:
      throw new McpError(ErrorCode.InvalidParams, `未知工具: ${name}`);
  }
}

export function registerTools(server: Server, deps: ToolsDeps): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.filter((tool) => !tool.legacy || deps.compat.legacyTools).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      // 工具错误以 isError 结果返回，模型能读到消息并重试，而不是拿到不可读的协议错误
      return textResult(await dispatchTool(deps, name, args));
    } catch (error) {
      return errorResult((error as Error).message);
    }
  });
}

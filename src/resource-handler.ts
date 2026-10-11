/**
 * resource-handler.ts — 技能内容的统一数据层。
 *
 * resources/read（资源通道）与 list_skills / load_skill / read_skill_file / list_skill_files
 * （工具通道）都调用本类的方法，保证两条通道读到的是同一份仓库内容。
 *
 * 三层渐进式披露对应的读取分支：
 * - 第一层 git-skills://catalog                          → 扫描仓库生成带 URI 的技能目录（动态，无缓存）
 * - 第二层 git-skills://skills/{skill_id}/SKILL.md       → 读技能目录下的 SKILL.md
 * - 第三层 git-skills://skills/{skill_id}/files/{path}   → 读技能引用的子文档（SKILL.md 被读取前对模型不可见）
 */

import fs from "node:fs/promises";
import path from "node:path";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { renderCatalog } from "./catalog-parser.js";
import { scanSkills, stripFrontMatter } from "./skill-registry.js";

/** 资源读取结果 */
export interface ResourceContent {
  mimeType: string;
  text: string;
}

/** 第二层 URI：git-skills://skills/{skill_id}/SKILL.md */
const SKILL_DOC_PATTERN = /^git-skills:\/\/skills\/([^/]+)\/SKILL\.md$/;
/** 第三层 URI：git-skills://skills/{skill_id}/files/{file_path}，file_path 支持多级子路径 */
const SKILL_FILE_PATTERN = /^git-skills:\/\/skills\/([^/]+)\/files\/(.+)$/;

export class ResourceHandler {
  constructor(private readonly repoPath: string) {}

  // ---------------------------------------------------------------------
  // 资源通道入口：resources/read 按 URI 分发
  // ---------------------------------------------------------------------
  async read(uri: string): Promise<ResourceContent> {
    if (uri === "git-skills://catalog") {
      return { mimeType: "text/markdown", text: await this.getCatalogText() };
    }

    const skillDocMatch = SKILL_DOC_PATTERN.exec(uri);
    if (skillDocMatch) {
      return {
        mimeType: "text/markdown",
        text: await this.getSkillDoc(decodeURIComponent(skillDocMatch[1] as string)),
      };
    }

    const fileMatch = SKILL_FILE_PATTERN.exec(uri);
    if (fileMatch) {
      const text = await this.getSkillFile(
        decodeURIComponent(fileMatch[1] as string),
        decodeURIComponent(fileMatch[2] as string),
      );
      return { mimeType: "text/markdown", text };
    }

    throw new McpError(
      ErrorCode.InvalidParams,
      `无法识别的资源 URI: ${uri}。可用资源：git-skills://catalog，或模板 git-skills://skills/{skill_id}/SKILL.md 与 git-skills://skills/{skill_id}/files/{file_path}`,
    );
  }

  // ---------------------------------------------------------------------
  // 双通道共用的四个读取操作
  // ---------------------------------------------------------------------

  /** 第一层：扫描仓库生成 Catalog（每次现扫，git pull / 新增技能后立即生效） */
  async getCatalogText(): Promise<string> {
    const { entries, warnings } = await scanSkills(this.repoPath);
    for (const warning of warnings) {
      console.error(`[git-skills] ${warning}`);
    }
    if (entries.length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "技能仓库中没有发现任何有效技能。每个技能需要 <skill_id>/SKILL.md，且文件开头带有包含 name 与 description 的 YAML front matter。",
      );
    }
    return renderCatalog(entries);
  }

  /** 第二层：读取技能的 SKILL.md（resources/read 返回原始内容；load_skill 工具会另行剥离 front matter） */
  async getSkillDoc(skillId: string): Promise<string> {
    const skillPath = path.join(this.repoPath, skillId, "SKILL.md");
    const markdown = await this.readFileOrNull(skillPath);
    if (markdown === null) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `技能流程文档不存在: git-skills://skills/${skillId}/SKILL.md。可用技能: ${await this.availableSkillIds()}`,
      );
    }
    return markdown;
  }

  /** 第二层给工具通道用：返回剥离 front matter 的 SKILL.md 正文 */
  async getSkillDocBody(skillId: string): Promise<string> {
    return stripFrontMatter(await this.getSkillDoc(skillId));
  }

  /** 第三层：读取技能引用的子文档，带路径安全校验 */
  async getSkillFile(skillId: string, filePath: string): Promise<string> {
    const repoRoot = path.resolve(this.repoPath);
    const resolved = path.resolve(repoRoot, skillId, filePath);
    this.assertWithinRepo(resolved, filePath);

    const content = await this.readFileOrNull(resolved);
    if (content === null) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `子文档不存在: git-skills://skills/${skillId}/files/${filePath}（对应文件 ${resolved}）`,
      );
    }
    return content;
  }

  /** 第三层给工具通道用：列出技能目录下所有子文档（相对路径，不含 SKILL.md） */
  async listSkillFiles(skillId: string): Promise<string[]> {
    const repoRoot = path.resolve(this.repoPath);
    const skillDir = path.resolve(repoRoot, skillId);
    this.assertWithinRepo(skillDir, skillId);

    try {
      const stat = await fs.stat(skillDir);
      if (!stat.isDirectory()) throw new Error("not a directory");
    } catch {
      throw new McpError(
        ErrorCode.InvalidParams,
        `技能不存在: ${skillId}。可用技能: ${await this.availableSkillIds()}`,
      );
    }

    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const dirent of await fs.readdir(dir, { withFileTypes: true })) {
        if (dirent.name.startsWith(".")) continue;
        const full = path.join(dir, dirent.name);
        if (dirent.isDirectory()) {
          await walk(full);
        } else if (dirent.isFile() && dirent.name !== "SKILL.md") {
          files.push(path.relative(path.join(this.repoPath, skillId), full).split(path.sep).join("/"));
        }
      }
    };
    await walk(skillDir);
    return files.sort();
  }

  // ---------------------------------------------------------------------
  // 内部工具方法
  // ---------------------------------------------------------------------

  /**
   * 路径安全校验：解析后的绝对路径必须仍位于仓库根目录内，
   * 禁止 ../、绝对路径、URL 编码（%2E%2E）等任何形式的越权访问。
   */
  private assertWithinRepo(resolved: string, originalPath: string): void {
    const repoRoot = path.resolve(this.repoPath);
    if (resolved !== repoRoot && !resolved.startsWith(repoRoot + path.sep)) {
      throw new McpError(ErrorCode.InvalidParams, `路径越权访问被拒绝: ${originalPath}`);
    }
  }

  private async availableSkillIds(): Promise<string> {
    const { entries } = await scanSkills(this.repoPath);
    return entries.length > 0 ? entries.map((entry) => entry.skillId).join(", ") : "（无）";
  }

  /** 读文件，不存在（ENOENT / 不是文件）时返回 null，其余错误原样抛出 */
  private async readFileOrNull(filePath: string): Promise<string | null> {
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) return null;
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}

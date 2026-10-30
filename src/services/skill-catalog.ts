/**
 * skill-catalog.ts — 服务层：多仓库技能目录的聚合、解析、检索与读取。
 *
 * 对应需求文档 3.2（多仓库聚合）、3.4（服务端检索）、2.3（URI 双前缀）与 SEP-2640：
 * - 技能 ID：单仓库下裸 relPath 直通；多仓库下 {namespace}/{relPath}；
 *   裸 ID 跨仓库冲突时报错并列出候选命名空间（Q3 决议）
 * - URI 双前缀：skill://（SEP-2640 标准，authority = 命名空间）+ git-skills://（POC 兼容，可关闭）
 * - 检索逻辑在服务端实现（keyword/tag/repo 过滤、按更新时间排序）
 * - 无缓存动态扫描：git pull 后立即可见（保留 POC 核心特性）
 *
 * 错误约定：服务层抛 McpError(-32602) 表示"找不到/冲突/URI 非法"，
 * Resources 与 Skills 扩展通道直接透传，Tools 通道转成 isError 文本结果。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { assertRealpathWithinRepo, assertWithinRepo, resolveWithinRepo } from "../storage/path-safety.js";
import { scanRepoSkills, stripFrontMatter } from "../storage/skills-scanner.js";
import type { RepoConfig, ScannedSkill } from "../types.js";
import type { Logger } from "../infrastructure/logger.js";

/** skills/list、skills/get、resources/read 的缓存提示字段值（SEP-2640 要求 REQUIRED） */
export const CACHE_HINTS = { resultType: "complete", ttlMs: 300000, cacheScope: "public" } as const;

export interface CatalogSnapshot {
  skills: ScannedSkill[];
  warnings: string[];
}

export interface CatalogFilter {
  /** 按仓库命名空间筛选 */
  repo?: string | undefined;
  /** 关键词模糊匹配 name/description/summary/tags */
  keyword?: string | undefined;
  /** 按标签精准过滤 */
  tag?: string | undefined;
  /** 排序：name（默认，按 namespace/relPath 升序）| mtime（按更新时间降序） */
  sort?: string | undefined;
}

export interface SkillFileMeta {
  relPath: string;
  size: number;
  mtimeMs: number;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".json": "application/json",
  ".csv": "text/csv",
};

export function mimeTypeFor(relPath: string): string {
  return MIME_BY_EXTENSION[path.extname(relPath).toLowerCase()] ?? "application/octet-stream";
}

export interface CatalogOptions {
  /** 是否提供 git-skills:// 兼容前缀（config.compat.legacyGitSkillsUris） */
  legacyGitSkillsUris: boolean;
}

export class SkillCatalog {
  constructor(
    private readonly repos: RepoConfig[],
    private readonly log: Logger,
    private readonly options: CatalogOptions = { legacyGitSkillsUris: true },
  ) {}

  // ---------------------------------------------------------------------
  // 扫描与快照
  // ---------------------------------------------------------------------

  /** 扫描全部仓库，聚合技能快照；告警统一记录日志，不抛错（单仓库坏不影响全局） */
  async scanAll(): Promise<CatalogSnapshot> {
    const skills: ScannedSkill[] = [];
    const warnings: string[] = [];
    for (const repo of this.repos) {
      try {
        const result = await scanRepoSkills(repo.path, repo.namespace);
        skills.push(...result.skills);
        warnings.push(...result.warnings.map((w) => `[${repo.namespace}] ${w}`));
      } catch (error) {
        warnings.push(`[${repo.namespace}] 扫描仓库失败: ${(error as Error).message}`);
      }
    }
    for (const warning of warnings) {
      this.log.warn(warning);
    }
    return { skills, warnings };
  }

  // ---------------------------------------------------------------------
  // URI 构造（标准 skill:// 与兼容 git-skills://）
  // ---------------------------------------------------------------------

  /** 标准前缀：skill://{namespace}/{relPath}/SKILL.md，authority = 命名空间 */
  skillDocUri(skill: ScannedSkill): string {
    return `skill://${skill.namespace}/${skill.relPath}/SKILL.md`;
  }

  /** 标准前缀：skill://{namespace}/{relPath}/{fileRel} */
  skillFileUri(skill: ScannedSkill, fileRel: string): string {
    return `skill://${skill.namespace}/${skill.relPath}/${fileRel}`;
  }

  /** 模型看到的技能 ID：单仓库裸 relPath，多仓库 {namespace}/{relPath} */
  displayId(skill: ScannedSkill): string {
    return this.repos.length === 1 ? skill.relPath : `${skill.namespace}/${skill.relPath}`;
  }

  /** 标准技能条目（skills/list 与 skills/get 的 wire 形态，SEP-2640 Skill 结构） */
  toStandardEntry(skill: ScannedSkill): {
    uri: string;
    frontmatter: Record<string, unknown>;
    resources: Array<{ uri: string; digest: string; size: number }>;
  } {
    return {
      uri: this.skillDocUri(skill),
      frontmatter: skill.frontmatter,
      resources: skill.manifest.map((entry) => ({
        uri: this.skillFileUri(skill, entry.relPath),
        digest: entry.digest,
        size: entry.size,
      })),
    };
  }

  // ---------------------------------------------------------------------
  // 技能 ID 解析（工具通道入参 + 兼容 URI）
  // ---------------------------------------------------------------------

  /**
   * 解析技能 ID：
   * - {namespace}/{relPath}：命名空间存在且 relPath 精确匹配
   * - 裸 ID：先按 relPath 精确匹配，再按 name 匹配；唯一则直通，
   *   多个则报冲突并列出候选（带命名空间前缀），零个则报不存在并列出可用技能
   *
   * 注意：带前缀 ID 精确匹配失败时回退按裸 ID 全文匹配——目录名可能与命名空间同名
   * （如 default/nested），此时服务器广告的 ID 必须能解析回来，不能直接判死。
   */
  async resolveById(id: string): Promise<ScannedSkill> {
    const trimmed = id.trim().replace(/^\/+|\/+$/g, "");
    if (trimmed === "") throw new McpError(ErrorCode.InvalidParams, "技能 ID 不能为空");
    const { skills } = await this.scanAll();

    const nsSeparator = trimmed.indexOf("/");
    if (nsSeparator > 0) {
      const ns = trimmed.slice(0, nsSeparator).toLowerCase();
      const relPath = trimmed.slice(nsSeparator + 1);
      if (this.repos.some((repo) => repo.namespace === ns)) {
        const exact = skills.find((s) => s.namespace === ns && s.relPath === relPath);
        if (exact) return exact;
        // 精确匹配失败 → 继续走裸 ID 匹配（可能是首段撞命名空间名的嵌套技能）
      }
    }

    const matches = skills.filter((s) => s.relPath === trimmed);
    const byName = matches.length > 0 ? matches : skills.filter((s) => s.name === trimmed);
    if (byName.length === 1) return byName[0] as ScannedSkill;
    if (byName.length > 1) {
      const candidates = byName.map((s) => `${s.namespace}/${s.relPath}`).join(", ");
      throw new McpError(
        ErrorCode.InvalidParams,
        `技能 ID ${trimmed} 在多个仓库中存在，请使用带命名空间前缀的 ID: ${candidates}`,
      );
    }
    throw new McpError(
      ErrorCode.InvalidParams,
      `技能不存在: ${trimmed}。可用技能: ${this.availableIds(skills)}`,
    );
  }

  private availableIds(skills: ScannedSkill[]): string {
    return skills.length > 0 ? skills.map((s) => this.displayId(s)).join(", ") : "（无）";
  }

  // ---------------------------------------------------------------------
  // URI 解析与内容读取（Resources 通道 + skills/get 共用）
  // ---------------------------------------------------------------------

  /**
   * 按资源 URI 读取内容。支持：
   * - skill://{ns}/catalog              → 该仓库的技能目录
   * - skill://{ns}/{relPath}/SKILL.md   → 技能主文档（原样含 front matter）
   * - skill://{ns}/{relPath}/{fileRel}  → 技能子文件
   * - git-skills:// 兼容前缀（可配置关闭）：catalog 聚合全部仓库
   */
  async readUri(uri: string): Promise<{ mimeType: string; text: string }> {
    if (uri.startsWith("skill://")) return this.readStandardUri(uri);
    if (uri.startsWith("git-skills://")) return this.readLegacyUri(uri);
    throw unknownUriError(uri);
  }

  private async readStandardUri(uri: string): Promise<{ mimeType: string; text: string }> {
    const { skills } = await this.scanAll();
    const parsed = this.parseStandardUri(uri, skills);
    if (parsed.kind === "catalog") {
      return {
        mimeType: "text/markdown",
        text: this.renderCatalog(
          skills.filter((s) => s.namespace === parsed.namespace),
          { title: `业务技能目录（${parsed.namespace}）` },
        ),
      };
    }
    if (parsed.kind === "skill-doc") {
      return { mimeType: "text/markdown", text: await this.readSkillFileChecked(parsed.skill, "SKILL.md") };
    }
    if (parsed.kind === "skill-dir") {
      // 技能根目录是 directory resource，需经 resources/directory/read 列出
      throw new McpError(
        ErrorCode.InvalidParams,
        `${uri} 是目录资源（技能根目录），请用 resources/directory/read 列出内容；读取主文档请用 ${this.skillDocUri(parsed.skill)}`,
      );
    }
    return {
      mimeType: mimeTypeFor(parsed.fileRel),
      text: await this.readSkillFileChecked(parsed.skill, parsed.fileRel),
    };
  }

  private async readLegacyUri(uri: string): Promise<{ mimeType: string; text: string }> {
    if (!this.options.legacyGitSkillsUris) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `兼容 URI 前缀已关闭（compat.legacyGitSkillsUris=false）: ${uri}`,
      );
    }
    if (uri === "git-skills://catalog") {
      const { skills } = await this.scanAll();
      return { mimeType: "text/markdown", text: this.renderCatalog(skills, { title: "业务技能目录" }) };
    }
    const docMatch = /^git-skills:\/\/skills\/(.+)\/SKILL\.md$/.exec(uri);
    if (docMatch) {
      // (.+) 允许 {ns}/{relPath} 形式的 ID（多仓库 displayId 含斜杠），由 resolveById 消歧
      const skill = await this.resolveById(decodeURIComponent(docMatch[1] as string));
      return { mimeType: "text/markdown", text: await this.readSkillFileChecked(skill, "SKILL.md") };
    }
    const fileMatch = /^git-skills:\/\/skills\/(.+)\/files\/(.+)$/.exec(uri);
    if (fileMatch) {
      const skill = await this.resolveById(decodeURIComponent(fileMatch[1] as string));
      const fileRel = decodeURIComponent(fileMatch[2] as string);
      return { mimeType: mimeTypeFor(fileRel), text: await this.readSkillFileChecked(skill, fileRel) };
    }
    throw unknownUriError(uri);
  }

  /**
   * 解析 skill:// URI 为具体目标（纯函数，快照由调用方提供）。
   * 注意先按 "/" 切分再逐段 decode，避免编码后的斜杠/点号破坏路径结构。
   */
  parseStandardUri(
    uri: string,
    skills: ScannedSkill[],
  ):
    | { kind: "catalog"; namespace: string }
    | { kind: "skill-doc"; skill: ScannedSkill }
    | { kind: "file"; skill: ScannedSkill; fileRel: string }
    | { kind: "skill-dir"; skill: ScannedSkill } {
    const match = /^skill:\/\/([^/?#]+)(?:\/(.*))?$/s.exec(uri);
    if (!match) throw unknownUriError(uri);
    const namespace = decodeURIComponent(match[1] as string).toLowerCase();
    const rest = match[2] ?? "";
    if (rest === "") throw unknownUriError(uri);
    if (rest === "catalog") {
      this.requireRepo(namespace);
      return { kind: "catalog", namespace };
    }

    // 嵌套技能：优先匹配更长的 relPath
    const candidates = skills
      .filter((s) => s.namespace === namespace && (rest === s.relPath || rest.startsWith(`${s.relPath}/`)))
      .sort((a, b) => b.relPath.length - a.relPath.length);
    const skill = candidates[0];
    if (!skill) {
      const available = skills
        .filter((s) => s.namespace === namespace)
        .map((s) => `${s.namespace}/${s.relPath}`)
        .join(", ");
      throw new McpError(
        ErrorCode.InvalidParams,
        `No skill is served at ${uri}（可用技能: ${available || "（无）"}）`,
      );
    }
    // rest 恰好等于技能路径：技能根目录是 directory resource（SEP-2640），不可经 resources/read 读取
    if (rest === skill.relPath) return { kind: "skill-dir", skill };

    const segments = rest.split("/").map((segment) => decodeURIComponent(segment));
    const fileRel = segments.slice(skill.relPath.split("/").length).join("/");
    if (fileRel === "" || fileRel.endsWith("/")) throw unknownUriError(uri);
    if (fileRel === "SKILL.md") return { kind: "skill-doc", skill };
    return { kind: "file", skill, fileRel };
  }

  private requireRepo(namespace: string): RepoConfig {
    const repo = this.repos.find((r) => r.namespace === namespace);
    if (!repo) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `命名空间不存在: ${namespace}。可用命名空间: ${this.repos.map((r) => r.namespace).join(", ")}`,
      );
    }
    return repo;
  }

  /** 按命名空间取仓库根路径（resources/directory/read 用）；命名空间不存在时抛 -32602 */
  repoRootOf(namespace: string): string {
    return this.requireRepo(namespace).path;
  }

  /** 带安全校验的技能内文件读取：路径越权/软链接跳转/不存在 均拒绝 */
  async readSkillFileChecked(skill: ScannedSkill, fileRel: string): Promise<string> {
    const repo = this.requireRepo(skill.namespace);
    // 双重边界：最终路径必须同时落在仓库根与技能目录内——
    // 仅守仓库根时，../ 可读到仓库内技能目录之外的任意文件（如 .git/objects 里的历史 blob）
    const skillDir = resolveWithinRepo(repo.path, [skill.relPath], skill.relPath);
    const resolved = resolveWithinRepo(skillDir, fileRel.split("/"), fileRel);
    assertWithinRepo(repo.path, resolved, fileRel);
    await assertRealpathWithinRepo(repo.path, resolved, fileRel);
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) throw new Error("not a regular file");
      return await fs.readFile(resolved, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as Error).message === "not a regular file") {
        throw new McpError(
          ErrorCode.InvalidParams,
          `文件不存在: ${this.skillFileUri(skill, fileRel)}（技能 ${this.displayId(skill)} 的可用文件: ${skill.manifest.map((e) => e.relPath).join(", ")}）`,
        );
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------
  // 检索、分页与目录渲染
  // ---------------------------------------------------------------------

  /** 服务端过滤 + 排序（需求文档 3.4），filter 全部可省略 */
  filterSkills(skills: ScannedSkill[], filter: CatalogFilter = {}): ScannedSkill[] {
    let result = skills;
    if (filter.repo) {
      const ns = filter.repo.toLowerCase();
      result = result.filter((s) => s.namespace === ns);
    }
    if (filter.tag) {
      result = result.filter((s) => tagsOf(s).includes(filter.tag as string));
    }
    if (filter.keyword) {
      const keyword = filter.keyword.toLowerCase();
      result = result.filter((s) => {
        const haystack = [
          s.name,
          String(s.frontmatter["description"] ?? ""),
          String(s.frontmatter["summary"] ?? ""),
          ...tagsOf(s),
        ]
          .join("\n")
          .toLowerCase();
        return haystack.includes(keyword);
      });
    }
    if (filter.sort === "mtime") {
      result = [...result].sort((a, b) => b.mtimeMs - a.mtimeMs);
    } else {
      result = [...result].sort((a, b) => `${a.namespace}/${a.relPath}`.localeCompare(`${b.namespace}/${b.relPath}`));
    }
    return result;
  }

  /** 简单偏移量分页；cursor 为不透明字符串（页首下标） */
  paginate<T>(items: T[], cursor: string | undefined, pageSize: number): { page: T[]; nextCursor?: string } {
    let offset = 0;
    if (cursor !== undefined) {
      offset = Number.parseInt(cursor, 10);
      if (!Number.isInteger(offset) || offset < 0) {
        throw new McpError(ErrorCode.InvalidParams, `无效的分页 cursor: ${cursor}`);
      }
    }
    const page = items.slice(offset, offset + pageSize);
    const next = offset + page.length;
    return next < items.length ? { page, nextCursor: String(next) } : { page };
  }

  /** 第一层目录渲染：按首标签分组（需求文档 3.1），含双前缀 URI */
  renderCatalog(skills: ScannedSkill[], options: { title?: string } = {}): string {
    if (skills.length === 0) {
      return [
        `# ${options.title ?? "业务技能目录"}`,
        "",
        "当前没有可用技能。请检查技能仓库配置或联系管理员。",
      ].join("\n");
    }

    const groups = new Map<string, ScannedSkill[]>();
    for (const skill of skills) {
      const tags = tagsOf(skill);
      const key = tags.length > 0 ? (tags[0] as string) : "未分类";
      const bucket = groups.get(key) ?? [];
      bucket.push(skill);
      groups.set(key, bucket);
    }
    const groupNames = [...groups.keys()].sort((a, b) =>
      a === "未分类" ? 1 : b === "未分类" ? -1 : a.localeCompare(b),
    );

    const sections = groupNames.map((groupName) => {
      const groupSkills = groups.get(groupName) as ScannedSkill[];
      const entries = groupSkills.map((skill, index) => {
        const lines = [
          `### ${index + 1}. ${skill.name} (${this.displayId(skill)})`,
          "",
          `- **触发时机**: ${String(skill.frontmatter["description"] ?? "")}`,
        ];
        const summary = skill.frontmatter["summary"];
        if (typeof summary === "string" && summary !== "") {
          lines.push(`- **简介**: ${summary}`);
        }
        const tags = tagsOf(skill);
        if (tags.length > 0) {
          lines.push(`- **标签**: ${tags.join(", ")}`);
        }
        const version = skill.frontmatter["version"];
        if (typeof version === "string" && version !== "") {
          lines.push(`- **版本**: ${version}`);
        }
        const uris = [`读取 \`${this.skillDocUri(skill)}\``];
        if (this.options.legacyGitSkillsUris) {
          uris.push(`兼容路径 \`git-skills://skills/${this.displayId(skill)}/SKILL.md\``);
        }
        lines.push(`- **详细流程**: ${uris.join("；")}`);
        return lines.join("\n");
      });
      return [`## 标签：${groupName}`, "", entries.join("\n\n---\n\n")].join("\n");
    });

    return [
      `# ${options.title ?? "业务技能目录"}`,
      "",
      `以下是可用的业务技能（共 ${skills.length} 个）。根据用户任务判断是否需要加载某个技能的详细流程。`,
      "",
      "---",
      "",
      sections.join("\n\n---\n\n"),
      "",
      "---",
    ].join("\n");
  }

  /**
   * 第二层「摘要模式」（需求文档 3.1）：front matter 元数据 + 全部标题大纲，
   * 正文一字不返。完整正文需以 mode=full 主动请求。
   */
  async renderSummary(skill: ScannedSkill): Promise<string> {
    const raw = await this.readSkillFileChecked(skill, "SKILL.md");
    const body = stripFrontMatter(raw);
    const headings = body
      .split("\n")
      .filter((line) => /^#{1,6}\s+\S/.test(line))
      .map((line) => {
        const level = (line.match(/^#+/) ?? ["#"])[0] as string;
        const text = line.replace(/^#+\s+/, "").trim();
        return `${"  ".repeat(level.length - 1)}- ${text}`;
      });

    const meta = [`- **触发时机**: ${String(skill.frontmatter["description"] ?? "")}`];
    const summary = skill.frontmatter["summary"];
    if (typeof summary === "string" && summary !== "") {
      meta.push(`- **简介**: ${summary}`);
    }
    meta.push(`- **文件清单**: ${skill.manifest.map((e) => e.relPath).join(", ")}`);

    return [
      `技能 ${this.displayId(skill)} 摘要（完整正文请用 mode=full 加载）`,
      "",
      ...meta,
      "",
      "## 内容大纲",
      "",
      headings.length > 0 ? headings.join("\n") : "（SKILL.md 没有标题结构）",
    ].join("\n");
  }

  /** 第三层子文件元数据预览（需求文档 3.1）：文件名 + 大小 + 更新时间 */
  listSkillFiles(skill: ScannedSkill): SkillFileMeta[] {
    return skill.manifest
      .filter((entry) => entry.relPath !== "SKILL.md")
      .map((entry) => ({ relPath: entry.relPath, size: entry.size, mtimeMs: entry.mtimeMs }));
  }
}

/** 读取 front matter 的 tags 数组（容错：非字符串数组时忽略） */
export function tagsOf(skill: ScannedSkill): string[] {
  const tags = skill.frontmatter["tags"];
  if (!Array.isArray(tags)) return [];
  return tags.filter((tag): tag is string => typeof tag === "string" && tag.trim() !== "");
}

function unknownUriError(uri: string): McpError {
  return new McpError(
    ErrorCode.InvalidParams,
    `无法识别的资源 URI: ${uri}。可用资源: skill://{namespace}/catalog，或模板 skill://{namespace}/{skill_path}/SKILL.md 与 skill://{namespace}/{skill_path}/{file_path}`,
  );
}

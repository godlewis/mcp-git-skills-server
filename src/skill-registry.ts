/**
 * skill-registry.ts — 技能发现：扫描 Git 仓库中每个技能子目录下的 SKILL.md，解析 front matter 生成技能条目。
 *
 * 设计要点（对应三层渐进式披露的第一层数据来源）：
 * - 无缓存：每次调用都重新扫描文件系统，因此 git pull 或手动新增技能后立即生效，无需重启
 * - 元数据来自 SKILL.md 的 YAML front matter（name / description / summary），与社区 Agent Skills 格式兼容，
 *   不再依赖独立的 catalog.md，从根源上消除"索引与目录漂移"问题
 * - 校验失败的技能（缺 front matter、缺必填字段、YAML 错误）被跳过并记入 warnings，不影响其他技能
 */

import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { SkillEntry } from "./catalog-parser.js";

/** SKILL.md 开头的 YAML front matter，如：
 * ---
 * name: 采购申请处理
 * description: 当用户需要……时使用
 * summary: 处理采购全流程
 * ---
 */
const FRONT_MATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/;

/** 扫描结果：有效技能条目 + 被跳过技能的警告信息 */
export interface ScanResult {
  entries: SkillEntry[];
  warnings: string[];
}

/** 扫描仓库：返回所有有效技能条目（按 skillId 排序），warnings 供调用方记录日志 */
export async function scanSkills(repoPath: string): Promise<ScanResult> {
  const entries: SkillEntry[] = [];
  const warnings: string[] = [];

  let dirNames: string[];
  try {
    dirNames = (await fs.readdir(repoPath, { withFileTypes: true }))
      .filter((dirent) => dirent.isDirectory() && !dirent.name.startsWith("."))
      .map((dirent) => dirent.name)
      .sort();
  } catch (error) {
    return { entries, warnings: [`无法读取技能仓库目录 ${repoPath}: ${(error as Error).message}`] };
  }

  for (const dirName of dirNames) {
    const skillMdPath = path.join(repoPath, dirName, "SKILL.md");
    let raw: string;
    try {
      raw = await fs.readFile(skillMdPath, "utf8");
    } catch (error) {
      // 没有 SKILL.md 的目录不是技能（如普通资源目录），静默跳过
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      warnings.push(`跳过技能 ${dirName}: ${(error as Error).message}`);
      continue;
    }

    try {
      const matter = parseFrontMatter(raw);
      entries.push({
        skillId: dirName,
        name: matter.name,
        whenToUse: matter.description,
        summary: matter.summary ?? "",
      });
    } catch (error) {
      warnings.push(`跳过技能 ${dirName}: ${(error as Error).message}`);
    }
  }

  return { entries, warnings };
}

/**
 * 解析 SKILL.md 的 front matter。name 与 description 必填（description 即触发时机 when_to_use），
 * summary 可选。校验失败抛出带原因的错误，由调用方决定跳过。
 */
function parseFrontMatter(raw: string): { name: string; description: string; summary?: string } {
  const match = FRONT_MATTER_PATTERN.exec(raw);
  if (!match) {
    throw new Error("SKILL.md 缺少 YAML front matter（文件开头应以 --- 包裹 name/description）");
  }

  let data: unknown;
  try {
    data = parseYaml(match[1] ?? "");
  } catch (error) {
    throw new Error(`front matter YAML 解析失败: ${(error as Error).message}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("front matter 必须是键值映射");
  }

  const record = data as Record<string, unknown>;
  const name = asNonEmptyString(record["name"]);
  const description = asNonEmptyString(record["description"]);
  if (!name) throw new Error("front matter 缺少 name 字段");
  if (!description) throw new Error("front matter 缺少 description 字段（即触发时机 when_to_use）");

  const summary = asNonEmptyString(record["summary"]);
  return summary ? { name, description, summary } : { name, description };
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 剥离 front matter，返回 Markdown 正文（load_skill 工具用）；没有 front matter 时原样返回 */
export function stripFrontMatter(raw: string): string {
  const match = FRONT_MATTER_PATTERN.exec(raw);
  return match ? (match[2] ?? "").replace(/^\s+/, "") : raw;
}

/**
 * skills-scanner.ts — 存储层：扫描 Git 仓库发现技能（取代 POC 版 skill-registry.ts）。
 *
 * 设计要点：
 * - 无缓存：每次调用重新扫描，git pull / 新增技能后立即生效，无需重启（保留 POC 核心特性）
 * - 递归发现 SKILL.md：支持嵌套技能（SEP-2640：嵌套技能平铺发布，外层清单包含其文件）
 * - front matter 校验（SEP-2640 硬约束）：
 *   - name/description 必填且为非空字符串
 *   - name 必须等于父目录名（URI 最后一段 == name 的前提）
 *   - name 必须是小写字母/数字/连字符的 slug（Agent Skills 命名规则）
 * - 每个文件计算 sha256 digest + 字节数，构成 SEP-2640 要求的完整清单（含 SKILL.md 本身）
 * - 坏技能跳过并输出告警，不影响其他技能（保留 POC 容错机制）
 * - 512 文件 / 16MiB 上限（SEP-2640 Limits）：超限技能不发布并告警（SHOULD NOT serve）
 *
 * 性能说明：P0 规模（百级技能）每次扫描直接读文件计算哈希足够快；若技能量级显著增长，
 * 后续可按 path+mtime+size 做摘要缓存，属 P1 优化范畴，暂不引入。
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { RepoScanResult, ScannedSkill, SkillManifestEntry } from "../types.js";

const FRONT_MATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/;
/** Agent Skills 命名规则：小写字母/数字/连字符，不以连字符结尾 */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const MAX_FILES_PER_SKILL = 512;
export const MAX_TOTAL_BYTES_PER_SKILL = 16 * 1024 * 1024;

/** 扫描跳过的目录名（约定：点开头的目录一律不参与技能发现） */
function isSkippedDirName(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** 递归查找仓库内全部 SKILL.md（含嵌套技能） */
async function findSkillMarkdownFiles(repoRoot: string): Promise<string[]> {
  const results: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 仓库根不可读等场景由调用方兜底报错
    }
    for (const dirent of dirents) {
      if (isSkippedDirName(dirent.name)) continue;
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(full);
      } else if (dirent.isFile() && dirent.name === "SKILL.md") {
        results.push(full);
      }
    }
  };
  await walk(repoRoot);
  return results.sort();
}

/**
 * 解析 SKILL.md 的 YAML front matter，返回原样键值映射。
 * 缺 front matter、YAML 非法、非映射结构时抛出带原因的错误。
 */
export function parseFrontMatter(raw: string): Record<string, unknown> {
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
  return data as Record<string, unknown>;
}

/** 剥离 front matter，返回 Markdown 正文；没有 front matter 时原样返回 */
export function stripFrontMatter(raw: string): string {
  const match = FRONT_MATTER_PATTERN.exec(raw);
  return match ? (match[2] ?? "").replace(/^\s+/, "") : raw;
}

/**
 * 计算技能目录的完整文件清单（含 SKILL.md），每项带 sha256 digest / size / mtime。
 * 大文件（超过单技能总限额）走流式哈希，避免远端塞一个大文件就把内存打爆。
 */
async function buildManifest(skillDir: string): Promise<SkillManifestEntry[]> {
  const entries: SkillManifestEntry[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const dirent of await fs.readdir(dir, { withFileTypes: true })) {
      if (isSkippedDirName(dirent.name)) continue;
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(full);
      } else if (dirent.isFile()) {
        const stat = await fs.stat(full);
        const digest =
          stat.size > MAX_TOTAL_BYTES_PER_SKILL
            ? await hashFileStream(full)
            : `sha256:${createHash("sha256").update(await fs.readFile(full)).digest("hex")}`;
        entries.push({
          relPath: toPosix(path.relative(skillDir, full)),
          digest,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  };
  await walk(skillDir);
  return entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
}

/** 流式 SHA-256（64KB 分块），用于超限大文件 */
function hashFileStream(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(`sha256:${hash.digest("hex")}`));
  });
}

/**
 * 扫描单个仓库：返回全部有效技能（按 relPath 排序）与告警列表。
 * 单个技能格式错误只记告警，不影响其他技能。
 */
export async function scanRepoSkills(repoRoot: string, namespace: string): Promise<RepoScanResult> {
  const skills: ScannedSkill[] = [];
  const warnings: string[] = [];

  const skillMdFiles = await findSkillMarkdownFiles(repoRoot);
  if (skillMdFiles.length === 0) {
    warnings.push(`仓库 ${repoRoot} 中没有发现任何 SKILL.md`);
    return { skills, warnings };
  }

  for (const skillMdPath of skillMdFiles) {
    const skillDir = path.dirname(skillMdPath);
    const relPath = toPosix(path.relative(path.resolve(repoRoot), path.resolve(skillDir)));
    const dirName = path.basename(skillDir);

    try {
      const raw = await fs.readFile(skillMdPath, "utf8");
      const frontmatter = parseFrontMatter(raw);

      const name = frontmatter["name"];
      const description = frontmatter["description"];
      if (typeof name !== "string" || name.trim() === "") {
        throw new Error("front matter 缺少 name 字段");
      }
      if (typeof description !== "string" || description.trim() === "") {
        throw new Error("front matter 缺少 description 字段");
      }
      if (name !== dirName) {
        throw new Error(`name (${name}) 与目录名 (${dirName}) 不一致（SEP-2640 要求一致）`);
      }
      if (!SKILL_NAME_PATTERN.test(name) || name.length > 64) {
        throw new Error(`name (${name}) 不符合 Agent Skills 命名规则（小写字母/数字/连字符，≤64 字符）`);
      }

      const [manifest, stat] = await Promise.all([buildManifest(skillDir), fs.stat(skillMdPath)]);
      const totalBytes = manifest.reduce((sum, entry) => sum + entry.size, 0);
      // SEP-2640 Limits："Servers SHOULD NOT serve a skill that exceeds either limit" —— 超限技能不发布，仅告警
      if (manifest.length > MAX_FILES_PER_SKILL) {
        warnings.push(
          `跳过技能 ${relPath}: 文件数 ${manifest.length} 超过 SEP-2640 上限 ${MAX_FILES_PER_SKILL}（超限技能不发布）`,
        );
        continue;
      }
      if (totalBytes > MAX_TOTAL_BYTES_PER_SKILL) {
        warnings.push(
          `跳过技能 ${relPath}: 总大小 ${totalBytes} 字节超过 SEP-2640 上限 ${MAX_TOTAL_BYTES_PER_SKILL}（超限技能不发布）`,
        );
        continue;
      }

      skills.push({ namespace, relPath, name, frontmatter, manifest, mtimeMs: stat.mtimeMs });
    } catch (error) {
      warnings.push(`跳过技能 ${relPath}: ${(error as Error).message}`);
    }
  }

  skills.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { skills, warnings };
}

/**
 * path-safety.ts — 存储层：路径安全校验（需求文档 5.2 的 P0 基线）。
 *
 * 所有来自客户端的路径（skill_id、file_path、URI 解析结果）必须经过本模块，
 * 确保解析后的绝对路径落在仓库根目录内，禁止任何形式的越权访问。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

/**
 * 校验解析后的绝对路径位于 repoRoot 内（repoRoot 自身也允许）。
 * 防御 ../、绝对路径、盘符、URL 编码（%2E%2E）等越权形式——
 * 统一策略是"先解析再比对前缀"，而非逐个黑名单。
 */
export function assertWithinRepo(repoRoot: string, resolved: string, originalPath: string): void {
  const root = path.resolve(repoRoot);
  if (resolved === root) return;
  if (!resolved.startsWith(root + path.sep)) {
    throw new McpError(ErrorCode.InvalidParams, `路径越权访问被拒绝: ${originalPath}`);
  }
}

/**
 * 解析相对片段为仓库内绝对路径并做安全校验。
 * segments 各段必须是相对路径片段（不含盘符/绝对路径语义），解析后仍须落在仓库内。
 */
export function resolveWithinRepo(repoRoot: string, segments: readonly string[], originalPath: string): string {
  const resolved = path.resolve(path.resolve(repoRoot), ...segments);
  assertWithinRepo(repoRoot, resolved, originalPath);
  return resolved;
}

/**
 * 软链接校验：文件真实路径（realpath）必须仍在仓库真实根目录内。
 * 防御"仓库内放一个指向仓库外的软链接"的跳转攻击（需求文档 5.2）。
 */
export async function assertRealpathWithinRepo(repoRoot: string, target: string, originalPath: string): Promise<void> {
  try {
    const [realRoot, realTarget] = await Promise.all([fs.realpath(repoRoot), fs.realpath(target)]);
    assertWithinRepo(realRoot, realTarget, originalPath);
  } catch (error) {
    if (error instanceof McpError) throw error;
    // realpath 失败（文件不存在等）交由调用方的读取逻辑报错
  }
}

/**
 * 隐藏目录校验：解析后的路径相对仓库根的任何一级目录都不得以 "." 开头。
 * 防御目录列举/读取钻进 .git 等内部目录（.git/objects 里的历史 blob 属于敏感面）。
 */
export function assertNoHiddenSegments(repoRoot: string, resolved: string, originalPath: string): void {
  const relative = path.relative(path.resolve(repoRoot), resolved);
  if (relative.startsWith("..")) return; // 越权由 assertWithinRepo 负责报错
  for (const segment of relative.split(path.sep)) {
    if (segment.startsWith(".")) {
      throw new McpError(ErrorCode.InvalidParams, `禁止访问隐藏目录: ${originalPath}`);
    }
  }
}

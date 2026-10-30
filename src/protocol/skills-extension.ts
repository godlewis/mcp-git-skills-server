/**
 * skills-extension.ts — 协议层：MCP 官方 Skills 扩展（SEP-2640，io.modelcontextprotocol/skills）。
 *
 * 实现扩展定义的三个方法（基准协议 2026-07-28）：
 * - skills/list（必需）：分页枚举技能，返回 SEP-2640 Skill 条目（frontmatter 逐字段透传 +
 *   完整文件清单，每项带 sha256 digest 与 size）；条目原子性——单个技能的 resources 绝不跨页拆分
 * - skills/get（必需）：按 SKILL.md 的 URI 返回单个技能条目；未服务的 URI 返回 -32602
 * - resources/directory/read（可选，声明 directoryRead: true）：列目录资源的直接子项，
 *   文件带常规元数据，子目录 mimeType 为 inode/directory；非目录/不存在返回 -32602
 *
 * 与需求文档的三处偏差处置（Q11 决议，均以官方标准为准）：
 * - skills/list 无 keyword/tag 业务参数（标准只定义 cursor 分页），检索留在自定义工具 list_skills
 * - skills/get 只返回元数据+清单不含正文，正文走标准 resources/read
 * - 摘要模式（需求 3.1）留在自定义工具 load_skill(mode=summary)
 *
 * 注意：SDK 稳定版（1.32.x）早于 SEP-2640 合并（2026-09-13），故通过底层 setRequestHandler
 * + 自带 zod schema 注册方法；SDK 2.x 稳定后可切换官方实现。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CACHE_HINTS, mimeTypeFor, SkillCatalog } from "../services/skill-catalog.js";
import { assertNoHiddenSegments, assertRealpathWithinRepo, resolveWithinRepo } from "../storage/path-safety.js";
import type { ScannedSkill } from "../types.js";

/** JSON-RPC 请求信封的公共形状（SDK 的 Request schema 同款宽松度） */
const jsonRpcEnvelope = {
  jsonrpc: z.literal("2.0").optional(),
  id: z.union([z.string(), z.number()]).optional(),
};

const requestMeta = z.record(z.string(), z.unknown()).optional();

/** SEP-2640：请求 MUST 携带 params._meta（服务端宽松处理：缺失不拒绝） */
export const ListSkillsRequestSchema = z.object({
  ...jsonRpcEnvelope,
  method: z.literal("skills/list"),
  params: z.object({ cursor: z.string().max(256).optional(), _meta: requestMeta }).optional(),
});

export const GetSkillRequestSchema = z.object({
  ...jsonRpcEnvelope,
  method: z.literal("skills/get"),
  params: z.object({ uri: z.string().min(1).max(2048), _meta: requestMeta }),
});

export const ReadResourceDirectoryRequestSchema = z.object({
  ...jsonRpcEnvelope,
  method: z.literal("resources/directory/read"),
  params: z.object({ uri: z.string().min(1).max(2048), cursor: z.string().max(256).optional(), _meta: requestMeta }),
});

export interface SkillsExtensionDeps {
  catalog: SkillCatalog;
  /** skills/list 分页页大小（config.pageSize） */
  pageSize: number;
}

export function registerSkillsExtension(server: Server, deps: SkillsExtensionDeps): void {
  const { catalog, pageSize } = deps;

  // ---- skills/list：分页枚举全部技能 ----
  server.setRequestHandler(ListSkillsRequestSchema, async (request) => {
    const snapshot = await catalog.scanAll();
    const sorted = [...snapshot.skills].sort((a, b) =>
      `${a.namespace}/${a.relPath}`.localeCompare(`${b.namespace}/${b.relPath}`),
    );
    const { page, nextCursor } = catalog.paginate(sorted, request.params?.cursor, pageSize);
    return {
      ...CACHE_HINTS,
      skills: page.map((skill) => catalog.toStandardEntry(skill)),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  });

  // ---- skills/get：按 SKILL.md URI 返回单技能条目 ----
  server.setRequestHandler(GetSkillRequestSchema, async (request) => {
    const uri = request.params.uri;
    const skill = await resolveSkillByUri(catalog, uri);
    return { ...CACHE_HINTS, skill: catalog.toStandardEntry(skill) };
  });

  // ---- resources/directory/read：目录资源的直接子项列表 ----
  server.setRequestHandler(ReadResourceDirectoryRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (!uri.startsWith("skill://")) {
      throw new McpError(ErrorCode.InvalidParams, `${uri} is not a directory resource`);
    }
    const children = await listDirectoryChildren(catalog, uri);
    const { page, nextCursor } = catalog.paginate(children, request.params?.cursor, pageSize);
    return {
      ...CACHE_HINTS,
      resources: page,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  });
}

/** skills/get 的 URI 解析：只接受 SKILL.md 资源 URI（标准/兼容前缀均可） */
async function resolveSkillByUri(catalog: SkillCatalog, uri: string): Promise<ScannedSkill> {
  const { skills } = await catalog.scanAll();

  if (uri.startsWith("skill://")) {
    const parsed = catalog.parseStandardUri(uri, skills);
    if (parsed.kind === "skill-doc") return parsed.skill;
    throw notServedError(uri);
  }
  const legacy = /^git-skills:\/\/skills\/(.+)\/SKILL\.md$/.exec(uri);
  if (legacy) {
    return catalog.resolveById(decodeURIComponent(legacy[1] as string));
  }
  throw notServedError(uri);
}

function notServedError(uri: string): McpError {
  return new McpError(ErrorCode.InvalidParams, `No skill is served at ${uri}`);
}

/** 目录资源解析与子项列举（文件带 mimeType/size，子目录为 inode/directory） */
async function listDirectoryChildren(
  catalog: SkillCatalog,
  uri: string,
): Promise<Array<Record<string, unknown>>> {
  const match = /^skill:\/\/([^/?#]+)(?:\/(.*))?$/.exec(uri);
  if (!match) throw notADirectoryError(uri);
  const namespace = decodeURIComponent(match[1] as string).toLowerCase();
  const rest = match[2] ?? "";

  const dirPath = await resolveDirectoryPath(catalog, namespace, rest, uri);
  const dirents = await fs.readdir(dirPath, { withFileTypes: true });
  const children: Array<Record<string, unknown>> = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith(".")) continue;
    const childUri = rest === "" ? `skill://${namespace}/${dirent.name}` : `skill://${namespace}/${rest}/${dirent.name}`;
    if (dirent.isDirectory()) {
      children.push({ uri: childUri, name: dirent.name, mimeType: "inode/directory" });
    } else if (dirent.isFile()) {
      const stat = await fs.stat(path.join(dirPath, dirent.name));
      children.push({
        uri: childUri,
        name: dirent.name,
        mimeType: mimeTypeFor(dirent.name),
        size: stat.size,
      });
    }
  }
  children.sort((a, b) => String(a["name"]).localeCompare(String(b["name"])));
  return children;
}

/** 把目录 URI 解析为仓库内绝对路径：skill://{ns}（仓库根）或 skill://{ns}/{子路径} */
async function resolveDirectoryPath(
  catalog: SkillCatalog,
  namespace: string,
  rest: string,
  originalUri: string,
): Promise<string> {
  if (rest === "catalog") throw notADirectoryError(originalUri); // catalog 是虚拟文件资源
  const segments = rest === "" ? [] : rest.split("/").map((segment) => decodeURIComponent(segment));
  const repoRoot = catalog.repoRootOf(namespace);
  const resolved = resolveWithinRepo(repoRoot, segments, originalUri);
  // 与文件读取同款的双重防线：软链接跳转 + 禁止钻进 .git 等隐藏目录
  await assertRealpathWithinRepo(repoRoot, resolved, originalUri);
  assertNoHiddenSegments(repoRoot, resolved, originalUri);
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw notADirectoryError(originalUri);
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw new McpError(ErrorCode.InvalidParams, `${originalUri} 目录不存在`);
  }
  return resolved;
}

function notADirectoryError(uri: string): McpError {
  return new McpError(ErrorCode.InvalidParams, `${uri} is not a directory resource`);
}

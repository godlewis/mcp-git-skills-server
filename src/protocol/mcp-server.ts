/**
 * mcp-server.ts — 协议层：Server 装配与能力声明。
 *
 * 能力集（三层兼容，需求文档 2.5）：
 * - resources：Skills 扩展的底座（SEP-2640：声明扩展 MUST 同时声明 resources）
 * - tools：POC 原生工具通道（可通过 compat.legacyTools 关闭）
 * - extensions.io.modelcontextprotocol/skills：SEP-2640 官方扩展声明，directoryRead: true
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ServerConfig } from "../types.js";
import type { SkillCatalog } from "../services/skill-catalog.js";
import type { GitManager } from "../services/git-manager.js";
import { registerSkillsExtension } from "./skills-extension.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";

export const SERVER_NAME = "git-skills-server";
export const SERVER_VERSION = "0.3.0";

/** SEP-2640 扩展标识（io.modelcontextprotocol/skills），技能方法前缀 skills/ 为扩展保留 */
export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";

export interface ServerDeps {
  catalog: SkillCatalog;
  gitManager: GitManager;
  config: ServerConfig;
}

export function buildMcpServer(deps: ServerDeps): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        resources: {},
        tools: {},
        extensions: {
          [SKILLS_EXTENSION_ID]: { directoryRead: true },
        },
      },
    },
  );

  registerSkillsExtension(server, { catalog: deps.catalog, pageSize: deps.config.pageSize });
  registerResources(server, deps.catalog, deps.config.repos, deps.config.compat);
  registerTools(server, { catalog: deps.catalog, gitManager: deps.gitManager, compat: deps.config.compat });

  return server;
}

/**
 * resources.ts — 协议层：MCP Resources 通道（原 POC 通道 A）。
 *
 * - resources/list：技能目录 concrete resources（skill://{ns}/catalog 标准前缀 +
 *   git-skills://catalog 兼容前缀，兼容前缀可通过配置关闭）
 * - resources/templates/list：标准前缀两个模板 + 兼容前缀两个模板（需求文档 2.3）
 * - resources/read：统一入口，服务层按双前缀解析（三层渐进式披露：
 *   catalog 索引 → SKILL.md 主文档 → 子文件，全部按需读取）
 */

import {
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CACHE_HINTS, SkillCatalog } from "../services/skill-catalog.js";
import type { CompatConfig, RepoConfig } from "../types.js";

export function registerResources(server: Server, catalog: SkillCatalog, repos: RepoConfig[], compat: CompatConfig): void {
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources: Array<Record<string, unknown>> = repos.map((repo) => ({
      uri: `skill://${repo.namespace}/catalog`,
      name: `技能目录（${repo.namespace}）`,
      description: `命名空间 ${repo.namespace} 下所有可用技能的索引，包含触发时机说明。按需读取。`,
      mimeType: "text/markdown",
    }));
    if (compat.legacyGitSkillsUris) {
      resources.push({
        uri: "git-skills://catalog",
        name: "技能目录",
        description: "所有可用业务技能的索引（兼容前缀，聚合全部仓库）。按需读取。",
        mimeType: "text/markdown",
      });
    }
    return { resources };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    const templates: Array<Record<string, unknown>> = [
      {
        uriTemplate: "skill://{namespace}/{skill_path}/SKILL.md",
        name: "技能详细流程",
        description: "读取指定技能的完整 SKILL.md 流程文档（SEP-2640 标准前缀）",
      },
      {
        uriTemplate: "skill://{namespace}/{skill_path}/{file_path}",
        name: "技能子文档",
        description: "读取技能引用的参考文档，如规则、模板、检查清单（SEP-2640 标准前缀）",
      },
    ];
    if (compat.legacyGitSkillsUris) {
      templates.push(
        {
          uriTemplate: "git-skills://skills/{skill_id}/SKILL.md",
          name: "技能详细流程（兼容前缀）",
          description: "读取指定技能的完整 SKILL.md 流程文档",
        },
        {
          uriTemplate: "git-skills://skills/{skill_id}/files/{file_path}",
          name: "技能子文档（兼容前缀）",
          description: "读取技能引用的参考文档，如规则、模板、检查清单",
        },
      );
    }
    return { resourceTemplates: templates };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const content = await catalog.readUri(request.params.uri);
    return {
      ...CACHE_HINTS,
      contents: [
        {
          uri: request.params.uri,
          mimeType: content.mimeType,
          text: content.text,
        },
      ],
    };
  });
}

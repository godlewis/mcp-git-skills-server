/**
 * config.ts — 基础设施层：多层级配置体系（需求文档 4.2）。
 *
 * 优先级（从高到低）：命令行参数 > 环境变量 > 配置文件（YAML）> 默认值
 *
 * 向下兼容（需求文档 9.2）：
 * - 旧环境变量 SKILLS_REPO_PATH / SKILLS_REPO_URL 继续生效，映射为 default 命名空间的单仓库；
 *   配置文件中声明了 repos 时以配置文件为准（配置文件 > 旧环境变量，经强哥 Q8 确认）
 * - 配置文件查找顺序：--config 参数 > SKILLS_CONFIG 环境变量 > 当前目录 skills-server.yaml
 *
 * 敏感值支持 ${ENV_VAR} 插值，收集到的密钥用于日志脱敏。
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { CompatConfig, LogLevel, RepoConfig, ServerConfig } from "../types.js";
import { isLogLevel } from "./logger.js";

export class ConfigError extends Error {}

/** 命令行参数（优先级最高的一层） */
export interface CliOptions {
  configPath?: string;
  logLevel?: string;
}

export interface LoadedConfig {
  config: ServerConfig;
  /** 收集到的密钥串，交给 Logger 做脱敏 */
  secrets: string[];
  /** 配置解析过程中的非致命告警（如 ${VAR} 未定义） */
  warnings: string[];
}

/** 解析命令行参数：支持 --config <path> / --config=<path> / --log-level <level> */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--config" || arg.startsWith("--config=")) {
      const value = arg.includes("=") ? arg.slice("--config=".length) : argv[++i];
      if (!value) throw new ConfigError("--config 需要指定配置文件路径");
      options.configPath = value;
    } else if (arg === "--log-level" || arg.startsWith("--log-level=")) {
      const value = arg.includes("=") ? arg.slice("--log-level=".length) : argv[++i];
      if (!value) throw new ConfigError("--log-level 需要指定级别（debug/info/warn/error）");
      options.logLevel = value;
    }
  }
  return options;
}

interface RawRepoConfig {
  namespace?: unknown;
  path?: unknown;
  url?: unknown;
  branch?: unknown;
  auth?: { username?: unknown; password?: unknown };
}

interface RawFileConfig {
  logLevel?: unknown;
  autoPullOnStartup?: unknown;
  pageSize?: unknown;
  compat?: { legacyTools?: unknown; legacyGitSkillsUris?: unknown };
  repos?: RawRepoConfig[];
}

export function loadConfig(cli: CliOptions, env: NodeJS.ProcessEnv, cwd = process.cwd()): LoadedConfig {
  const warnings: string[] = [];
  const secrets: string[] = [];

  // ---- 第一层：定位配置文件 ----
  const configFilePath = cli.configPath ?? env["SKILLS_CONFIG"] ?? findDefaultConfigFile(cwd);
  let raw: RawFileConfig = {};
  let baseDir = cwd;
  if (configFilePath) {
    const absolute = path.resolve(cwd, configFilePath);
    if (!fs.existsSync(absolute)) {
      throw new ConfigError(`配置文件不存在: ${absolute}`);
    }
    baseDir = path.dirname(absolute);
    raw = parseYaml(fs.readFileSync(absolute, "utf8")) as RawFileConfig;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ConfigError(`配置文件内容必须是键值映射: ${absolute}`);
    }
  }

  // ---- 第二层：repos（配置文件 > 旧环境变量） ----
  const repos = normalizeRepos(raw.repos, baseDir, env, warnings, secrets);
  if (repos.length === 0) {
    const legacy = legacyEnvRepo(env, cwd, warnings, secrets);
    if (!legacy) {
      throw new ConfigError(
        "未配置技能仓库：请提供配置文件（--config / SKILLS_CONFIG / ./skills-server.yaml），或设置环境变量 SKILLS_REPO_PATH",
      );
    }
    repos.push(legacy);
  }
  assertUniqueNamespaces(repos);

  // ---- 第三层：逐项合并 ----
  const logLevel = resolveLogLevel(cli.logLevel, env["SKILLS_LOG_LEVEL"], raw.logLevel, warnings);
  const autoPullOnStartup = resolveBoolean(raw.autoPullOnStartup, "autoPullOnStartup", true, warnings);
  const pageSize = normalizePageSize(raw.pageSize, warnings);
  const compat: CompatConfig = {
    legacyTools: raw.compat?.legacyTools !== false,
    legacyGitSkillsUris: raw.compat?.legacyGitSkillsUris !== false,
  };

  return {
    config: { logLevel, compat, autoPullOnStartup, pageSize, repos },
    secrets,
    warnings,
  };
}

function findDefaultConfigFile(cwd: string): string | undefined {
  const candidate = path.join(cwd, "skills-server.yaml");
  return fs.existsSync(candidate) ? candidate : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** 对字符串叶子值做 ${ENV_VAR} 插值；未定义的变量替换为空串并告警 */
function interpolate(value: string, env: NodeJS.ProcessEnv, warnings: string[]): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (original, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) {
      warnings.push(`环境变量 ${name} 未定义，${original} 替换为空串`);
      return "";
    }
    return resolved;
  });
}

function normalizeRepos(
  rawRepos: RawRepoConfig[] | undefined,
  baseDir: string,
  env: NodeJS.ProcessEnv,
  warnings: string[],
  secrets: string[],
): RepoConfig[] {
  if (!Array.isArray(rawRepos) || rawRepos.length === 0) return [];
  const repos: RepoConfig[] = [];
  for (const raw of rawRepos) {
    const repoPath = asString(raw.path);
    if (!repoPath) {
      warnings.push("仓库配置缺少 path，已跳过该项");
      continue;
    }
    let namespace = asString(raw.namespace) ?? "default";
    if (namespace !== namespace.toLowerCase()) {
      warnings.push(`命名空间 ${namespace} 含大写字母，已规范化为小写（skill:// authority 不区分大小写）`);
      namespace = namespace.toLowerCase();
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(namespace)) {
      warnings.push(`命名空间 ${namespace} 含非法字符（仅允许小写字母/数字/./_/-），已跳过该项`);
      continue;
    }
    if (namespace.includes(".")) {
      warnings.push(`命名空间 ${namespace} 含 "."，生成的 skill:// URI 可能难以解析，建议使用纯字母数字连字符`);
    }
    const repo: RepoConfig = { namespace, path: path.resolve(baseDir, repoPath) };
    const url = asString(raw.url);
    if (url) repo.url = interpolate(url, env, warnings);
    const branch = asString(raw.branch);
    if (branch) repo.branch = branch;
    const password = asString(raw.auth?.password);
    if (password !== undefined) {
      const resolved = interpolate(password, env, warnings);
      repo.auth = {};
      const username = asString(raw.auth?.username);
      if (username) repo.auth.username = username;
      repo.auth.password = resolved;
      secrets.push(resolved);
    }
    repos.push(repo);
  }
  return repos;
}

/** 旧环境变量映射为 default 命名空间仓库（POC 兼容路径） */
function legacyEnvRepo(
  env: NodeJS.ProcessEnv,
  cwd: string,
  warnings: string[],
  secrets: string[],
): RepoConfig | undefined {
  const repoPath = env["SKILLS_REPO_PATH"];
  if (!repoPath) return undefined;
  warnings.push("使用旧版环境变量 SKILLS_REPO_PATH 配置单仓库（default 命名空间）");
  const repo: RepoConfig = { namespace: "default", path: path.resolve(cwd, repoPath) };
  const url = env["SKILLS_REPO_URL"];
  if (url) repo.url = url;
  const branch = env["SKILLS_REPO_BRANCH"];
  if (branch) repo.branch = branch;
  const token = env["SKILLS_REPO_TOKEN"];
  if (token) {
    repo.auth = { username: env["SKILLS_REPO_USER"] ?? "git", password: token };
    secrets.push(token);
  }
  return repo;
}

function assertUniqueNamespaces(repos: RepoConfig[]): void {
  const seen = new Set<string>();
  for (const repo of repos) {
    const key = repo.namespace.toLowerCase();
    if (seen.has(key)) {
      throw new ConfigError(`命名空间重复: ${repo.namespace}（不同仓库必须使用不同命名空间前缀）`);
    }
    seen.add(key);
  }
}

function resolveLogLevel(
  cli: string | undefined,
  envValue: string | undefined,
  fileValue: unknown,
  warnings: string[],
): LogLevel {
  const candidates: Array<[string | undefined, string]> = [
    [cli, "命令行"],
    [envValue, "环境变量 SKILLS_LOG_LEVEL"],
    [typeof fileValue === "string" ? fileValue : undefined, "配置文件"],
  ];
  for (const [value, source] of candidates) {
    if (value === undefined) continue;
    if (isLogLevel(value)) return value;
    warnings.push(`${source}中的日志级别 "${value}" 无效（应为 debug/info/warn/error），已忽略`);
  }
  return "info";
}

function resolveBoolean(raw: unknown, key: string, defaultValue: boolean, warnings: string[]): boolean {
  if (raw === undefined) return defaultValue;
  if (typeof raw === "boolean") return raw;
  warnings.push(`配置文件中的 ${key} 应为布尔值，收到 ${JSON.stringify(raw)}，已回落默认值 ${defaultValue}`);
  return defaultValue;
}

function normalizePageSize(raw: unknown, warnings: string[]): number {
  if (raw === undefined) return 100;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    warnings.push(`配置文件中的 pageSize 应为整数，收到 ${JSON.stringify(raw)}，已回落默认值 100`);
    return 100;
  }
  if (raw < 1 || raw > 1000) {
    warnings.push(`pageSize ${raw} 超出 [1, 1000]，已回落为默认值 100`);
    return 100;
  }
  return raw;
}

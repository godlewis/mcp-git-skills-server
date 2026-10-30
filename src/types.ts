/**
 * types.ts — 跨层共享的类型定义。
 *
 * 分层约定（对应需求文档 8.1 四层架构）：
 * - infrastructure/：配置、日志等通用能力
 * - storage/：文件系统访问、路径安全校验、Git 操作封装
 * - services/：技能目录聚合、检索、Git 管理等核心业务逻辑
 * - protocol/：MCP 协议处理、Skills 扩展（SEP-2640）、Resources/Tools 通道
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** 单个技能仓库的认证信息（用于私有仓库 clone/pull） */
export interface RepoAuthConfig {
  username?: string;
  /** 密码或 Personal Access Token，支持 ${ENV_VAR} 环境变量插值 */
  password?: string;
}

/** 技能仓库配置（需求文档 3.2：多仓库聚合，命名空间隔离） */
export interface RepoConfig {
  /** 命名空间，作为 skill:// URI 的 authority 段；单仓库默认 default */
  namespace: string;
  /** 本地仓库路径（相对路径基于配置文件所在目录解析） */
  path: string;
  /** 远程仓库地址；未配置时为纯本地仓库，跳过 clone/pull */
  url?: string;
  /** 固定分支；配置后启动/拉取时确保在该分支（需求文档 3.3） */
  branch?: string;
  auth?: RepoAuthConfig;
}

/** 兼容开关（需求文档 2.5：三重兼容通道可按需关闭） */
export interface CompatConfig {
  /** 保留原 list_skills / load_skill 等自定义工具通道 */
  legacyTools: boolean;
  /** 保留原 git-skills:// URI 前缀（含 catalog / skills/ 路径） */
  legacyGitSkillsUris: boolean;
}

export interface ServerConfig {
  logLevel: LogLevel;
  compat: CompatConfig;
  /** 启动时自动 git pull；关闭后仅校验本地仓库可用（需求文档 3.3） */
  autoPullOnStartup: boolean;
  /** skills/list 分页页大小 */
  pageSize: number;
  repos: RepoConfig[];
}

/** 技能清单中的单个文件（内部形态，含 mtime 供排序/预览） */
export interface SkillManifestEntry {
  /** 相对技能目录的路径，/ 分隔；SKILL.md 本身也在清单中 */
  relPath: string;
  /** sha256:{64 位小写十六进制}，按 SEP-2640 规范 */
  digest: string;
  /** 原始字节长度（与 digest 覆盖同一份字节） */
  size: number;
  mtimeMs: number;
}

/** 扫描得到的一个技能条目 */
export interface ScannedSkill {
  namespace: string;
  /** 技能目录相对仓库根的路径（支持嵌套技能），如 purchase-apply 或 billing/refunds */
  relPath: string;
  /** front matter 的 name；由扫描校验保证等于目录名（SEP-2640 路径约束） */
  name: string;
  /** front matter 原样解析的完整键值（含 name/description 及扩展字段，逐字段透传） */
  frontmatter: Record<string, unknown>;
  /** 技能文件完整清单（含 SKILL.md 本身） */
  manifest: SkillManifestEntry[];
  /** SKILL.md 的修改时间，用于按更新时间排序 */
  mtimeMs: number;
}

export interface RepoScanResult {
  skills: ScannedSkill[];
  warnings: string[];
}

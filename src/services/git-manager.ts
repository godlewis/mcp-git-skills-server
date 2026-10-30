/**
 * git-manager.ts — 服务层：多仓库 Git 生命周期编排（需求文档 3.2 / 3.3）。
 *
 * 对应关系：
 * - startupSync(): 启动时逐仓库 clone/pull；单仓库失败只记日志，不影响其他仓库（验收标准）
 * - pull({repo, branch}): 拉取 + 可选切分支，返回技能级更新明细（新增 N / 修改 N / 删除 N）
 * - versionReport(): get_skills_version 工具的数据源（分支、commit、更新时间）
 *
 * 技能级 diff 的实现：拉取前后各扫描一次技能清单，按 {namespace}/{relPath} → SKILL.md digest
 * 对比得出新增/修改/删除的技能（比文件级 diff 更贴合"技能"语义）。
 */

import { GitRepository } from "../storage/git-repository.js";
import { scanRepoSkills } from "../storage/skills-scanner.js";
import type { RepoConfig } from "../types.js";
import type { Logger } from "../infrastructure/logger.js";

export interface StartupSyncResult {
  ready: string[];
  failed: Array<{ namespace: string; error: string }>;
}

export interface PullOptions {
  /** 仅拉取指定命名空间的仓库；省略则拉取全部 */
  repo?: string | undefined;
  /** 拉取前切换到该分支（需求文档 3.3 运行时切分支） */
  branch?: string | undefined;
}

export class GitManager {
  private readonly repositories: Map<string, GitRepository>;

  constructor(
    repos: RepoConfig[],
    private readonly log: Logger,
    private readonly autoPullOnStartup: boolean,
  ) {
    this.repositories = new Map(
      repos.map((repo) => [repo.namespace, new GitRepository(repo, (m) => log.warn(m))]),
    );
  }

  namespaces(): string[] {
    return [...this.repositories.keys()];
  }

  /** 启动同步：目录缺失时 clone；先切到配置分支再 pull（否则配置分支永远拉不到更新）；逐仓库隔离失败 */
  async startupSync(): Promise<StartupSyncResult> {
    const result: StartupSyncResult = { ready: [], failed: [] };
    for (const repo of this.repositories.values()) {
      const ns = repo.config.namespace;
      try {
        await repo.ensure();
        if (repo.config.branch) {
          await repo.checkoutBranch(repo.config.branch);
        }
        if (this.autoPullOnStartup && repo.config.url) {
          const outcome = await repo.pull();
          if (outcome.updated) {
            this.log.info(`启动同步: 仓库 ${ns} 拉取到更新（${outcome.changedFiles.length} 个文件）`);
          }
        }
        result.ready.push(ns);
      } catch (error) {
        const message = (error as Error).message;
        this.log.error(`仓库 ${ns} 启动同步失败: ${message}`);
        result.failed.push({ namespace: ns, error: message });
      }
    }
    return result;
  }

  /**
   * 拉取技能内容（pull_skills 工具）。
   * 返回逐仓库的技能级更新明细；仓库未配置远程时输出友好提示。
   * 出站的全部文本经 Logger 脱敏（git 报错可能携带带凭据的 URL）。
   */
  async pull(options: PullOptions = {}): Promise<string> {
    const targets = this.selectRepos(options.repo);
    const lines: string[] = [];
    let anyChanged = false;

    for (const repo of targets) {
      const ns = repo.config.namespace;
      try {
        // 先切分支再取快照：diff 反映的是"该分支上 pull 带来的变化"，而不是跨分支的整支差异
        if (options.branch) {
          await repo.checkoutBranch(options.branch);
          lines.push(`仓库 ${ns}：已切换到分支 ${options.branch}`);
        }
        const before = await this.skillDigestMap(repo.config);
        const outcome = await repo.pull();
        lines.push(outcome.message);
        const after = await this.skillDigestMap(repo.config);
        const diff = diffSkillMaps(before, after);
        if (diff.added.length > 0 || diff.modified.length > 0 || diff.deleted.length > 0) {
          anyChanged = true;
        }
        lines.push(
          `仓库 ${ns} 技能变化：新增 ${diff.added.length} 个（${diff.added.join(", ") || "无"}），` +
            `修改 ${diff.modified.length} 个（${diff.modified.join(", ") || "无"}），` +
            `删除 ${diff.deleted.length} 个（${diff.deleted.join(", ") || "无"}）`,
        );
      } catch (error) {
        lines.push(`仓库 ${ns} 拉取失败: ${(error as Error).message}`);
      }
    }

    if (!anyChanged) lines.push("技能内容无变化（各仓库明细见上）。");
    return lines.map((line) => this.log.redact(line)).join("\n");
  }

  /** get_skills_version：逐仓库的分支 / commit / 更新时间 */
  async versionReport(repoFilter?: string): Promise<string> {
    const targets = this.selectRepos(repoFilter);
    const lines: string[] = [];
    for (const repo of targets) {
      const ns = repo.config.namespace;
      try {
        const info = await repo.versionInfo();
        lines.push(
          `仓库 ${ns}：分支 ${info.branch}，commit ${info.commit || "(无提交)"}` +
            `${info.commitTime ? `，最近提交 ${info.commitTime}` : ""}` +
            `${info.hasRemote ? "" : "（未配置远程）"}`,
        );
      } catch (error) {
        lines.push(`仓库 ${ns}：版本信息不可用（${(error as Error).message}）`);
      }
    }
    return lines.map((line) => this.log.redact(line)).join("\n");
  }

  private selectRepos(repo?: string): GitRepository[] {
    if (!repo) return [...this.repositories.values()];
    const target = this.repositories.get(repo.toLowerCase());
    if (!target) {
      throw new Error(`仓库不存在: ${repo}。可用仓库: ${this.namespaces().join(", ")}`);
    }
    return [target];
  }

  /** 技能清单快照：{namespace}/{relPath} → SKILL.md digest，用于 pull 前后的技能级 diff */
  private async skillDigestMap(config: RepoConfig): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      const { skills } = await scanRepoSkills(config.path, config.namespace);
      for (const skill of skills) {
        const skillMd = skill.manifest.find((e) => e.relPath === "SKILL.md");
        if (skillMd) {
          map.set(`${skill.namespace}/${skill.relPath}`, skillMd.digest);
        }
      }
    } catch {
      // 仓库不可读时按空快照处理，diff 结果反映为"全部新增"
    }
    return map;
  }
}

function diffSkillMaps(before: Map<string, string>, after: Map<string, string>): {
  added: string[];
  modified: string[];
  deleted: string[];
} {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [key, digest] of after) {
    if (!before.has(key)) added.push(key);
    else if (before.get(key) !== digest) modified.push(key);
  }
  for (const key of before.keys()) {
    if (!after.has(key)) deleted.push(key);
  }
  return { added, modified, deleted };
}

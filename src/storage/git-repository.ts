/**
 * git-repository.ts — 存储层：单个 Git 仓库的操作封装（取代 POC 版 git-manager 的单仓库部分）。
 *
 * 职责（需求文档 3.3 Git 版本管理）：
 * - ensure(): 目录缺失时 clone（配置了 url）；本地仓库仅校验可用
 * - pull(): 拉取远程更新，返回变更文件；未配置远程时友好提示
 * - checkoutBranch(): 切换分支（本地已有则直接切，否则基于远程分支创建跟踪分支）
 * - versionInfo(): 当前分支 / commit / 提交时间 / 是否配置远程
 *
 * 认证：auth 配置以 https URL userinfo 形式注入，pull 前临时改写 remote url，
 * 结束后恢复原值（避免密钥落盘到 .git/config）。
 */

import fs from "node:fs";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import type { RepoConfig } from "../types.js";

export interface PullOutcome {
  /** 是否有新提交被拉取 */
  updated: boolean;
  changedFiles: string[];
  message: string;
}

export interface VersionInfo {
  branch: string;
  commit: string;
  commitTime: string;
  hasRemote: boolean;
}

export class GitRepository {
  private readonly git: SimpleGit;
  /** 操作串行化队列：LLM 客户端会并行发起工具调用，并发 git 操作会互踩 index.lock/remote url */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly config: RepoConfig,
    private readonly log: (message: string) => void,
  ) {
    this.git = simpleGit({ baseDir: config.path });
  }

  /** 串行化入口：同一仓库的 ensure/pull/checkout/version 严格按调用顺序执行 */
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** 目录是否存在（clone 的前提判断） */
  exists(): boolean {
    return fs.existsSync(this.config.path);
  }

  isGitRepo(): boolean {
    return this.exists() && fs.existsSync(path.join(this.config.path, ".git"));
  }

  /**
   * 确保仓库可用：
   * - 目录缺失且配置了 url → clone
   * - 目录缺失且未配置 url → 抛错（调用方按"单仓库失败不影响其他仓库"策略处理）
   * - clone 失败时清理自建的空目录，避免下次启动把坏仓库误当"就绪的空仓库"
   */
  async ensure(): Promise<void> {
    return this.serialized(async () => {
      if (this.exists()) return;
      if (!this.config.url) {
        throw new Error(`仓库目录不存在且未配置 url: ${this.config.path}`);
      }
      fs.mkdirSync(this.config.path, { recursive: true });
      try {
        await simpleGit().clone(this.authedUrl(), this.config.path);
      } catch (error) {
        fs.rmSync(this.config.path, { recursive: true, force: true });
        throw error;
      }
      if (this.config.branch) {
        await this.checkoutBranchUnlocked(this.config.branch);
      }
    });
  }

  /** 拉取最新内容；未初始化 Git 或未配置远程时返回友好提示而非抛错 */
  async pull(): Promise<PullOutcome> {
    return this.serialized(() => this.pullUnlocked());
  }

  private async pullUnlocked(): Promise<PullOutcome> {
    let hasRemote: boolean;
    try {
      hasRemote = (await this.git.getRemotes()).length > 0;
    } catch {
      return {
        updated: false,
        changedFiles: [],
        message: `仓库 ${this.config.namespace} 不是 Git 仓库或不可访问，跳过 pull`,
      };
    }
    if (!hasRemote) {
      return {
        updated: false,
        changedFiles: [],
        message: `仓库 ${this.config.namespace} 未配置远程（remote），跳过 pull`,
      };
    }

    // 有认证配置时临时改写 remote url（密钥不落盘），结束后恢复；
    // 操作已按仓库串行化，不会出现恢复窗口交错（彻底方案：per-invocation 凭据注入，见 P1 backlog）
    const originalUrl = ((await this.git.remote(["get-url", "origin"])) ?? "").trim();
    const authed = this.authedUrl();
    if (authed !== originalUrl) {
      await this.git.remote(["set-url", "origin", authed]);
    }
    try {
      const pullResult = await this.git.pull();
      const changedFiles = pullResult.files ?? [];
      const summary = pullResult.summary;
      return {
        updated: changedFiles.length > 0,
        changedFiles,
        message:
          changedFiles.length > 0
            ? `仓库 ${this.config.namespace}：${summary.changes} 个变更、${summary.insertions} 行新增、${summary.deletions} 行删除`
            : `仓库 ${this.config.namespace}：已是最新`,
      };
    } finally {
      if (authed !== originalUrl) {
        await this.git.remote(["set-url", "origin", originalUrl]);
      }
    }
  }

  /** 切换到指定分支：优先本地已有分支，否则基于 origin/<branch> 创建跟踪分支 */
  async checkoutBranch(branch: string): Promise<void> {
    return this.serialized(() => this.checkoutBranchUnlocked(branch));
  }

  private async checkoutBranchUnlocked(branch: string): Promise<void> {
    await this.fetchWithAuth();
    try {
      await this.git.checkout(branch);
      return;
    } catch {
      await this.git.checkoutBranch(branch, `origin/${branch}`);
    }
  }

  /** 带认证的 fetch：与 pull 同款临时改写 remote url，避免私有仓库切新远程分支时 401 */
  private async fetchWithAuth(): Promise<void> {
    const remotes = await this.git.getRemotes().catch(() => []);
    if (remotes.length === 0) return;
    const originalUrl = ((await this.git.remote(["get-url", "origin"])) ?? "").trim();
    const authed = this.authedUrl();
    const needsSwap = authed !== originalUrl;
    if (needsSwap) {
      await this.git.remote(["set-url", "origin", authed]);
    }
    try {
      await this.git.fetch();
    } catch {
      // 纯本地仓库或网络不可达时忽略，后续 checkout 会给出真实错误
    } finally {
      if (needsSwap) {
        await this.git.remote(["set-url", "origin", originalUrl]);
      }
    }
  }

  /** 当前分支、最新 commit 与时间 */
  async versionInfo(): Promise<VersionInfo> {
    return this.serialized(async () => {
      const branch = await this.git.branchLocal().then((b) => b.current || "(unknown)");
      const latest = (await this.git.log(["-n", "1"])).latest;
      const hasRemote = (await this.git.getRemotes().catch(() => [])).length > 0;
      return {
        branch,
        commit: (latest?.hash ?? "").slice(0, 10),
        commitTime: latest?.date ?? "",
        hasRemote,
      };
    });
  }

  /** 认证 URL：https 地址注入 userinfo；无认证配置时原样返回 */
  private authedUrl(): string {
    const url = this.config.url;
    if (!url) throw new Error(`仓库 ${this.config.namespace} 未配置 url`);
    const { username, password } = this.config.auth ?? {};
    if (!username && !password) return url;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return url;
      parsed.username = username ?? "";
      parsed.password = password ?? "";
      return parsed.toString();
    } catch {
      this.log(`仓库 ${this.config.namespace} 的 url 非法，无法注入认证信息`);
      return url;
    }
  }
}

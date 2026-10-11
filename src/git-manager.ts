/**
 * git-manager.ts — 技能内容的 Git 管理。
 *
 * 技能内容完全由 Git 仓库承载，Server 自身不存储任何技能内容：
 * - syncOnStartup(): 启动时若配置了 SKILLS_REPO_URL，自动 clone（目录不存在）或 pull（已存在）
 * - pull(): 供 pull_skills 工具调用，手动拉取最新技能内容并返回更新状态
 */

import fs from "node:fs";
import path from "node:path";
import { simpleGit, SimpleGit } from "simple-git";

/** pull_skills 工具返回给模型的更新状态 */
export interface PullResult {
  /** 是否有新提交被拉取 */
  updated: boolean;
  /** 本次更新变更的文件列表 */
  changedFiles: string[];
  /** 人类可读的状态说明 */
  message: string;
}

export class GitManager {
  private readonly git: SimpleGit;

  constructor(
    private readonly repoPath: string,
    private readonly repoUrl: string | undefined,
  ) {
    this.git = simpleGit({ baseDir: repoPath });
  }

  /**
   * 启动时的同步逻辑：
   * - 未配置 SKILLS_REPO_URL：只校验本地仓库存在（POC 场景：直接指向本地技能仓库）
   * - 已配置且目录不存在：clone
   * - 已配置且目录已存在（是 Git 仓库）：pull
   */
  async syncOnStartup(): Promise<void> {
    const dirExists = fs.existsSync(this.repoPath);
    const isGitRepo = dirExists && fs.existsSync(path.join(this.repoPath, ".git"));

    if (!dirExists) {
      if (!this.repoUrl) {
        throw new Error(`SKILLS_REPO_PATH 不存在，且未配置 SKILLS_REPO_URL: ${this.repoPath}`);
      }
      fs.mkdirSync(this.repoPath, { recursive: true });
      await simpleGit().clone(this.repoUrl, this.repoPath);
      return;
    }

    if (this.repoUrl) {
      if (isGitRepo) {
        await this.git.pull();
      } else {
        throw new Error(`目录已存在但不是 Git 仓库，无法 clone/pull: ${this.repoPath}`);
      }
    }
  }

  /**
   * 手动拉取最新技能内容（pull_skills 工具）。
   * 返回是否有新提交以及更新了哪些文件；仓库没有配置远程时友好提示而不是抛错。
   */
  async pull(): Promise<PullResult> {
    const remotes = await this.git.getRemotes();
    if (remotes.length === 0) {
      return {
        updated: false,
        changedFiles: [],
        message: "仓库未配置远程（remote），跳过 pull。POC 本地技能仓库可直接修改文件后重新读取 resource。",
      };
    }

    const pullResult = await this.git.pull();
    const changedFiles = pullResult.files ?? [];
    const summary = pullResult.summary;
    return {
      updated: changedFiles.length > 0,
      changedFiles,
      message:
        changedFiles.length > 0
          ? `已拉取最新技能内容：${summary.changes} 个变更、${summary.insertions} 行新增、${summary.deletions} 行删除。更新文件：${changedFiles.join(", ")}`
          : "已是最新，没有需要拉取的提交。",
    };
  }
}

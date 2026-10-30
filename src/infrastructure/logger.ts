/**
 * logger.ts — 基础设施层：分级日志（stderr 输出，stdout 保留给 stdio 传输的协议报文）。
 *
 * 设计要点：
 * - 敏感信息（Git 认证密钥等）在输出前统一脱敏（需求文档 5.4）
 * - 结构化 JSON 日志为 P1 范围，当前提供文本格式，字段含时间戳与级别
 */

import type { LogLevel } from "../types.js";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(value: string): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

export class Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly secrets: readonly string[] = [],
  ) {}

  debug(message: string): void {
    this.write("debug", message);
  }

  info(message: string): void {
    this.write("info", message);
  }

  warn(message: string): void {
    this.write("warn", message);
  }

  error(message: string): void {
    this.write("error", message);
  }

  /** 把配置中收集到的密钥串替换为 ***，避免认证信息进入日志 */
  redact(message: string): string {
    let out = message;
    for (const secret of this.secrets) {
      // 过短的串容易误伤普通文本，跳过
      if (secret && secret.length >= 4) {
        out = out.split(secret).join("***");
      }
    }
    return out;
  }

  private write(level: LogLevel, message: string): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return;
    const time = new Date().toISOString();
    process.stderr.write(`[git-skills] ${time} [${level}] ${this.redact(message)}\n`);
  }
}

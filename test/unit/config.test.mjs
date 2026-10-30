/**
 * 单元测试：配置体系（infrastructure/config.js）
 * 覆盖：多层级优先级、旧环境变量兼容、${ENV_VAR} 插值、命名空间校验、路径解析
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, parseCliArgs, ConfigError } from "../../dist/infrastructure/config.js";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "skills-config-"));
}

const BASE_ENV = { ...process.env };
delete BASE_ENV.SKILLS_REPO_PATH;
delete BASE_ENV.SKILLS_REPO_URL;
delete BASE_ENV.SKILLS_REPO_BRANCH;
delete BASE_ENV.SKILLS_CONFIG;
delete BASE_ENV.SKILLS_LOG_LEVEL;

test("旧环境变量 SKILLS_REPO_PATH 映射为 default 命名空间单仓库", () => {
  const { config, secrets } = loadConfig({}, { ...BASE_ENV, SKILLS_REPO_PATH: "/tmp/repo" }, "/cwd");
  assert.equal(config.repos.length, 1);
  assert.equal(config.repos[0].namespace, "default");
  assert.equal(config.repos[0].path, path.resolve("/cwd", "/tmp/repo"));
  assert.equal(config.compat.legacyTools, true);
  assert.equal(config.autoPullOnStartup, true);
  assert.equal(config.pageSize, 100);
  assert.deepEqual(secrets, []);
});

test("配置文件与旧环境变量同时存在时，配置文件的 repos 优先", async () => {
  const dir = await makeTempDir();
  const configPath = path.join(dir, "cfg.yaml");
  await fs.writeFile(
    configPath,
    ["repos:", "  - namespace: team-a", "    path: ./repo-a"].join("\n"),
    "utf8",
  );
  const { config } = loadConfig(
    { configPath },
    { ...BASE_ENV, SKILLS_REPO_PATH: "/legacy" },
    "/cwd",
  );
  assert.equal(config.repos.length, 1);
  assert.equal(config.repos[0].namespace, "team-a");
  assert.equal(config.repos[0].path, path.resolve(dir, "repo-a"));
});

test("配置文件中的 repos 相对路径基于配置文件所在目录解析", async () => {
  const dir = await makeTempDir();
  await fs.writeFile(
    path.join(dir, "cfg.yaml"),
    ["repos:", "  - namespace: team-a", "    path: ./repo-a"].join("\n"),
    "utf8",
  );
  const { config } = loadConfig({ configPath: path.join(dir, "cfg.yaml") }, BASE_ENV, "/somewhere/else");
  assert.equal(config.repos[0].path, path.resolve(dir, "repo-a"));
});

test("没有任何仓库配置时抛出 ConfigError 并给出指引", () => {
  assert.throws(() => loadConfig({}, BASE_ENV, "/cwd"), ConfigError);
});

test("${ENV_VAR} 插值：已定义则替换并收集密钥，未定义则置空并告警", async () => {
  const dir = await makeTempDir();
  await fs.writeFile(
    path.join(dir, "cfg.yaml"),
    [
      "repos:",
      "  - namespace: a",
      "    path: ./r",
      "    url: https://example.com/r.git",
      "    auth:",
      "      username: bot",
      "      password: ${SECRET_TOKEN}",
    ].join("\n"),
    "utf8",
  );
  const env = { ...BASE_ENV, SECRET_TOKEN: "s3cr3t-value" };
  const { config, secrets, warnings } = loadConfig({ configPath: path.join(dir, "cfg.yaml") }, env);
  assert.equal(config.repos[0].auth?.password, "s3cr3t-value");
  assert.ok(secrets.includes("s3cr3t-value"));
  assert.equal(warnings.length, 0);

  const without = loadConfig({ configPath: path.join(dir, "cfg.yaml") }, BASE_ENV);
  assert.equal(without.config.repos[0].auth?.password, "");
  assert.ok(without.warnings.some((w) => w.includes("SECRET_TOKEN")));
});

test("命名空间重复时报错", async () => {
  const dir = await makeTempDir();
  await fs.writeFile(
    path.join(dir, "cfg.yaml"),
    ["repos:", "  - namespace: a", "    path: ./r1", "  - namespace: a", "    path: ./r2"].join("\n"),
    "utf8",
  );
  assert.throws(
    () => loadConfig({ configPath: path.join(dir, "cfg.yaml") }, BASE_ENV),
    /命名空间重复/,
  );
});

test("日志级别优先级：命令行 > 环境变量 > 配置文件 > 默认值", async () => {
  const dir = await makeTempDir();
  await fs.writeFile(
    path.join(dir, "cfg.yaml"),
    ["logLevel: warn", "repos:", "  - namespace: a", "    path: ./r"].join("\n"),
    "utf8",
  );
  const file = { configPath: path.join(dir, "cfg.yaml") };
  assert.equal(loadConfig(file, BASE_ENV).config.logLevel, "warn");
  assert.equal(loadConfig(file, { ...BASE_ENV, SKILLS_LOG_LEVEL: "error" }).config.logLevel, "error");
  assert.equal(loadConfig({ ...file, logLevel: "debug" }, { ...BASE_ENV, SKILLS_LOG_LEVEL: "error" }).config.logLevel, "debug");
  assert.equal(loadConfig({}, { ...BASE_ENV, SKILLS_REPO_PATH: "/r" }).config.logLevel, "info");
});

test("非法日志级别告警并回落默认值", async () => {
  const dir = await makeTempDir();
  await fs.writeFile(
    path.join(dir, "cfg.yaml"),
    ["logLevel: loud", "repos:", "  - namespace: a", "    path: ./r"].join("\n"),
    "utf8",
  );
  const { config, warnings } = loadConfig({ configPath: path.join(dir, "cfg.yaml") }, BASE_ENV);
  assert.equal(config.logLevel, "info");
  assert.ok(warnings.some((w) => w.includes("loud")));
});

test("pageSize 非法值回落 100", async () => {
  const dir = await makeTempDir();
  await fs.writeFile(
    path.join(dir, "cfg.yaml"),
    ["pageSize: 99999", "repos:", "  - namespace: a", "    path: ./r"].join("\n"),
    "utf8",
  );
  const { config, warnings } = loadConfig({ configPath: path.join(dir, "cfg.yaml") }, BASE_ENV);
  assert.equal(config.pageSize, 100);
  assert.ok(warnings.some((w) => w.includes("pageSize")));
});

test("compat 开关默认全开，配置可关闭", async () => {
  const dir = await makeTempDir();
  await fs.writeFile(
    path.join(dir, "cfg.yaml"),
    ["compat:", "  legacyTools: false", "repos:", "  - namespace: a", "    path: ./r"].join("\n"),
    "utf8",
  );
  const { config } = loadConfig({ configPath: path.join(dir, "cfg.yaml") }, BASE_ENV);
  assert.equal(config.compat.legacyTools, false);
  assert.equal(config.compat.legacyGitSkillsUris, true);
});

test("parseCliArgs 支持 --config <path> 与 --config=<path>", () => {
  assert.deepEqual(parseCliArgs(["--config", "a.yaml"]), { configPath: "a.yaml" });
  assert.deepEqual(parseCliArgs(["--config=b.yaml"]), { configPath: "b.yaml" });
  assert.deepEqual(parseCliArgs(["--log-level", "debug"]), { logLevel: "debug" });
  assert.deepEqual(parseCliArgs([]), {});
});

test("命名空间含非法字符（如斜杠）时跳过该项并告警（评审 P2 回归）", async () => {
  const dir = await makeTempDir();
  await fs.writeFile(
    path.join(dir, "cfg.yaml"),
    ["repos:", "  - namespace: bad/ns", "    path: ./r1", "  - namespace: good", "    path: ./r2"].join("\n"),
    "utf8",
  );
  const { config, warnings } = loadConfig({ configPath: path.join(dir, "cfg.yaml") }, BASE_ENV);
  assert.deepEqual(config.repos.map((r) => r.namespace), ["good"]);
  assert.ok(warnings.some((w) => w.includes("bad/ns")));
});

test("autoPullOnStartup / pageSize 类型错误时告警并回落默认值（评审 P2 回归）", async () => {
  const dir = await makeTempDir();
  await fs.writeFile(
    path.join(dir, "cfg.yaml"),
    ['autoPullOnStartup: "false"', "pageSize: fast", "repos:", "  - namespace: a", "    path: ./r"].join("\n"),
    "utf8",
  );
  const { config, warnings } = loadConfig({ configPath: path.join(dir, "cfg.yaml") }, BASE_ENV);
  assert.equal(config.autoPullOnStartup, true);
  assert.equal(config.pageSize, 100);
  assert.ok(warnings.some((w) => w.includes("autoPullOnStartup")));
  assert.ok(warnings.some((w) => w.includes("pageSize")));
});

/**
 * 单元测试：路径安全（storage/path-safety.js）
 * 覆盖：仓库根边界、技能目录边界、隐藏目录、软链接/junction 跳转（评审 P0 回归）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertWithinRepo,
  resolveWithinRepo,
  assertRealpathWithinRepo,
  assertNoHiddenSegments,
} from "../../dist/storage/path-safety.js";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "skills-safety-"));
}

test("resolveWithinRepo：正常相对路径解析成功", async () => {
  const root = await makeTempDir();
  const resolved = resolveWithinRepo(root, ["a", "b.md"], "a/b.md");
  assert.equal(resolved, path.join(root, "a", "b.md"));
});

test("resolveWithinRepo：../ 越权被拒绝，即使目标仍在磁盘上", async () => {
  const root = await makeTempDir();
  assert.throws(() => resolveWithinRepo(root, ["a", "..", "..", "outside.md"], "a/../../outside.md"), /拒绝/);
  assert.throws(() => resolveWithinRepo(root, ["..", "sibling.md"], "../sibling.md"), /拒绝/);
});

test("resolveWithinRepo：绝对路径与盘符越权被拒绝", async () => {
  const root = await makeTempDir();
  assert.throws(() => resolveWithinRepo(root, [path.resolve(root, "..", "evil.md")], "abs"), /拒绝/);
  if (process.platform === "win32") {
    assert.throws(() => resolveWithinRepo(root, ["C:/Windows/win.ini"], "C:/Windows/win.ini"), /拒绝/);
  } else {
    assert.throws(() => resolveWithinRepo(root, ["/etc/passwd"], "/etc/passwd"), /拒绝/);
  }
});

test("assertWithinRepo：仓库根本身合法", async () => {
  const root = await makeTempDir();
  assert.doesNotThrow(() => assertWithinRepo(root, path.resolve(root), "root"));
});

test("assertRealpathWithinRepo：仓库内软链接放行，指向仓库外的被拒绝（评审 P0 回归）", async (t) => {
  const root = await makeTempDir();
  const outside = await makeTempDir();
  await fs.writeFile(path.join(outside, "secret.txt"), "top secret", "utf8");

  // 仓库内正常目录：放行
  const insideDir = path.join(root, "normal");
  await fs.mkdir(insideDir, { recursive: true });
  await assertRealpathWithinRepo(root, insideDir, "normal");

  // 指向仓库外的 junction（Windows 免管理员）/软链接：拒绝
  const linkType = process.platform === "win32" ? "junction" : "dir";
  const escapeLink = path.join(root, "escape-link");
  try {
    await fs.symlink(outside, escapeLink, linkType);
  } catch {
    t.skip("当前环境无法创建符号链接，跳过本用例");
    return;
  }
  await assert.rejects(assertRealpathWithinRepo(root, escapeLink, "escape-link"), (error) =>
    error.message.includes("拒绝"),
  );
});

test("assertNoHiddenSegments：.git 等隐藏目录被拒绝（评审 P0 回归）", async () => {
  const root = await makeTempDir();
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await fs.mkdir(path.join(root, "skill", ".hidden"), { recursive: true });

  assert.throws(() => assertNoHiddenSegments(root, path.join(root, ".git"), ".git"), /隐藏目录/);
  assert.throws(() => assertNoHiddenSegments(root, path.join(root, "skill", ".hidden"), "skill/.hidden"), /隐藏目录/);
  // 普通路径不受影响
  assert.doesNotThrow(() => assertNoHiddenSegments(root, path.join(root, "skill", "refs"), "skill/refs"));
});

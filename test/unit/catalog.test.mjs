/**
 * 单元测试：技能目录服务（services/skill-catalog.js）
 * 覆盖：多仓库聚合、ID 解析（裸/带命名空间/冲突/不存在）、检索过滤、分页、
 *       URI 双前缀读写、摘要模式、目录渲染、子文件预览
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SkillCatalog, tagsOf } from "../../dist/services/skill-catalog.js";
import { Logger } from "../../dist/infrastructure/logger.js";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "skills-catalog-"));
}

async function writeSkill(repoPath, relDir, frontmatterLines, body = "# 正文\n", files = {}) {
  const dir = path.join(repoPath, ...relDir.split("/"));
  await fs.mkdir(dir, { recursive: true });
  const matter = ["---", ...frontmatterLines, "---"].join("\n");
  await fs.writeFile(path.join(dir, "SKILL.md"), `${matter}\n${body}`, "utf8");
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, ...rel.split("/"));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
  }
}

const quietLog = () => new Logger("error");

/** 搭两个仓库：team-a 有 shared 与 only-a；team-b 有 shared 与 only-b */
async function setupTwoRepos() {
  const root = await makeTempDir();
  const repoA = path.join(root, "repo-a");
  const repoB = path.join(root, "repo-b");
  await writeSkill(repoA, "shared", ["name: shared", "description: 共享技能A", "tags: [公共]"]);
  await writeSkill(repoA, "only-a", ["name: only-a", "description: A 独有技能"]);
  await writeSkill(repoB, "shared", ["name: shared", "description: 共享技能B"]);
  await writeSkill(repoB, "only-b", ["name: only-b", "description: B 独有技能", "tags: [财务]"]);
  const repos = [
    { namespace: "team-a", path: repoA },
    { namespace: "team-b", path: repoB },
  ];
  return { catalog: new SkillCatalog(repos, quietLog()), repoA, repoB, repos };
}

test("多仓库聚合：scanAll 返回两个命名空间的全部技能", async () => {
  const { catalog } = await setupTwoRepos();
  const { skills, warnings } = await catalog.scanAll();
  assert.equal(warnings.length, 0);
  const namespaces = new Set(skills.map((s) => s.namespace));
  assert.deepEqual([...namespaces].sort(), ["team-a", "team-b"]);
  assert.equal(skills.length, 4);
});

test("resolveById：唯一裸 ID 直通", async () => {
  const { catalog } = await setupTwoRepos();
  const skill = await catalog.resolveById("only-a");
  assert.equal(skill.namespace, "team-a");
});

test("resolveById：带命名空间前缀精确解析", async () => {
  const { catalog } = await setupTwoRepos();
  const skill = await catalog.resolveById("team-b/shared");
  assert.equal(skill.namespace, "team-b");
  assert.equal(skill.frontmatter.description, "共享技能B");
});

test("resolveById：裸 ID 跨仓库冲突时列出候选命名空间", async () => {
  const { catalog } = await setupTwoRepos();
  await assert.rejects(catalog.resolveById("shared"), /team-a\/shared, team-b\/shared/);
});

test("resolveById：不存在时报错并列出可用技能", async () => {
  const { catalog } = await setupTwoRepos();
  await assert.rejects(catalog.resolveById("ghost"), /可用技能: .*only-a/);
});

test("displayId：单仓库裸 ID，多仓库带命名空间", async () => {
  const { catalog, repos, repoA } = await setupTwoRepos();
  const skill = await catalog.resolveById("only-a");
  assert.equal(catalog.displayId(skill), "team-a/only-a");

  const single = new SkillCatalog([{ namespace: "default", path: repoA }], quietLog());
  const singleSkill = await single.resolveById("only-a");
  assert.equal(single.displayId(singleSkill), "only-a");
  void repos;
});

test("filterSkills：keyword / tag / repo 过滤与默认排序", async () => {
  const { catalog } = await setupTwoRepos();
  const { skills } = await catalog.scanAll();

  const byKeyword = catalog.filterSkills(skills, { keyword: "独有" });
  assert.deepEqual(byKeyword.map((s) => `${s.namespace}/${s.relPath}`).sort(), ["team-a/only-a", "team-b/only-b"]);

  const byTag = catalog.filterSkills(skills, { tag: "财务" });
  assert.deepEqual(byTag.map((s) => s.relPath), ["only-b"]);

  const byRepo = catalog.filterSkills(skills, { repo: "TEAM-A" });
  assert.equal(byRepo.length, 2);
  assert.ok(byRepo.every((s) => s.namespace === "team-a"));

  const sorted = catalog.filterSkills(skills);
  assert.deepEqual(
    sorted.map((s) => `${s.namespace}/${s.relPath}`),
    ["team-a/only-a", "team-a/shared", "team-b/only-b", "team-b/shared"],
  );
});

test("paginate：分页返回 nextCursor，游标可续页，非法游标报错", async () => {
  const { catalog } = await setupTwoRepos();
  const { skills } = await catalog.scanAll();

  const first = catalog.paginate(skills, undefined, 3);
  assert.equal(first.page.length, 3);
  assert.ok(first.nextCursor !== undefined);

  const second = catalog.paginate(skills, first.nextCursor, 3);
  assert.equal(second.page.length, 1);
  assert.equal(second.nextCursor, undefined);
  assert.equal(new Set([...first.page, ...second.page]).size, 4);

  assert.throws(() => catalog.paginate(skills, "not-a-number", 3), /cursor/);
});

test("readUri：标准前缀读取 SKILL.md / 子文件 / catalog，兼容前缀读取聚合目录", async () => {
  const { catalog, repoA } = await setupTwoRepos();
  await fs.mkdir(path.join(repoA, "only-a", "references"), { recursive: true });
  await fs.writeFile(path.join(repoA, "only-a", "references", "extra.md"), "额外规则\n", "utf8");

  const doc = await catalog.readUri("skill://team-a/only-a/SKILL.md");
  assert.match(doc.text, /name: only-a/);

  const file = await catalog.readUri("skill://team-a/only-a/references/extra.md");
  assert.match(file.text, /额外规则/);

  const catalogDoc = await catalog.readUri("skill://team-a/catalog");
  assert.match(catalogDoc.text, /only-a/);
  assert.doesNotMatch(catalogDoc.text, /only-b/);

  const legacy = await catalog.readUri("git-skills://catalog");
  assert.match(legacy.text, /only-a/);
  assert.match(legacy.text, /only-b/);
});

test("readUri：关闭兼容前缀后 legacy URI 报错", async () => {
  const { repos } = await setupTwoRepos();
  const strict = new SkillCatalog(repos, quietLog(), { legacyGitSkillsUris: false });
  await assert.rejects(strict.readUri("git-skills://catalog"), /兼容 URI 前缀已关闭/);
});

test("readUri：路径越权（../）与未知命名空间被拒绝", async () => {
  const { catalog, repoA } = await setupTwoRepos();
  await assert.rejects(
    catalog.readUri("skill://team-a/only-a/..%2F..%2Fsecret.md"),
    (error) => error.message.includes("拒绝") || error.message.includes("served"),
  );
  await assert.rejects(catalog.readUri("skill://ghost/catalog"), /命名空间不存在/);
});

test("readUri：留在仓库内但逃出技能目录的 ../ 被拒绝（评审 P0 回归：.git/非技能文件不可达）", async () => {
  const { catalog, repoA } = await setupTwoRepos();
  // 仓库根下的非技能文件（模拟 .git/config / top-secret.md 场景）
  await fs.writeFile(path.join(repoA, "top-secret.md"), "机密", "utf8");
  await assert.rejects(
    catalog.readUri("skill://team-a/only-a/../top-secret.md"),
    (error) => error.message.includes("拒绝"),
  );
  await assert.rejects(
    catalog.readUri("git-skills://skills/team-a/only-a/files/../top-secret.md"),
    (error) => error.message.includes("拒绝"),
  );
  // 仓库根下的 .git 目录同样不可达
  await assert.rejects(
    catalog.readUri("skill://team-a/only-a/../.git/config"),
    (error) => error.message.includes("拒绝") || error.message.includes("隐藏"),
  );
});

test("legacy URI：多仓库带斜杠 ID（{ns}/{relPath}）可读取（评审 P1 回归：广告即死链）", async () => {
  const { catalog } = await setupTwoRepos();
  const legacyDoc = await catalog.readUri("git-skills://skills/team-a/only-a/SKILL.md");
  assert.match(legacyDoc.text, /name: only-a/);
});

test("resolveById：嵌套技能 relPath 首段撞上命名空间时，带前缀 ID 解析会回退裸 ID 匹配（评审 P1 回归）", async () => {
  const root = await makeTempDir();
  // 嵌套技能 team-a/default：其 relPath 以 "team-a/" 开头，与命名空间 team-a 同形
  await writeSkill(root, "team-a/default", ["name: default", "description: 首段撞命名空间名的嵌套技能"]);
  const catalog = new SkillCatalog([{ namespace: "team-a", path: root }], quietLog());
  const skill = await catalog.resolveById("team-a/default");
  assert.equal(skill.relPath, "team-a/default");
  assert.equal(skill.namespace, "team-a");
});

test("parseStandardUri：嵌套技能优先长路径匹配", async () => {
  const root = await makeTempDir();
  await writeSkill(
    root,
    "outer",
    ["name: outer", "description: d"],
    "# x\n",
    { "inner/SKILL.md": "---\nname: inner\ndescription: d\n---\n\n# y\n" },
  );
  const catalog = new SkillCatalog([{ namespace: "default", path: root }], quietLog());
  const { skills } = await catalog.scanAll();

  const nested = catalog.parseStandardUri("skill://default/outer/inner/SKILL.md", skills);
  assert.equal(nested.kind, "skill-doc");
  assert.equal(nested.skill.relPath, "outer/inner");

  // rest 恰好等于嵌套技能路径 = 技能根目录（directory resource），优先长路径匹配
  const nestedDir = catalog.parseStandardUri("skill://default/outer/inner", skills);
  assert.equal(nestedDir.kind, "skill-dir");
  assert.equal(nestedDir.skill.relPath, "outer/inner");

  // resources/read 不接受目录资源
  await assert.rejects(catalog.readUri("skill://default/outer/inner"), /目录资源/);
});

test("toStandardEntry：SEP-2640 Skill 条目形状（frontmatter 透传 + 完整 manifest）", async () => {
  const { catalog, repoA } = await setupTwoRepos();
  const skill = await catalog.resolveById("only-a");
  const entry = catalog.toStandardEntry(skill);

  assert.equal(entry.uri, "skill://team-a/only-a/SKILL.md");
  assert.equal(entry.frontmatter.name, "only-a");
  assert.equal(entry.frontmatter.description, "A 独有技能");
  // 清单必须含 SKILL.md 本身，digest 为 sha256:{hex} 格式
  const skillMd = entry.resources.find((r) => r.uri === entry.uri);
  assert.ok(skillMd);
  assert.match(skillMd.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(typeof skillMd.size, "number");

  // digest 与实际文件字节一致
  const disk = await fs.readFile(path.join(repoA, "only-a", "SKILL.md"));
  assert.equal(skillMd.size, disk.length);
});

test("renderSummary：只含元数据与标题大纲，不含正文细节", async () => {
  const root = await makeTempDir();
  await writeSkill(
    root,
    "outline-test",
    ["name: outline-test", "description: 触发描述"],
    "# 流程\n\n## 步骤一\n调用 secretFn() 做事\n\n## 步骤二\n收尾\n",
  );
  const catalog = new SkillCatalog([{ namespace: "default", path: root }], quietLog());
  const skill = await catalog.resolveById("outline-test");
  const summary = await catalog.renderSummary(skill);

  assert.match(summary, /触发描述/);
  assert.match(summary, /步骤一/);
  assert.match(summary, /步骤二/);
  assert.doesNotMatch(summary, /secretFn/);
});

test("renderCatalog：按标签分组、含双前缀 URI 与触发时机", async () => {
  const { catalog } = await setupTwoRepos();
  const { skills } = await catalog.scanAll();
  const text = catalog.renderCatalog(skills);

  assert.match(text, /## 标签：公共/);
  assert.match(text, /## 标签：财务/);
  assert.match(text, /## 标签：未分类/);
  assert.match(text, /共享技能A/);
  assert.match(text, /skill:\/\/team-a\/shared\/SKILL\.md/);
  assert.match(text, /git-skills:\/\/skills\/team-a\/shared\/SKILL\.md/);
});

test("listSkillFiles：返回子文件元数据（不含 SKILL.md），tagsOf 容错", async () => {
  const root = await makeTempDir();
  await writeSkill(
    root,
    "files-test",
    ["name: files-test", "description: d", "tags: not-an-array"],
    "# x\n",
    { "references/a.md": "a\n", "references/b.md": "b\n" },
  );
  const catalog = new SkillCatalog([{ namespace: "default", path: root }], quietLog());
  const skill = await catalog.resolveById("files-test");
  const files = catalog.listSkillFiles(skill);
  assert.deepEqual(files.map((f) => f.relPath), ["references/a.md", "references/b.md"]);
  assert.ok(files.every((f) => f.size > 0 && f.mtimeMs > 0));
  assert.deepEqual(tagsOf(skill), []); // tags 非数组时容错为空
});

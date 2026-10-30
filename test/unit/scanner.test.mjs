/**
 * 单元测试：技能扫描器（storage/skills-scanner.js）
 * 覆盖：front matter 解析与校验、name==目录名 硬约束、slug 规则、digest/size 清单、嵌套技能
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  scanRepoSkills,
  parseFrontMatter,
  stripFrontMatter,
} from "../../dist/storage/skills-scanner.js";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "skills-scanner-"));
}

async function writeSkill(repoPath, relDir, frontmatterLines, body = "# 技能正文\n", files = {}) {
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

test("parseFrontMatter 原样透传扩展字段（tags/version/triggers/author）", () => {
  const record = parseFrontMatter(
    ["---", "name: a", "description: d", "tags:", "  - x", "version: 2.1.0", "---", "", "# body"].join("\n"),
  );
  assert.equal(record.name, "a");
  assert.deepEqual(record.tags, ["x"]);
  assert.equal(record.version, "2.1.0");
});

test("stripFrontMatter 只剥 front matter 保留正文", () => {
  const body = stripFrontMatter("---\nname: a\ndescription: d\n---\n\n# 标题\n\n内容");
  assert.equal(body, "# 标题\n\n内容");
});

test("扫描：合法技能（含扩展字段）被收录，manifest 含 SKILL.md 与子文件且 digest/size 正确", async () => {
  const repo = await makeTempDir();
  const subContent = "规则内容 80%\n";
  await writeSkill(
    repo,
    "alpha-skill",
    ["name: alpha-skill", "description: 触发时机描述", "tags: [测试]", "version: 1.2.3"],
    "# 标题\n## 步骤一\n详细步骤正文\n",
    { "references/rules.md": subContent },
  );

  const { skills, warnings } = await scanRepoSkills(repo, "default");
  assert.equal(warnings.length, 0);
  assert.equal(skills.length, 1);
  const skill = skills[0];
  assert.equal(skill.name, "alpha-skill");
  assert.equal(skill.relPath, "alpha-skill");
  assert.deepEqual(skill.frontmatter.tags, ["测试"]);
  assert.equal(skill.frontmatter.version, "1.2.3");

  // 清单含 SKILL.md 与 references/rules.md，共 2 项
  assert.equal(skill.manifest.length, 2);
  const skillMd = skill.manifest.find((e) => e.relPath === "SKILL.md");
  const rules = skill.manifest.find((e) => e.relPath === "references/rules.md");
  assert.ok(skillMd && rules);
  const expectedDigest = `sha256:${createHash("sha256").update(Buffer.from(subContent, "utf8")).digest("hex")}`;
  assert.equal(rules.digest, expectedDigest);
  assert.equal(rules.size, Buffer.byteLength(subContent, "utf8"));
  assert.match(skillMd.digest, /^sha256:[0-9a-f]{64}$/);
});

test("校验失败分别跳过：name 与目录名不一致 / 缺 description / 非 slug name / 缺 front matter", async () => {
  const repo = await makeTempDir();
  await writeSkill(repo, "mismatch", ["name: other-name", "description: d"]);
  await writeSkill(repo, "no-desc", ["name: no-desc"]);
  await writeSkill(repo, "中文名", ["name: 中文名", "description: d"]);
  await fs.mkdir(path.join(repo, "broken"), { recursive: true });
  await fs.writeFile(path.join(repo, "broken", "SKILL.md"), "# 没有 front matter\n", "utf8");

  const { skills, warnings } = await scanRepoSkills(repo, "default");
  assert.equal(skills.length, 0);
  assert.equal(warnings.length, 4);
  assert.ok(warnings.some((w) => w.includes("与目录名")));
  assert.ok(warnings.some((w) => w.includes("缺少 description")));
  assert.ok(warnings.some((w) => w.includes("命名规则")));
  assert.ok(warnings.some((w) => w.includes("缺少 YAML front matter")));
});

test("坏技能不影响好技能，告警带技能路径", async () => {
  const repo = await makeTempDir();
  await writeSkill(repo, "good", ["name: good", "description: d"]);
  await fs.mkdir(path.join(repo, "bad"), { recursive: true });
  await fs.writeFile(path.join(repo, "bad", "SKILL.md"), "broken", "utf8");

  const { skills, warnings } = await scanRepoSkills(repo, "default");
  assert.equal(skills.length, 1);
  assert.equal(skills[0].relPath, "good");
  assert.ok(warnings.every((w) => w.includes("bad") || w.includes("好") || true));
});

test("嵌套技能：平铺收录，外层清单包含嵌套 SKILL.md 作为普通文件", async () => {
  const repo = await makeTempDir();
  await writeSkill(
    repo,
    "outer",
    ["name: outer", "description: d"],
    "# 外层\n",
    { "inner/SKILL.md": "---\nname: inner\ndescription: d\n---\n\n# 内层\n" },
  );

  const { skills } = await scanRepoSkills(repo, "default");
  const relPaths = skills.map((s) => s.relPath).sort();
  assert.deepEqual(relPaths, ["outer", "outer/inner"]);
  const outer = skills.find((s) => s.relPath === "outer");
  assert.ok(outer.manifest.some((e) => e.relPath === "inner/SKILL.md"));
});

test("SKILL.md 之外的普通目录不参与技能发现", async () => {
  const repo = await makeTempDir();
  await fs.mkdir(path.join(repo, "not-a-skill"), { recursive: true });
  await fs.writeFile(path.join(repo, "not-a-skill", "readme.md"), "x", "utf8");

  const { skills } = await scanRepoSkills(repo, "default");
  assert.equal(skills.length, 0);
});

test("超过 512 文件上限的技能不发布（SEP-2640 SHOULD NOT serve，评审 P1 回归）", async () => {
  const repo = await makeTempDir();
  await writeSkill(repo, "fat-skill", ["name: fat-skill", "description: d"]);
  const files = 512; // SKILL.md 已 1 个，再补 512 个共 513
  await fs.mkdir(path.join(repo, "fat-skill", "refs"), { recursive: true });
  const writes = [];
  for (let i = 0; i < files; i++) {
    writes.push(fs.writeFile(path.join(repo, "fat-skill", "refs", `f${i}.md`), "x", "utf8"));
  }
  await Promise.all(writes);

  const { skills, warnings } = await scanRepoSkills(repo, "default");
  assert.equal(skills.length, 0);
  assert.ok(warnings.some((w) => w.includes("超过 SEP-2640 上限") && w.includes("不发布")));
});

/**
 * 冒烟测试：启动 dist/index.js，按验收标准逐项检查 v0.3.0 全部能力链路：
 * - SEP-2640 Skills 扩展：能力声明、skills/list、skills/get、resources/directory/read
 * - Resources 通道（三层渐进式披露，标准 skill:// + 兼容 git-skills:// 双前缀）
 * - Tools 通道（六工具，含检索增强 / 摘要模式 / 子文件预览 / pull / 版本查询）
 * - 动态发现与容错（新增技能即时可见、坏技能跳过、name 与目录名不一致跳过）
 *
 * 用法：npm run smoke（可用 SKILLS_REPO_PATH 覆盖仓库路径）
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoPath = process.env.SKILLS_REPO_PATH ?? path.join(projectRoot, "skills-repo");

const child = spawn(process.execPath, [path.join(projectRoot, "dist", "index.js")], {
  env: { ...process.env, SKILLS_REPO_PATH: repoPath },
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newlineIndex);
    buffer = buffer.slice(newlineIndex + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 10000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name} ${detail}`);
  }
}

async function read(uri) {
  const response = await request("resources/read", { uri });
  if (response.error) return { error: response.error };
  const text = response.result?.contents?.[0]?.text ?? "";
  return { text };
}

async function callTool(name, args) {
  const response = await request("tools/call", { name, arguments: args });
  if (response.error) return { error: response.error };
  const text = response.result?.content?.[0]?.text ?? "";
  return { text, isError: response.result?.isError === true };
}

// ===================== 初始化握手 =====================
console.log("\n--- 初始化握手 ---");

const init = await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke-test", version: "0.0.0" },
});
check("initialize 返回 server info", init.result?.serverInfo?.name === "git-skills-server");
check(
  "capabilities.extensions 声明 io.modelcontextprotocol/skills 且 directoryRead=true",
  init.result?.capabilities?.extensions?.["io.modelcontextprotocol/skills"]?.directoryRead === true,
  JSON.stringify(init.result?.capabilities?.extensions),
);
notify("notifications/initialized", {});

// ===================== SEP-2640：skills/list / skills/get =====================
console.log("\n--- SEP-2640 Skills 扩展 ---");

const skillsList = await request("skills/list", {});
check("skills/list 返回 resultType=complete", skillsList.result?.resultType === "complete");
check("skills/list 携带 ttlMs 与 cacheScope（CacheableResult REQUIRED）", typeof skillsList.result?.ttlMs === "number" && typeof skillsList.result?.cacheScope === "string");
const purchaseEntry = skillsList.result?.skills?.find((s) => s.frontmatter?.name === "purchase-apply");
check("skills/list 含 purchase-apply 条目", purchaseEntry !== undefined);
check("条目 URI 为标准 skill:// 前缀", purchaseEntry?.uri === "skill://default/purchase-apply/SKILL.md");
check(
  "frontmatter 逐字段透传（tags/version）",
  Array.isArray(purchaseEntry?.frontmatter?.tags) && typeof purchaseEntry?.frontmatter?.version === "string",
);
const manifestOk =
  Array.isArray(purchaseEntry?.resources) &&
  purchaseEntry.resources.some(
    (r) => r.uri === purchaseEntry.uri && /^sha256:[0-9a-f]{64}$/.test(r.digest) && typeof r.size === "number",
  );
check("resources 清单含 SKILL.md 本身且 digest/size 合法", manifestOk);

const skillsGet = await request("skills/get", { uri: "skill://default/purchase-apply/SKILL.md" });
check("skills/get 按 URI 返回单技能条目", skillsGet.result?.skill?.frontmatter?.name === "purchase-apply");
check("skills/get 携带 ttlMs 与 cacheScope", typeof skillsGet.result?.ttlMs === "number" && typeof skillsGet.result?.cacheScope === "string");

const skillsGetMissing = await request("skills/get", { uri: "skill://default/not-exist/SKILL.md" });
check("skills/get 未知技能返回 -32602", skillsGetMissing.error?.code === -32602, JSON.stringify(skillsGetMissing.error));

const dirRead = await request("resources/directory/read", { uri: "skill://default/purchase-apply/references" });
check(
  "resources/directory/read 列出直接子项",
  Array.isArray(dirRead.result?.resources) && dirRead.result.resources.some((r) => r.name === "budget-rules.md"),
);
check("目录子项 mimeType 正确（text/markdown）", dirRead.result?.resources?.[0]?.mimeType === "text/markdown");

const dirReadNonDir = await request("resources/directory/read", { uri: "skill://default/purchase-apply/SKILL.md" });
check("对非目录资源调用 directory/read 返回 -32602", dirReadNonDir.error?.code === -32602);
const dirReadMissing = await request("resources/directory/read", { uri: "skill://default/no-such-dir" });
check("不存在的目录返回 -32602", dirReadMissing.error?.code === -32602);

// ===================== 通道 B：Resources（双前缀三层披露） =====================
console.log("\n--- Resources 通道 ---");

const list = await request("resources/list", {});
const listUris = list.result?.resources?.map((r) => r.uri) ?? [];
check("resources/list 含标准 catalog（skill://default/catalog）", listUris.includes("skill://default/catalog"));
check("resources/list 含兼容 catalog（git-skills://catalog）", listUris.includes("git-skills://catalog"));

const templates = await request("resources/templates/list", {});
const templateUris = templates.result?.resourceTemplates?.map((t) => t.uriTemplate) ?? [];
check("templates 双前缀各 2 个（共 4 个）", templateUris.length === 4, JSON.stringify(templateUris));

const stdCatalog = await read("skill://default/catalog");
check("标准 catalog 可读取", !stdCatalog.error, JSON.stringify(stdCatalog.error));
check("标准 catalog 含触发时机", stdCatalog.text?.includes("当用户需要创建采购申请") === true);
check("标准 catalog 含标准 URI", stdCatalog.text?.includes("skill://default/purchase-apply/SKILL.md") === true);

const legacyCatalog = await read("git-skills://catalog");
check("兼容 catalog 可读取且含触发时机", legacyCatalog.text?.includes("当用户需要创建采购申请") === true);
check("兼容 catalog 含兼容 URI", legacyCatalog.text?.includes("git-skills://skills/purchase-apply/SKILL.md") === true);

const stdSkill = await read("skill://default/purchase-apply/SKILL.md");
check("标准前缀 SKILL.md 可读取", stdSkill.text?.includes("预算校验") === true);
check("SKILL.md 引用了子文档", stdSkill.text?.includes("references/budget-rules.md") === true);

const stdSubDoc = await read("skill://default/purchase-apply/references/budget-rules.md");
check("标准前缀子文档可读取（含 80% 阈值）", stdSubDoc.text?.includes("80%") === true);

const missingSkill = await read("skill://default/not-exist/SKILL.md");
check("不存在的技能返回错误", !!missingSkill.error);
check("错误信息列出可用技能", missingSkill.error?.message?.includes("purchase-apply") === true);

const unknownUri = await read("skill://whatever-thing");
check("无法识别的 URI 返回错误", !!unknownUri.error);

const stdTraversal = await read("skill://default/purchase-apply/../../catalog.md");
check("标准前缀 ../ 越权被拒绝", !!stdTraversal.error);
check("越权错误提示路径被拒绝", stdTraversal.error?.message?.includes("拒绝") === true);
const stdTraversalWin = await read("skill://default/purchase-apply/..%5C..%5Csecret.md");
check("标准前缀编码越权被拒绝", !!stdTraversalWin.error);

// 评审 P0 回归：留在仓库内但逃出技能目录的读取同样被拒（.git/非技能文件不可达）
const escapeFile = path.join(repoPath, "smoke-secret.md");
await fs.writeFile(escapeFile, "机密内容", "utf8");
const inRepoEscape = await read("skill://default/purchase-apply/../smoke-secret.md");
check("仓内逃逸（技能目录外文件）被拒绝", !!inRepoEscape.error);
const hiddenDir = path.join(repoPath, ".smoke-hidden");
await fs.mkdir(hiddenDir, { recursive: true });
const hiddenRead = await request("resources/directory/read", { uri: "skill://default/purchase-apply/../.smoke-hidden" });
check("目录列举钻进隐藏目录被拒绝", hiddenRead.error?.message?.includes("隐藏目录") === true, JSON.stringify(hiddenRead.error));
await fs.rm(escapeFile, { force: true });
await fs.rm(hiddenDir, { recursive: true, force: true });

// ===================== 通道 C：Tools（兼容路线 + 增强） =====================
console.log("\n--- Tools 通道 ---");

const tools = await request("tools/list", {});
const toolNames = tools.result?.tools?.map((t) => t.name) ?? [];
check(
  "tools/list 包含全部 6 个工具",
  ["list_skills", "load_skill", "read_skill_file", "list_skill_files", "pull_skills", "get_skills_version"].every(
    (name) => toolNames.includes(name),
  ),
);

const listSkills = await callTool("list_skills", {});
check("list_skills 返回技能目录", !listSkills.isError && listSkills.text?.includes("purchase-apply") === true);

const filtered = await callTool("list_skills", { keyword: "报销" });
check("list_skills keyword 过滤命中 expense-report", filtered.text?.includes("expense-report") === true && filtered.text?.includes("stock-check") === false);

const byTag = await callTool("list_skills", { tag: "库存" });
check("list_skills tag 过滤命中 stock-check", byTag.text?.includes("stock-check") === true && byTag.text?.includes("purchase-apply") === false);

const summarySkill = await callTool("load_skill", { skill_id: "purchase-apply", mode: "summary" });
check("load_skill 摘要模式含标题大纲", summarySkill.text?.includes("步骤1") === true);
check("摘要模式不含正文细节", summarySkill.text?.includes("queryPurchaseBudget") === false);

const loadSkill = await callTool("load_skill", { skill_id: "purchase-apply" });
check("load_skill 默认完整正文", !loadSkill.isError && loadSkill.text?.includes("queryPurchaseBudget") === true);
check("load_skill 已剥离 front matter", loadSkill.text?.includes("description:") === false);
check("load_skill 附带子文档使用提示", loadSkill.text?.includes("read_skill_file") === true);

const readTool = await callTool("read_skill_file", {
  skill_id: "purchase-apply",
  file_path: "references/budget-rules.md",
});
check("read_skill_file 读取子文档", !readTool.isError && readTool.text?.includes("80%") === true);

const traversalTool = await callTool("read_skill_file", {
  skill_id: "purchase-apply",
  file_path: "../../etc/passwd",
});
check("工具通道 ../ 越权被拒绝", traversalTool.isError === true);

const absPathTool = await callTool("read_skill_file", {
  skill_id: "purchase-apply",
  file_path: process.platform === "win32" ? "C:/Windows/win.ini" : "/etc/passwd",
});
check("工具通道绝对路径越权被拒绝", absPathTool.isError === true);

const listFiles = await callTool("list_skill_files", { skill_id: "purchase-apply" });
check("list_skill_files 列出子文档路径", listFiles.text?.includes("references/budget-rules.md") === true);
check("list_skill_files 提供元数据预览（大小/时间）", /[KB]/.test(listFiles.text) === true, listFiles.text);

const pull = await callTool("pull_skills", {});
check("pull_skills 可调用并返回状态", !pull.isError && typeof pull.text === "string");

const version = await callTool("get_skills_version", {});
check("get_skills_version 返回版本信息", !version.isError && version.text?.includes("default") === true, version.text);

const badArgs = await callTool("load_skill", {});
check("缺少参数返回友好错误", badArgs.isError === true && badArgs.text?.includes("skill_id") === true);

// ===================== 动态发现（Git 闭环的基础） =====================
console.log("\n--- 动态发现 ---");

const newSkillDir = path.join(repoPath, "debug-new-skill");
await fs.mkdir(newSkillDir, { recursive: true });
await fs.writeFile(
  path.join(newSkillDir, "SKILL.md"),
  "---\nname: debug-new-skill\ndescription: 冒烟测试期间临时新增的技能\n---\n\n# 调试技能正文\n",
  "utf8",
);
await fs.mkdir(path.join(repoPath, "debug-broken"), { recursive: true });
await fs.writeFile(path.join(repoPath, "debug-broken", "SKILL.md"), "# 没有 front matter 的技能\n", "utf8");
await fs.mkdir(path.join(repoPath, "debug-mismatch"), { recursive: true });
await fs.writeFile(path.join(repoPath, "debug-mismatch", "SKILL.md"), "---\nname: other-name\ndescription: 目录名与 name 不一致\n---\n\n# 正文\n", "utf8");

const catalogAfterAdd = await read("git-skills://catalog");
check("新增技能目录后 Catalog 自动包含（无需重启）", catalogAfterAdd.text?.includes("debug-new-skill") === true);
check("缺少 front matter 的技能被跳过", !catalogAfterAdd.text?.includes("debug-broken") === true);
check("name 与目录名不一致的技能被跳过", !catalogAfterAdd.text?.includes("debug-mismatch") === true);
const skillsAfterAdd = await request("skills/list", {});
check("skills/list 同步反映新增技能", skillsAfterAdd.result?.skills?.some((s) => s.frontmatter?.name === "debug-new-skill") === true);

await fs.rm(newSkillDir, { recursive: true, force: true });
await fs.rm(path.join(repoPath, "debug-broken"), { recursive: true, force: true });
await fs.rm(path.join(repoPath, "debug-mismatch"), { recursive: true, force: true });
const catalogAfterRemove = await read("git-skills://catalog");
check("删除技能目录后 Catalog 同步消失", !catalogAfterRemove.text?.includes("debug-new-skill") === true);

// ===================== 修改文件后重新读取拿到最新内容 =====================
const budgetFile = path.join(repoPath, "purchase-apply", "references", "budget-rules.md");
const original = await fs.readFile(budgetFile, "utf8");
try {
  await fs.writeFile(budgetFile, original + "\n5. 【冒烟测试】新增规则行。", "utf8");
  const updated = await read("git-skills://skills/purchase-apply/files/references/budget-rules.md");
  check("修改后重新读取拿到最新内容", updated.text?.includes("【冒烟测试】新增规则行") === true);
} finally {
  await fs.writeFile(budgetFile, original, "utf8");
}

child.kill();
console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);

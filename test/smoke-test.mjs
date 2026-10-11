/**
 * 冒烟测试：启动 dist/index.js，按验收标准逐项检查三层渐进式披露链路（Resources 通道 + Tools 通道 + 动态发现）。
 * 用法：node test/smoke-test.mjs（可用 SKILLS_REPO_PATH 覆盖仓库路径）
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

const init = await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke-test", version: "0.0.0" },
});
check("initialize 返回 server info", init.result?.serverInfo?.name === "git-skills-server");
notify("notifications/initialized", {});

// ===================== 通道 A：Resources（三层渐进式披露） =====================
console.log("\n--- 通道 A：Resources ---");

const list = await request("resources/list", {});
check("resources/list 只返回 1 个资源", list.result?.resources?.length === 1);
check("资源 URI 是 git-skills://catalog", list.result?.resources?.[0]?.uri === "git-skills://catalog");

const catalog = await read("git-skills://catalog");
check("catalog 可读取（front matter 扫描生成，无需 catalog.md）", !catalog.error, JSON.stringify(catalog.error));
check("catalog 含 purchase-apply 触发时机", catalog.text?.includes("当用户需要创建采购申请") === true);
check("catalog 含 SKILL.md 完整 URI", catalog.text?.includes("git-skills://skills/purchase-apply/SKILL.md") === true);

const templates = await request("resources/templates/list", {});
check("templates/list 返回 2 个模板", templates.result?.resourceTemplates?.length === 2);

const skill = await read("git-skills://skills/purchase-apply/SKILL.md");
check("SKILL.md 可读取", !skill.error, JSON.stringify(skill.error));
check("SKILL.md 含步骤内容", skill.text?.includes("预算校验") === true);
check("SKILL.md 引用了子文档", skill.text?.includes("references/budget-rules.md") === true);

const subDoc = await read("git-skills://skills/purchase-apply/files/references/budget-rules.md");
check("子文档 budget-rules.md 可读取", !subDoc.error, JSON.stringify(subDoc.error));
check("子文档内容正确（含 80% 阈值）", subDoc.text?.includes("80%") === true);

const missingSkill = await read("git-skills://skills/not-exist/SKILL.md");
check("不存在的技能返回错误", !!missingSkill.error);
check("错误信息列出可用技能", missingSkill.error?.message?.includes("purchase-apply") === true);

const unknownUri = await read("git-skills://whatever");
check("无法识别的 URI 返回错误", !!unknownUri.error);

const traversal = await read("git-skills://skills/purchase-apply/files/../../catalog.md");
check("../ 越权访问被拒绝", !!traversal.error);
check("越权错误提示路径被拒绝", traversal.error?.message?.includes("拒绝") === true);
const traversalWin = await read("git-skills://skills/purchase-apply/files/..%5C..%5Csecret.md");
check("%2E/%5C 编码的越权访问被拒绝", !!traversalWin.error);

// ===================== 通道 B：Tools（兼容路线，同一份数据） =====================
console.log("\n--- 通道 B：Tools ---");

const tools = await request("tools/list", {});
const toolNames = tools.result?.tools?.map((t) => t.name) ?? [];
check(
  "tools/list 包含全部 5 个工具",
  ["list_skills", "load_skill", "read_skill_file", "list_skill_files", "pull_skills"].every((name) =>
    toolNames.includes(name),
  ),
);

const listSkills = await callTool("list_skills", {});
check("list_skills 返回技能目录", !listSkills.isError && listSkills.text?.includes("purchase-apply") === true);

const loadSkill = await callTool("load_skill", { skill_id: "purchase-apply" });
check("load_skill 返回流程正文", !loadSkill.isError && loadSkill.text?.includes("预算校验") === true);
check("load_skill 已剥离 front matter", !loadSkill.text?.includes("description:") === true);
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
check("list_skill_files 列出全部子文档", listFiles.text?.includes("references/budget-rules.md") === true);

const pull = await callTool("pull_skills", {});
check("pull_skills 可调用并返回状态", !pull.isError && typeof pull.text === "string");

const badArgs = await callTool("load_skill", {});
check("缺少参数返回友好错误", badArgs.isError === true && badArgs.text?.includes("skill_id") === true);

// ===================== 动态发现（Git 闭环的基础） =====================
console.log("\n--- 动态发现 ---");

const newSkillDir = path.join(repoPath, "debug-new-skill");
await fs.mkdir(newSkillDir, { recursive: true });
await fs.writeFile(
  path.join(newSkillDir, "SKILL.md"),
  "---\nname: 调试技能\ndescription: 冒烟测试期间临时新增的技能\n---\n\n# 调试技能正文\n",
  "utf8",
);
await fs.mkdir(path.join(repoPath, "debug-broken"), { recursive: true });
await fs.writeFile(path.join(repoPath, "debug-broken", "SKILL.md"), "# 没有 front matter 的技能\n", "utf8");

const catalogAfterAdd = await read("git-skills://catalog");
check("新增技能目录后 Catalog 自动包含（无需重启）", catalogAfterAdd.text?.includes("debug-new-skill") === true);
check("缺少 front matter 的技能被跳过并记录", !catalogAfterAdd.text?.includes("debug-broken") === true);

await fs.rm(newSkillDir, { recursive: true, force: true });
await fs.rm(path.join(repoPath, "debug-broken"), { recursive: true, force: true });
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

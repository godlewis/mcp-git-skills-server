/**
 * catalog-parser.ts — 第一层（技能索引 Catalog）的渲染。
 *
 * 第一层对应代码位置：
 * - 技能条目不再来自 catalog.md 表格，而是由 skill-registry.ts 扫描各 SKILL.md 的 front matter 动态生成
 *   （description 即触发时机 when_to_use），因此 Catalog 永远与仓库实际内容一致，不会漂移
 * - renderCatalog(): 把结构化条目渲染成带 SKILL.md 完整 URI 的目录，返回给模型
 */

/** 一个技能条目（来自 SKILL.md front matter） */
export interface SkillEntry {
  /** 技能唯一标识 = 仓库中的技能目录名 */
  skillId: string;
  /** 技能名称（front matter 的 name） */
  name: string;
  /** 触发时机描述（front matter 的 description）：模型根据它判断是否需要加载该技能 */
  whenToUse: string;
  /** 一句话摘要（front matter 的 summary，可选） */
  summary: string;
}

/** 生成某个技能 SKILL.md 资源的完整 URI（模型按需读取第二层） */
export function skillDocUri(skillId: string): string {
  return `git-skills://skills/${skillId}/SKILL.md`;
}

/**
 * 把结构化技能条目渲染成返回给模型的 Catalog Markdown。
 * 关键点：每个条目直接给出 SKILL.md 的完整 URI，模型读完目录后就知道该读哪个。
 */
export function renderCatalog(entries: SkillEntry[]): string {
  const sections = entries.map((entry, index) => {
    const lines = [
      `## ${index + 1}. ${entry.name} (${entry.skillId})`,
      "",
      `- **触发时机**: ${entry.whenToUse}`,
    ];
    if (entry.summary) {
      lines.push(`- **简介**: ${entry.summary}`);
    }
    lines.push(`- **详细流程**: 读取 \`${skillDocUri(entry.skillId)}\``);
    return lines.join("\n");
  });
  return [
    "# 业务技能目录",
    "",
    "以下是可用的业务技能。根据用户任务判断是否需要加载某个技能的详细流程。",
    "",
    "---",
    "",
    sections.join("\n\n---\n\n"),
    "",
    "---",
  ].join("\n");
}

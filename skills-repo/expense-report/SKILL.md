---
name: 报销单处理
description: 当用户提交费用报销、查询报销进度、补充报销凭证时使用。
summary: 报销单创建、凭证上传指引、审批状态查询
---

# 报销单处理流程

## 执行步骤

### 步骤1：创建报销单
调用 createExpenseReport(dept, amount, category)，生成报销单号。
费用类别与凭证要求见 references/receipt-rules.md

### 步骤2：补充报销凭证
调用 uploadReceipt(report_id, file_list) 上传凭证。
凭证不齐全时报销单会停留在"待补充"状态。

### 步骤3：查询审批状态
调用 getExpenseStatus(report_id)，返回当前审批节点与预计完成时间。

## 注意事项
- 单笔金额超过 1 万元需附加部门经理线下审批截图。
- 报销单提交后 24 小时内可撤回修改，之后需走驳回流程。

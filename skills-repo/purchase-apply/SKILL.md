---
name: purchase-apply
description: 当用户需要创建采购申请、提交采购草稿、查询采购预算是否充足时使用。不适用于库存查询、销售订单。
summary: 采购申请处理：预算校验→物料库存核对→创建采购草稿→审批流程指引
tags: [采购]
version: 1.0.0
---

# 采购申请处理流程

## 前置条件
- 必须先查询采购预算，确认预算充足
- 必须核对物料库存，判断是否已有库存

## 执行步骤

### 步骤1：预算校验
调用 queryPurchaseBudget(dept, month)，获取当月剩余预算。
如果申请金额超过剩余预算的 80%，需提示用户预算紧张。
详细规则见 references/budget-rules.md

### 步骤2：库存核对
调用 queryStock(material_id)，查询当前库存。
如果库存 ≥ 申请量，提示用户"库存充足，无需采购"。
详细判断标准见 references/stock-thresholds.md

### 步骤3：创建采购草稿
调用 createPurchaseDraft(data)，生成草稿。
草稿字段规范见 references/draft-fields.md

## 注意事项
- 金额超过 5 万需部门经理审批，超过 20 万需总监审批
- 完整审批规则见 references/approval-matrix.md

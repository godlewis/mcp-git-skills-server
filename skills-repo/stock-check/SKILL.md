---
name: 库存检查与预警
description: 当用户查询库存数量、判断是否低于安全库存线、生成库存预警报告时使用。不适用于采购申请创建。
summary: 查询实时库存、对比安全库存线、生成预警清单
---

# 库存检查与预警流程

## 执行步骤

### 步骤1：查询实时库存
调用 queryStock(material_id) 或 queryStockByWarehouse(warehouse_id)，获取当前可用库存。

### 步骤2：对比安全库存线
调用 getSafetyStock(material_id)，获取安全库存阈值。
判断标准详见 references/safety-stock.md

### 步骤3：生成预警报告
对低于安全库存线的物料，输出清单：物料编码、当前库存、安全库存、缺口数量、建议补货量。

## 注意事项
- 预警报告默认只包含"严重缺货"和"一般缺货"两档，正常库存不需要输出。
- 本技能不适用于创建采购申请；如用户有采购意图，引导使用 purchase-apply 技能。

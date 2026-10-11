# 安全库存判断标准

- 安全库存线 `safetyStock` 由计划系统按历史消耗自动计算，每日更新。
- 库存档位：
  - `availableStock < safetyStock × 0.5`：**严重缺货**，需立即建议补货并通知采购负责人。
  - `safetyStock × 0.5 ≤ availableStock < safetyStock`：**一般缺货**，纳入预警清单。
  - `availableStock ≥ safetyStock`：正常，不输出。
- 建议补货量 = `safetyStock × 2 - availableStock`，向上取整到包装规格的整数倍。

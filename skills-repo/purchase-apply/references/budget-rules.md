# 采购预算校验规则

1. 查询当月剩余预算：`queryPurchaseBudget(dept, month)`，返回 `remainingBudget`（单位：元）。
2. 申请金额 `amount` 的判断标准：
   - `amount ≤ remainingBudget`：预算充足，继续下一步。
   - `amount > remainingBudget × 0.8`：预算紧张，必须向用户提示"当前申请已占用本月剩余预算的 80% 以上"。
   - `amount > remainingBudget`：预算不足，终止流程并提示用户走预算追加流程。
3. 跨月申请（如下月到货）按当前月预算校验，不做预扣。
4. 多个物料合并为一张申请时，`amount` 为所有物料金额之和。

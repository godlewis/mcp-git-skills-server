# 采购草稿字段规范

| 字段 | 必填 | 说明 |
|---|---|---|
| material_id | 是 | 物料编码，需与主数据系统一致 |
| amount | 是 | 采购金额（元），保留两位小数 |
| quantity | 是 | 采购数量 |
| dept | 是 | 申请部门编码 |
| reason | 是 | 采购原因，不少于 10 个字符 |
| expected_date | 否 | 期望到货日期，格式 YYYY-MM-DD |

调用 `createPurchaseDraft(data)` 前必须完成字段校验，任一必填字段缺失时不得提交。

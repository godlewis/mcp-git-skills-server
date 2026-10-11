# 库存核对判断标准

- `queryStock(material_id)` 返回 `availableStock`（可用库存，不含已占用）。
- 判断标准：
  - `availableStock ≥ applyAmount`：库存充足，提示用户"库存充足，无需采购"，流程终止。
  - `availableStock < applyAmount`：按差额 `applyAmount - availableStock` 生成采购建议量。
- 在途库存（`inTransitStock`）不计入可用库存，但需要在提示中说明预计到货时间。

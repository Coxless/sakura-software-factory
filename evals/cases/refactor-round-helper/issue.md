丸めの処理を共通の関数にまとめる
`src/stock.ts` に、小数第2位までに丸める処理（`Math.round(x * 100) / 100`）が2か所に重複しています。

- `src/math.ts` を作り、`roundTo(value: number, digits: number): number`（`value` を小数第 `digits` 位までに四捨五入する）を export してください
- `src/stock.ts` の2か所を `roundTo` を使う形に置き換えてください
- `totalValue`・`averageQuantity` の挙動と、`src/index.ts` の公開 API は変えないでください

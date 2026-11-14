# inventory

在庫の数量と金額を扱う小さなライブラリ。

## API

### `formatPrice(yen: number): string`

円の金額を「1,234円」の形にします。負の値は先頭に「-」を付け、小数は四捨五入します。数でない値（`NaN`・`Infinity`）は `RangeError` を投げます。

```ts
formatPrice(1234567); // "1,234,567円"
```

### `parseQuantity(text: string): number`

数量の文字列を数にします。前後の空白は許し、1 以上の整数だけを受け付けます。それ以外は `RangeError` を投げます。

```ts
parseQuantity(" 3 "); // 3
```

### `totalValue(items: StockItem[]): number`

在庫の金額（数量 × 単価）の合計を、小数第2位まで返します。

```ts
totalValue([{ name: "ねじ", quantity: 3, unitPrice: 10.5 }]); // 31.5
```

### `averageQuantity(items: StockItem[]): number`

1品目あたりの平均の数量を、小数第2位まで返します。品目がなければ 0 です。

```ts
averageQuantity([]); // 0
```

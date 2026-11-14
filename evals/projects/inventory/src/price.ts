/** 円の金額を「1,234円」の形にする。負の値は先頭に「-」を付ける。小数は四捨五入する */
export function formatPrice(yen: number): string {
  if (!Number.isFinite(yen)) throw new RangeError(`金額が数ではありません: ${yen}`);
  const rounded = Math.round(Math.abs(yen));
  const digits = String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${yen < 0 && rounded !== 0 ? "-" : ""}${digits}円`;
}

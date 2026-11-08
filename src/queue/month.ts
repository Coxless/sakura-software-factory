export interface MonthRange {
  /** YYYY-MM */
  key: string;
  /** 月初（UTC ミリ秒、含む） */
  start: number;
  /** 翌月初（UTC ミリ秒、含まない） */
  end: number;
}

function zonedParts(epochMs: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(epochMs);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** `timeZone` での壁時計の時刻（年・月・日 0:00）を UTC ミリ秒に直す */
function zonedMidnightToEpoch(year: number, month: number, timeZone: string): number {
  const wallAsUtc = Date.UTC(year, month - 1, 1);
  // 1回目の推定で得たオフセットを、その時刻のオフセットで補正する（夏時間の境目に対応）
  let guess = wallAsUtc;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(guess, timeZone);
    const shownAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess = wallAsUtc - (shownAsUtc - guess);
  }
  return guess;
}

/** `now` が `timeZone` で属する月の範囲 */
export function monthRange(now: number, timeZone: string): MonthRange {
  const { year, month } = zonedParts(now, timeZone);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    key: `${year}-${String(month).padStart(2, "0")}`,
    start: zonedMidnightToEpoch(year, month, timeZone),
    end: zonedMidnightToEpoch(nextYear, nextMonth, timeZone),
  };
}

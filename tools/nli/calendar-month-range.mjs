const START = String.raw`(?<![\p{L}\p{N}_.,]|[+\p{Pd}−]\s*)`;
// Leave whitespace-separated Korean prose untouched for lexical and quantity checks.
const END = String.raw`(?=$|[\r\n;!?。)\]]|[.,](?:\s|$)|[ \t]+(?:[)\]]|[가-힣]{2}))`;
const DOTTED = String.raw`\d{4}\.\d{1,2}\s*[~-]\s*\d{4}\.\d{1,2}`;
const KOREAN = String.raw`\d{4}년[ \t]*\d{1,2}월[ \t]*(?:부터[ \t]*(?:\d{4}년[ \t]*)?\d{1,2}월[ \t]*까지|[~-][ \t]*(?:\d{4}년[ \t]*)?\d{1,2}월(?:[ \t]*까지)?)`;
const RANGE = new RegExp(`${START}(?:${DOTTED}|${KOREAN})${END}`, "uy");
const YEAR_MONTH = String.raw`\d{4}(?:\.\p{N}+|년[ \t]*\p{N}+월)`;
const PREFIX = String.raw`(?:[+\p{Pd}−/⁄∕]\s*|[\p{N}.,]+\s*[/⁄∕]\s*)*`;
const CONNECTORS = String.raw`(?:\s*(?:[~\p{Pd}−]|부터))+\s*`;
// Own chains before validation, including invalid months and fractional prefixes.
const ATOM = new RegExp(`${PREFIX}${YEAR_MONTH}(?:${CONNECTORS}(?:${YEAR_MONTH}|\\p{N}+월)(?:[ \\t]*까지)?)+`, "gu");

export function extractCalendarMonthRanges(value) {
  const ranges = [];
  const normalized = typeof value === "string" ? value.normalize("NFKC").toLowerCase().trim() : "";
  const text = normalized.replace(ATOM, (range, offset) => {
    RANGE.lastIndex = offset;
    const match = RANGE.exec(normalized);
    if (!match || match[0].length !== range.length) {
      ranges.push({ valid: false, number: range, unit: "calendar-month-range" });
      return " ";
    }
    const parts = range.match(/\d+/gu);
    const [startYear, startMonth] = parts;
    const endYear = parts.length === 4 ? parts[2] : startYear;
    const endMonth = parts.at(-1);
    const start = `${startYear}.${startMonth.padStart(2, "0")}`;
    const end = `${endYear}.${endMonth.padStart(2, "0")}`;
    const valid = Number(startMonth) >= 1 && Number(startMonth) <= 12 &&
      Number(endMonth) >= 1 && Number(endMonth) <= 12 && start <= end;
    // Invalid month/order atoms still own their digits; never retry them as scalars.
    ranges.push({ valid, number: `${start}~${end}`, unit: "calendar-month-range" });
    return " ";
  });
  return { text, ranges };
}

// SEC-13: spreadsheet programs evaluate a cell that starts with = + - @ (or a tab/CR before one),
// so exported text is prefixed with ' to stay plain text. Plain numbers keep their sign.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

export function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  const safe = FORMULA_PREFIX.test(text) && !PLAIN_NUMBER.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

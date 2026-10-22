// SEC-13: spreadsheet programs evaluate a cell that starts with = + - @ (or a tab/CR before one),
// so exported text from employees, devices or audit rows is prefixed with ' to stay plain text.
// Plain numbers (also as text) are left alone so negative values keep their meaning.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

export function neutralizeCsvFormula(text: string) {
  return FORMULA_PREFIX.test(text) && !PLAIN_NUMBER.test(text) ? `'${text}` : text;
}

export function quoteCsvCell(text: string) {
  return `"${neutralizeCsvFormula(text).replaceAll('"', '""')}"`;
}

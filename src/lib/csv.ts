// Exports in Turkish Excel format (ARCHITECTURE → Reports and exports). Cells arrive already
// formatted (Turkish numbers, DD.MM.YYYY dates); this module only lays them out.

/** A table as display text: one header row, then the rows in the order shown. */
export type Grid = { headers: string[]; rows: string[][] };

const BOM = "﻿";
const LINE = "\r\n";
const NEGATIVE_NUMBER = /^-[\d.,]+$/;

/** Text Excel would run as a formula (=, +, @, -, tab, CR first) is kept as text with a leading apostrophe. */
function guardFormula(cell: string): string {
  if (/^[=+@\t\r]/.test(cell) || (cell.startsWith("-") && !NEGATIVE_NUMBER.test(cell))) return `'${cell}`;
  return cell;
}

function csvCell(cell: string): string {
  const safe = guardFormula(cell);
  return /[;"\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** UTF-8 with BOM, `;` between cells, CRLF lines: opens directly in Excel with a Turkish locale. */
export function toCsv(grid: Grid): string {
  return BOM + [grid.headers, ...grid.rows].map((row) => row.map(csvCell).join(";") + LINE).join("");
}

/** Tab-separated text for the clipboard, to paste into Excel. */
export function toTsv(grid: Grid): string {
  return [grid.headers, ...grid.rows].map((row) => row.map((cell) => guardFormula(cell.replace(/\r\n|[\t\r\n]/g, " "))).join("\t") + LINE).join("");
}

/** `all-bls`, `2026-10-31` → `all-bls-2026-10-31.csv` */
export function exportFileName(base: string, date: string): string {
  return `${base}-${date}.csv`;
}

/** Neutralize formula injection prefixes and escape quotes per RFC 4180. */
export function sanitizeCsvCell(value: string | number | boolean | null | undefined): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(raw) ? "'" + raw : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function buildSafeCsv(headers: string[], rows: (string | number | boolean | null | undefined)[][]): string {
  return [
    headers.map(sanitizeCsvCell).join(","),
    ...rows.map((row) => row.map(sanitizeCsvCell).join(",")),
  ].join("\n");
}

export function downloadSafeCsv(filename: string, headers: string[], rows: (string | number | boolean | null | undefined)[][]): void {
  const csv = buildSafeCsv(headers, rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

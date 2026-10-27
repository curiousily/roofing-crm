const COUNT = new Intl.NumberFormat("en-US");
const DECIMAL = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const DATE_TIME = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});
const DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const BYTE_UNITS = ["B", "KB", "MB", "GB"];
const BYTES_PER_UNIT = 1024;
const RUN_ID = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const CID_HEAD = 10;
const CID_TAIL = 6;
const PERCENT = 100;

export function formatCount(value: number | undefined): string {
  return value === undefined ? "–" : COUNT.format(value);
}

export function formatPercent(part: number, whole: number): string {
  return whole === 0 ? "–" : `${DECIMAL.format((part / whole) * PERCENT)}%`;
}

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= BYTES_PER_UNIT && unit < BYTE_UNITS.length - 1) {
    value /= BYTES_PER_UNIT;
    unit += 1;
  }
  return `${unit === 0 ? value : DECIMAL.format(value)} ${BYTE_UNITS[unit]}`;
}

export function runIdDate(runId: string): Date | undefined {
  const parts = RUN_ID.exec(runId);
  if (!parts) return undefined;
  const [, year, month, day, hour, minute, second] = parts;
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
}

export function formatDateTime(value: string | Date | undefined): string {
  const date = typeof value === "string" ? (runIdDate(value) ?? new Date(value)) : value;
  return date && !Number.isNaN(date.getTime()) ? `${DATE_TIME.format(date)} UTC` : "–";
}

export function formatDate(value: string | undefined): string {
  const date = value ? new Date(value) : undefined;
  return date && !Number.isNaN(date.getTime()) ? DATE.format(date) : "–";
}

export function shortCid(cid: string): string {
  return cid.length > CID_HEAD + CID_TAIL
    ? `${cid.slice(0, CID_HEAD)}…${cid.slice(-CID_TAIL)}`
    : cid;
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number")
    return Number.isInteger(value) ? COUNT.format(value) : DECIMAL.format(value);
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

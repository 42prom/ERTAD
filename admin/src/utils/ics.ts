function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\n|\r/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function formatIcsUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid ISO date for calendar export");
  }
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function buildEventIcs(event: {
  id: string;
  title: string;
  description?: string;
  location?: string;
  startsAt: string;
  endsAt: string;
}): string {
  const uid = `${event.id.replace(/[^a-zA-Z0-9-]/g, "")}@ertad.local`;
  const stamp = formatIcsUtc(new Date().toISOString());
  const start = formatIcsUtc(event.startsAt);
  const end = formatIcsUtc(event.endsAt);

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ERTAD//Events Console//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${escapeIcsText(event.title)}`,
  ];
  if (event.description) {
    lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  }
  if (event.location) {
    lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

export function downloadEventIcs(event: {
  id: string;
  title: string;
  description?: string;
  location?: string;
  startsAt: string;
  endsAt: string;
}): void {
  const content = buildEventIcs(event);
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `ertad-event-${event.id.slice(0, 8)}.ics`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}


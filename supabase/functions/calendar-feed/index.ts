// Wellness From Within portal: a private calendar feed for Dawn's Apple Calendar (iCal), Google Calendar or Outlook.
// Subscribe to:  webcal://tvdnxiztylhobfbhywxk.supabase.co/functions/v1/calendar-feed?key=<calKey>
// The key is made in the portal (Settings → Calendar) and stored in settings/practice.calKey; a wrong key gets nothing.
// Shows: every booked appointment (scans, consults, follow-ups, imprints), with the Zoom link,
//        and "Needs a scan date" (form sent or website order, scan not booked yet) as an all-day reminder.
// "Verify JWT" must be OFF for this function (calendar apps can't sign in); the key is the protection.
import { createClient } from "npm:@supabase/supabase-js@2";

type Rec = Record<string, any>;
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const TYPES: Rec = { scan: "Qest4 scan", consult: "Consult call", qfu: "Qest4 follow-up", imprint: "Remote imprint" };
const isDay = (x: any) => /^\d{4}-\d{2}-\d{2}$/.test(x || "");
const esc = (s: any) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const fold = (line: string) => { const out: string[] = []; let s = line; while (s.length > 73) { out.push(s.slice(0, 73)); s = " " + s.slice(73); } out.push(s); return out.join("\r\n"); };
const ymd = (d: string) => d.replace(/-/g, "");
const addDay = (d: string, n = 1) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
// local New York date + time → UTC "YYYYMMDDTHHMMSSZ"
function nyToUtc(date: string, time: string, plusMin = 0) {
  const [h, m] = time.split(":").map(Number);
  const guess = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h, m);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asNy = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  const utc = guess + (guess - asNy) + plusMin * 60000;
  return new Date(utc).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
const nameOf = (c: Rec) => String(c.name || c.intake?.fullName || c.qest?.fullName || c.followup?.fullName || c.email || c.intake?.email || "Client").trim();

Deno.serve(async (req) => {
  const key = new URL(req.url).searchParams.get("key") || "";
  const { data: srow } = await db.from("docs").select("data").eq("path", "settings/practice").maybeSingle();
  const want = String(srow?.data?.calKey || "");
  if (!want || key.length < 20 || key !== want) return new Response("Not found", { status: 404 });

  const { data: rows } = await db.from("docs").select("id,data,updated_at").eq("parent", "clients");
  const now = new Date(), stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const from = new Date(now.getTime() - 60 * 864e5).toISOString().slice(0, 10);
  const L: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Wellness From Within//Client portal//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Wellness From Within", "X-WR-TIMEZONE:America/New_York", "REFRESH-INTERVAL;VALUE=DURATION:PT15M", "X-PUBLISHED-TTL:PT15M"];
  // SEQUENCE + LAST-MODIFIED change whenever an event's details change, so calendar apps replace their copy
  const hash = (t: string) => { let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return h >>> 0; };
  let mod = stamp, seqNow = 0;
  const ev = (uid: string, start: string[], summary: string, desc: string, url = "") => {
    const seq = seqNow; void hash;
    L.push("BEGIN:VEVENT", `UID:${uid}@portal.dawnspain.com`, `DTSTAMP:${stamp}`, `LAST-MODIFIED:${mod}`, `SEQUENCE:${seq}`, ...start, `SUMMARY:${esc(summary)}`);
    if (desc) L.push(`DESCRIPTION:${esc(desc)}`);
    if (url) L.push(`URL:${url}`);
    L.push("END:VEVENT");
  };
  for (const r of rows || []) {
    const c: Rec = r.data || {}, nm = nameOf(c);
    seqNow = r.updated_at ? Math.floor(Date.parse(r.updated_at) / 60000) : 0;
    mod = r.updated_at ? new Date(r.updated_at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "") : stamp;
    for (const a of (Array.isArray(c.appointments) ? c.appointments : [])) {
      if (!isDay(a.date) || a.date < from) continue;
      const zoom = /zoom|video/i.test(a.how || "") ? (a.zoomUrl || srow?.data?.zoomUrl || "") : "";
      const label = (TYPES[a.type] || "Appointment") + (a.type === "scan" && a.how ? ` + ${/phone/i.test(a.how) ? "phone" : "Zoom"} consult` : "")
        + (a.type === "scan" ? (a.delivery === "ship" ? " + ship treatment" : a.delivery === "none" ? "" : " + imprint") : "")
        + (a.type !== "scan" && a.how ? ` (${/video/i.test(a.how) ? "Zoom" : a.how})` : "");
      const desc = [zoom ? `Join Zoom: ${zoom}` : "", a.delivery === "ship" && a.type === "scan" ? `Ship to:\n${a.shipTo || ""}` : "", a.note ? `Note: ${a.note}` : "",
        `Open in the portal: https://portal.dawnspain.com/`].filter(Boolean).join("\n\n");
      const start = /^\d{2}:\d{2}$/.test(a.time || "")
        ? [`DTSTART:${nyToUtc(a.date, a.time)}`, `DTEND:${nyToUtc(a.date, a.time, +a.mins || (a.type === "scan" ? 60 : 60))}`]
        : [`DTSTART;VALUE=DATE:${ymd(a.date)}`, `DTEND;VALUE=DATE:${ymd(addDay(a.date))}`];
      ev(`appt-${r.id}-${a.id}`, start, `${nm} · ${label}`, desc, zoom);
    }
    const n = c.scanToSchedule;
    if (n && !(Array.isArray(c.appointments) && c.appointments.some((a: Rec) => a.type === "scan" && a.date >= (n.orderedAt || "")))) {
      const by = isDay(n.by) ? n.by : addDay(new Date().toISOString().slice(0, 10), 7);
      const how = n.delivery === "ship" ? "shipped treatment" : n.delivery === "none" ? "reports only" : n.delivery === "imprint" ? "remote imprint" : "";
      ev(`need-${r.id}-${n.orderedAt || ""}`, [`DTSTART;VALUE=DATE:${ymd(by)}`, `DTEND;VALUE=DATE:${ymd(addDay(by))}`],
        `Schedule scan: ${nm}${n.zoom === "yes" ? " (with Zoom)" : ""}`,
        [`${n.source === "form" ? "Qest4 Scan Intake sent" : "Ordered"} ${n.orderedAt || ""}. Scan by ${by}.`, how ? `Treatment: ${how}` : "", "Pick a scan date in the portal: https://portal.dawnspain.com/"].filter(Boolean).join("\n"));
    }
  }
  L.push("END:VCALENDAR");
  return new Response(L.map(fold).join("\r\n") + "\r\n", { headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-cache, max-age=0" } });
});

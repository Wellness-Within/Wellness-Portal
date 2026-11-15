// Wellness From Within portal: automatic client emails from portal@dawnspain.com (replies go to Dawn's iCloud).
//   {"path":"clients/<id>/files/<f>"}  → "Your reports are ready" (when Dawn shares a report; once per client per 30 min)
//   {"path":"clients/<id>/plans/<p>"}  → "Your treatment plan is ready" (when Dawn shares a plan; once per plan)
//   {"sweep":true}                     → daily: scan reminders (week before, and the day the drops finish)
// Called by the database (client-mail.sql). Everything is checked against the database and marked as sent,
// so calling it again, or from anywhere else, never sends anything twice or sends anything that isn't due.
// Each kind can be switched off in the portal: Settings → Automatic emails.
// Secrets used: SMTP_USER, SMTP_PASS (already set for message emails).
import nodemailer from "npm:nodemailer@6.9.16";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const mail = nodemailer.createTransport({ host: "smtp.hostinger.com", port: 465, secure: true, auth: { user: Deno.env.get("SMTP_USER"), pass: Deno.env.get("SMTP_PASS") } });
const REPLY_TO = "wellnessfromwithin@icloud.com";
const PHONE = "252-626-4104";
const SIGN = `With warmth,\n\nDawn Spain, PHom\nWellness From Within\nA Roaring Fork Homeopathy Associate\n${PHONE}\nwww.dawnspain.com`;
type Rec = Record<string, any>;
const emailOf = (d: Rec) => d?.email || d?.intake?.email || d?.qest?.email || d?.followup?.email || "";
const nameOf = (d: Rec) => d?.intake?.nickname || d?.intake?.preferredName || d?.intake?.fullName || d?.qest?.fullName || d?.followup?.fullName || d?.name || "";
const nyToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const dayDiff = (a: string, b: string) => Math.round((Date.parse(a + "T12:00:00Z") - Date.parse(b + "T12:00:00Z")) / 864e5);
const fmtDate = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const get = async (path: string) => (await db.from("docs").select("data").eq("path", path).maybeSingle()).data?.data as Rec | undefined;
const merge = (path: string, data: Rec) => db.rpc("doc_merge", { p_path: path, p_data: data });

async function who(cid: string) {
  const rec = (await get("clients/" + cid)) || {};
  let to = emailOf(rec); const family = cid.includes("~");
  if (!to && family) to = emailOf((await get("clients/" + cid.split("~")[0])) || {});
  const first = String(nameOf(rec)).trim().split(/\s+/)[0] || "";
  let siblings = family;
  if (!family && to) { const { data } = await db.from("docs").select("id").eq("parent", "clients").like("id", cid + "~%").limit(1); siblings = !!(data && data.length); }
  return { rec, to: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) ? to : "", first, named: siblings && !!first };
}
async function send(cid: string, rec: Rec, to: string, subject: string, text: string, kind: string) {
  await mail.sendMail({ from: `"Dawn Spain, Wellness From Within" <${Deno.env.get("SMTP_USER")}>`, replyTo: REPLY_TO, to, subject, text });
  const now = new Date().toISOString();
  const log = [{ at: now, subject, kind }, ...(rec.emailLog || [])].slice(0, 50);
  await merge("clients/" + cid, { emailLog: log });
  return now;
}
const signin = (to: string, named: boolean, first: string) => `Sign in with this email address (${to}).${named ? ` Then choose ${first} at the top.` : ""}`;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  let body: Rec = {}; try { body = await req.json(); } catch { /* empty */ }
  const settings = (await get("settings/practice")) || {};
  const on = (k: string) => (settings.autoMail || {})[k] !== false;

  // ---- reports / plan shared ----
  const pm = /^clients\/([A-Za-z0-9~_-]{1,80})\/(files|plans)\/[A-Za-z0-9_-]{1,80}$/.exec(String(body.path || ""));
  if (pm) {
    const [, cid, kind] = pm;
    if (!on(kind === "files" ? "reports" : "plans")) return Response.json({ sent: false, why: "switched off" });
    const doc = await get(body.path); if (!doc || doc.status !== "shared" || doc.emailedAt) return Response.json({ sent: false, why: "not newly shared" });
    const { rec, to, first, named } = await who(cid); if (!to) return Response.json({ sent: false, why: "no email" });
    if (kind === "files" && rec.reportsEmailedAt && Date.now() - Date.parse(rec.reportsEmailedAt) < 30 * 60_000) { await merge(body.path, { emailedAt: rec.reportsEmailedAt }); return Response.json({ sent: false, why: "already emailed about reports just now" }); }
    const hi = named ? "Hi there," : `Hi ${first || "there"},`, whose = named ? `${first}'s` : "Your";
    const subject = kind === "files" ? `${whose} Qest4 scan reports are ready` : `${whose} treatment plan is ready`;
    const text = kind === "files"
      ? `${hi}\n\n${whose} Qest4 scan and Wellness Summary reports are complete, and I've added them to your client portal under "My reports":\nhttps://portal.dawnspain.com\n\n${signin(to, named, first)}\n\nTake your time reading through them. If anything raises a question or you'd like to talk it over, just reply to this email.\n\n${SIGN}`
      : `${hi}\n\n${whose} treatment plan is ready in your client portal under "Treatment plans", with how often to take each remedy and for how long:\nhttps://portal.dawnspain.com\n\n${signin(to, named, first)}\n\nIf anything is unclear, or you notice changes you'd like to share as you go, just reply to this email.\n\n${SIGN}`;
    try { const at = await send(cid, rec, to, subject, text, kind === "files" ? "files" : "plan");
      await merge(body.path, { emailedAt: at }); if (kind === "files") await merge("clients/" + cid, { reportsEmailedAt: at });
    } catch (e) { console.error("send failed", (e as Error)?.message); return Response.json({ sent: false, why: "send failed" }, { status: 502 }); }
    return Response.json({ sent: true });
  }

  // ---- daily sweep: scan reminders ----
  if (body.sweep) {
    if (!on("reminders")) return Response.json({ ok: true, why: "switched off" });
    const t = nyToday(); let sent = 0;
    const { data: rows } = await db.from("docs").select("id,data").eq("parent", "clients");
    for (const r of rows || []) {
      const c: Rec = r.data || {}, nv = c.nextVisit;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(nv || "")) continue;
      const d = dayDiff(nv, t), done = (c.reminders || {})[nv] || {};
      const kind = d <= 0 && d >= -2 && !done.day ? "day" : d >= 1 && d <= 7 && !done.week && !done.day ? "week" : "";
      if (!kind) continue;
      const { to, first, named } = await who(r.id); if (!to) continue;
      const formIn = (() => { if (!c.qestSubmittedAt) return false; const cut = new Date(nv + "T12:00:00Z"); cut.setUTCDate(cut.getUTCDate() - 14); return c.qestSubmittedAt >= cut.toISOString(); })();
      const hi = named ? "Hi there," : `Hi ${first || "there"},`, your = named ? `${first}'s` : "your", Your = named ? `${first}'s` : "Your";
      const link = "https://portal.dawnspain.com/#nextscan";
      const how = `${signin(to, named, first)} Your contact details carry over, so you'll only answer the questions about how ${named ? `${first} is` : "you're"} feeling now.`;
      const reach = `If you need to change the date or have any questions, just reply to this email or text me at ${PHONE}.`;
      const subject = kind === "week" ? `${Your} next Qest4 scan is coming up` : `Time for ${your} next Qest4 scan`;
      const text = kind === "week"
        ? `${hi}\n\nIt's almost time for ${your} next Qest4 scan, on ${fmtDate(nv)}, when ${named ? "the" : "your"} current drops are due to finish.\n\n${formIn ? `Thank you for already sending ${named ? "the" : "your"} pre-scan form. I have everything I need.` : `Before the scan, please fill out a new pre-scan form in the client portal so I can see how ${named ? `${first} is` : "you're"} doing since the last one:\n${link}\n\n${how}`}\n\n${reach}\n\n${SIGN}`
        : `${hi}\n\n${Your} drops are finished, which means it's time for ${your} next Qest4 scan.\n\n${formIn ? `Thank you for sending ${named ? "the" : "your"} pre-scan form. I have everything I need for the scan.` : `If you haven't yet, please fill out the pre-scan form in the client portal before the scan:\n${link}\n\n${how}`}\n\n${reach}\n\n${SIGN}`;
      try { const at = await send(r.id, c, to, subject, text, kind);
        const all = { ...(c.reminders || {}) }; all[nv] = { ...(all[nv] || {}), [kind]: at };
        await merge("clients/" + r.id, { reminders: all }); sent++;
      } catch (e) { console.error("reminder failed", r.id, (e as Error)?.message); }
    }
    return Response.json({ ok: true, sent });
  }
  return new Response("bad request", { status: 400 });
});

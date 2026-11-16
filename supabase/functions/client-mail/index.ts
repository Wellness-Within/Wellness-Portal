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
  const base = cid.split("~")[0];
  let to = emailOf(rec);
  if (!to && cid.includes("~")) to = emailOf((await get("clients/" + base)) || {});
  const first = String(nameOf(rec)).trim().split(/\s+/)[0] || "";
  // Family account: who is the person behind the sign-in (the account holder)?
  const { data: rows } = await db.from("docs").select("id,data").eq("parent", "clients").or(`id.eq.${base},id.like.${base}~*`);
  const isShell = (r: Rec) => !r.id.includes("~") && (rows || []).some((x: Rec) => x.id.startsWith(r.id + "~")) && !(r.data?.intakeSubmittedAt || r.data?.qestSubmittedAt || r.data?.followupSubmittedAt || r.data?.name || r.data?.nextVisit || (r.data?.appointments || []).length);
  const people = (rows || []).filter((r: Rec) => !isShell(r));
  const fam = people.length > 1;
  let holder = people.find((r: Rec) => r.data?.accountHolder)?.id || (people.some((r: Rec) => r.id === base) ? base : "");
  if (fam && !holder) { const local = String(to).toLowerCase().split("@")[0].replace(/[^a-z]/g, ""); const m = people.map((r: Rec) => ({ id: r.id, f: String(nameOf(r.data)).trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, "") })).filter((o) => o.f.length >= 3 && local.includes(o.f)).sort((a, b) => b.f.length - a.f.length)[0]; holder = m ? m.id : ""; }
  const hRec = people.find((r: Rec) => r.id === holder);
  const greet = hRec ? String(nameOf(hRec.data)).trim().split(/\s+/)[0] : "";
  return { rec, to: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) ? to : "", first, named: fam && holder !== cid && !!first, greet, pick: fam };
}
async function send(cid: string, rec: Rec, to: string, subject: string, text: string, kind: string) {
  await mail.sendMail({ from: `"Dawn Spain, Wellness From Within" <${Deno.env.get("SMTP_USER")}>`, replyTo: REPLY_TO, to, subject, text });
  const now = new Date().toISOString();
  const log = [{ at: now, subject, kind }, ...(rec.emailLog || [])].slice(0, 50);
  await merge("clients/" + cid, { emailLog: log });
  return now;
}
const signin = (to: string, named: boolean, first: string) => `Sign in with this email address (${to}).${named ? ` Then choose ${first} at the top.` : ""}`;

function reminderZoom(o: Rec, nm: string, hi: string){
  const subject = o.kind==="week" ? (o.named?`${nm}'s next scan and consult are coming up`:"Your next scan and consult are coming up")
                                  : (o.named?`Checking in: time for ${nm}'s next scan and consult`:"Checking in: time for your next scan and consult");
  const open = o.kind==="week"
    ? (o.named ? `I hope you're all doing well! ${nm}'s drops should be finishing up in about a week${o.whenLong?`, around ${o.whenLong}`:""}, so I wanted to reach out a little ahead of time ${o.booked?"before":"to find a good time for"} our next Zoom consult and the Qest4 scan.`
               : `I hope things have been going well for you! Your drops should be finishing up in about a week${o.whenLong?`, around ${o.whenLong}`:""}, so I wanted to reach out a little ahead of time ${o.booked?"before":"to find a good time for"} our next Zoom consult and your Qest4 scan.`)
    : (o.named ? `I hope you're all doing well! ${nm}'s drops should be finishing up about now, which makes this a lovely time for a new Qest4 scan and our Zoom consult. I always look forward to catching up, hearing how things have been, and talking through what's needed next.`
               : `I hope you've been feeling well! Your drops should be finishing up about now, which makes this a lovely time for your next Qest4 scan and our Zoom consult. I always look forward to catching up, hearing how you've been, and talking through what your body needs next.`);
  const sched = o.booked
    ? `I'm looking forward to our Zoom call on ${o.booked}.`
    : `This time, you're welcome to choose what feels right for you: a scan with our Zoom consult, or just the scan on its own.\n\nFor the scan and consult, just reply with a few days and times that work, or if you'd rather pick a time yourself, you can book it here:\n${o.bookUrl}\n\nFor just the scan, simply fill out ${o.named?"the":"your"} pre-scan form and choose “Not this time, just the scan.” I'll take it from there.`;
  const form = o.formIn
    ? `Thank you for already sending ${o.named?"the":"your"} pre-scan form. I have everything I need.`
    : `${o.booked?"Before we meet, please fill out":"Either way, here's where to fill out"} ${o.named?"the":"your"} pre-scan form in your client portal:\n${o.link}\nSign in with this email address (${o.to}).${(o.named||o.pick)?` Then choose ${nm} at the top.`:""} ${o.named?"Details":"Your details"} carry over, so it only takes a few minutes.`;
  const close = `If now isn't the right time, or you have any questions at all, just reply or text me at ${o.phone}. I'm always glad to hear how you're doing.`;
  return { subject, text:`${hi}\n\n${open}\n\n${sched}\n\n${form}\n\n${close}\n\n${o.sign}` };
}
function reminderText(o: Rec){ // o: {kind, first, named, to, whenLong, formIn, link, phone, sign}
  const nm=o.first||"", hi=o.named?`Hi ${o.greet||"there"},`:`Hi ${nm||"there"},`;
  if(o.zoom) return reminderZoom(o, nm, hi);
  const subject = o.kind==="week" ? (o.named?`${nm}'s next Qest4 scan is coming up`:"Your next Qest4 scan is coming up")
                                  : (o.named?`Checking in: time for ${nm}'s next Qest4 scan`:"Checking in: time for your next Qest4 scan");
  const open = o.kind==="week"
    ? (o.named ? `I hope you're all doing well! ${nm}'s drops should be finishing up in about a week${o.whenLong?`, around ${o.whenLong}`:""}, so I wanted to reach out a little ahead of time. That's a great moment for a new Qest4 scan, to see how things have shifted and what's needed next.`
               : `I hope things have been going well for you! Your drops should be finishing up in about a week${o.whenLong?`, around ${o.whenLong}`:""}, so I wanted to reach out a little ahead of time. That's a great moment for your next Qest4 scan, to see how things have shifted and what your body needs next.`)
    : (o.named ? `I hope you're all doing well! ${nm}'s drops should be finishing up about now, which makes this a lovely time for a new Qest4 scan. A fresh scan shows how things have responded since last time, so I can adjust the support to where things are today.`
               : `I hope you've been feeling well! Your drops should be finishing up about now, which makes this a lovely time for your next Qest4 scan. A fresh scan shows how your body has responded since last time, so I can adjust your support to where you are today.`);
  const form = o.formIn
    ? `Thank you for already sending ${o.named?"the":"your"} pre-scan form. I have everything I need, and I'll be in touch soon with ${o.named?"the":"your"} scan date.`
    : `When you're ready, just fill out ${o.named?"the":"your"} pre-scan form in your client portal and I'll take it from there:\n${o.link}\nSign in with this email address (${o.to}).${(o.named||o.pick)?` Then choose ${nm} at the top.`:""} ${o.named?"Details":"Your details"} carry over, so it only takes a few minutes.`;
  const close = `If now isn't the right time, or you have any questions at all, just reply or text me at ${o.phone}. I'm always glad to hear how you're doing.`;
  return { subject, text:`${hi}\n\n${open}\n\n${form}\n\n${close}\n\n${o.sign}` };
}

function reminderGroup(o: Rec){ // o: {kind, people:[{first, holder, formIn, zoom}], greet, to, whenLong, link, phone, sign, bookUrl}
  const nm=(p: Rec)=>p.holder?"you":p.first, list=(a: string[])=>a.length<3?a.join(" and "):a.slice(0,-1).join(", ")+" and "+a[a.length-1];
  const ppl=o.people.slice().sort((a,b)=>(b.holder?1:0)-(a.holder?1:0)), hasHolder=ppl.some(p=>p.holder);
  const who=list(ppl.map(nm)), hi=`Hi ${o.greet||"there"},`;
  const subject = o.kind==="week" ? "Your family's next Qest4 scans are coming up" : "Checking in: time for your family's next Qest4 scans";
  const open = o.kind==="week"
    ? `I hope you're all doing well! The drops for ${who} should be finishing up in about a week${o.whenLong?`, around ${o.whenLong}`:""}, so I wanted to reach out a little ahead of time. That's a great moment for new Qest4 scans, to see how things have shifted and what's needed next.`
    : `I hope you're all doing well! The drops for ${who} should be finishing up about now, which makes this a lovely time for new Qest4 scans. Fresh scans show how everyone has responded since last time, so I can adjust the support to where each of ${hasHolder?"you":"them"} is today.`;
  const zoom = ppl.some(p=>p.zoom) ? `This time, you're welcome to choose what feels right: scans with our Zoom consult, or just the scans on their own. For a Zoom consult, just reply with a few days and times that work, or book it here:\n${o.bookUrl}\nFor just the scans, choose “Not this time, just the scan” on the pre-scan form.\n\n` : "";
  const done=ppl.filter(p=>p.formIn), need=ppl.filter(p=>!p.formIn);
  const form = !need.length ? `Thank you for already sending the pre-scan forms. I have everything I need, and I'll be in touch soon with the scan dates.`
    : `When you're ready, just fill out a pre-scan form for ${list(need.map(p=>p.holder?"yourself":p.first))} in your client portal and I'll take it from there:\n${o.link}\nSign in with this email address (${o.to}), ${need.length===1?`then choose ${need[0].first} at the top. Details carry over, so it only takes a few minutes.`:"then choose each name at the top. Details carry over, so it only takes a few minutes each."}${done.length?` (Thank you, I already have the form for ${list(done.map(p=>p.holder?"you":p.first))}.)`:""}`;
  const close = `If now isn't the right time, or you have any questions at all, just reply or text me at ${o.phone}. I'm always glad to hear how you're doing.`;
  return { subject, text:`${hi}\n\n${open}\n\n${zoom}${form}\n\n${close}\n\n${o.sign}` };
}

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
    const { rec, to, first, named, greet, pick } = await who(cid); if (!to) return Response.json({ sent: false, why: "no email" });
    if (kind === "files" && rec.reportsEmailedAt && Date.now() - Date.parse(rec.reportsEmailedAt) < 30 * 60_000) { await merge(body.path, { emailedAt: rec.reportsEmailedAt }); return Response.json({ sent: false, why: "already emailed about reports just now" }); }
    const hi = named ? `Hi ${greet || "there"},` : `Hi ${first || "there"},`, whose = named ? `${first}'s` : "Your";
    const subject = kind === "files" ? `${whose} Qest4 scan reports are ready` : `${whose} treatment plan is ready`;
    const text = kind === "files"
      ? `${hi}\n\n${whose} Qest4 scan and Wellness Summary reports are complete, and I've added them to your client portal under "My reports":\nhttps://portal.dawnspain.com\n\n${signin(to, named || pick, first)}\n\nTake your time reading through them. If anything raises a question or you'd like to talk it over, just reply to this email.\n\n${SIGN}`
      : `${hi}\n\n${whose} treatment plan is ready in your client portal under "Treatment plans", with how often to take each remedy and for how long:\nhttps://portal.dawnspain.com\n\n${signin(to, named || pick, first)}\n\nIf anything is unclear, or you notice changes you'd like to share as you go, just reply to this email.\n\n${SIGN}`;
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
    // 1. who is due today
    const due: Rec[] = [];
    for (const r of rows || []) {
      const c: Rec = r.data || {}, nv = c.nextVisit;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(nv || "")) continue;
      const d = dayDiff(nv, t), done = (c.reminders || {})[nv] || {};
      const kind = d <= 0 && d >= -2 && !done.day ? "day" : d >= 1 && d <= 7 && !done.week && !done.day ? "week" : "";
      if (!kind) continue;
      const w = await who(r.id); if (!w.to) continue;
      const formIn = (() => { if (!c.qestSubmittedAt) return false; const cut = new Date(nv + "T12:00:00Z"); cut.setUTCDate(cut.getUTCDate() - 14); return c.qestSubmittedAt >= cut.toISOString(); })();
      due.push({ id: r.id, c, nv, kind, formIn, ...w });
    }
    // 2. family members on one sign-in with the same date get one email together
    const groups = new Map<string, Rec[]>();
    for (const x of due) { const k = `${String(x.to).toLowerCase()}|${x.kind}|${x.nv}`; groups.set(k, [...(groups.get(k) || []), x]); }
    for (const g of groups.values()) {
      const x = g[0];
      let subject: string, text: string;
      if (g.length > 1) {
        ({ subject, text } = reminderGroup({ kind: x.kind, people: g.map((y) => ({ first: y.first, holder: y.pick && !y.named, formIn: y.formIn, zoom: !!y.c.zoomClient })), greet: g.find((y) => y.pick && !y.named)?.first || x.greet, to: x.to, whenLong: fmtDate(x.nv), link: "https://portal.dawnspain.com/#nextscan", phone: PHONE, sign: SIGN, bookUrl: "https://book.squareup.com/appointments/288jsx6xinmood/location/LX8779MFYATPH/services/D4EUQUWUAHGGDLNDBUHSQOWO" }));
      } else {
        const c = x.c;
        const bk = (Array.isArray(c.appointments) ? c.appointments : []).filter((a: Rec) => (a.type === "consult" || a.type === "qfu") && a.date >= t).sort((a: Rec, b: Rec) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")))[0];
        const bookedTxt = bk ? `${fmtDate(bk.date)}${bk.time ? " at " + (() => { const [h, m] = String(bk.time).split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"} Eastern`; })() : ""}` : "";
        ({ subject, text } = reminderText({ kind: x.kind, first: x.first, named: x.named, to: x.to, whenLong: fmtDate(x.nv), formIn: x.formIn, link: "https://portal.dawnspain.com/#nextscan", phone: PHONE, sign: SIGN,
          zoom: !!c.zoomClient, greet: x.greet, pick: x.pick, booked: bookedTxt, bookUrl: "https://book.squareup.com/appointments/288jsx6xinmood/location/LX8779MFYATPH/services/D4EUQUWUAHGGDLNDBUHSQOWO" }));
      }
      try {
        const at = await send(x.id, x.c, x.to, subject, text, x.kind);
        for (const y of g) {
          const rec = y.id === x.id ? ((await get("clients/" + y.id)) || y.c) : y.c;
          const all = { ...(rec.reminders || {}) }; all[y.nv] = { ...(all[y.nv] || {}), [y.kind]: at };
          const patch: Rec = { reminders: all };
          if (y.id !== x.id) patch.emailLog = [{ at, subject, kind: y.kind }, ...(rec.emailLog || [])].slice(0, 50);
          await merge("clients/" + y.id, patch); sent++;
        }
      } catch (e) { console.error("reminder failed", x.id, (e as Error)?.message); }
    }
    return Response.json({ ok: true, sent });
  }
  return new Response("bad request", { status: 400 });
});

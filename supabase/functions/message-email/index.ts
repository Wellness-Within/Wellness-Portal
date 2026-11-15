// Wellness From Within portal: email a client each portal message Dawn sends them, with the message in the email.
// Called by the database (auto-email.sql) right after Dawn's message is saved.
//
// Supabase → Edge Functions → Secrets needs:
//   SMTP_USER   the mailbox it sends from, e.g. portal@dawnspain.com
//   SMTP_PASS   that mailbox's password (Dawn types this in herself)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
// Safety: it only emails a message that is from Dawn, was sent in the last few minutes and hasn't been emailed yet,
// so calling it any other way does nothing.
import nodemailer from "npm:nodemailer@6.9.16";
import { createClient } from "npm:@supabase/supabase-js@2";

const REPLY_TO = "wellnessfromwithin@icloud.com";
const PORTAL = "https://portal.dawnspain.com/#messages";
const PHONE = "252-626-4104";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const mail = nodemailer.createTransport({
  host: "smtp.hostinger.com", port: 465, secure: true,
  auth: { user: Deno.env.get("SMTP_USER"), pass: Deno.env.get("SMTP_PASS") },
});

type Rec = Record<string, any>;
const emailOf = (d: Rec) => d?.email || d?.intake?.email || d?.qest?.email || d?.followup?.email || "";
const nameOf = (d: Rec) => d?.intake?.nickname || d?.intake?.preferredName || d?.intake?.fullName || d?.qest?.fullName || d?.followup?.fullName || d?.name || "";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  let path = "";
  try { path = String((await req.json()).path || ""); } catch { /* fall through */ }
  const pm = /^clients\/([A-Za-z0-9~_-]{1,80})\/messages\/[A-Za-z0-9_-]{1,80}$/.exec(path);
  if (!pm) return new Response("bad request", { status: 400 });
  const cid = pm[1];

  const { data: mrow } = await db.from("docs").select("data").eq("path", path).maybeSingle();
  const m: Rec = mrow?.data || {};
  if (m.from !== "dawn" || !m.at || m.emailedAt || Date.now() - Date.parse(m.at) > 10 * 60_000 || !String(m.body || "").trim())
    return Response.json({ sent: false, why: "not a new message from Dawn" });

  const { data: row } = await db.from("docs").select("data").eq("path", "clients/" + cid).maybeSingle();
  const rec: Rec = row?.data || {};
  let to = emailOf(rec);
  const family = cid.includes("~");
  if (!to && family) {
    const { data: b } = await db.from("docs").select("data").eq("path", "clients/" + cid.split("~")[0]).maybeSingle();
    to = emailOf(b?.data || {});
  }
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return Response.json({ sent: false, why: "no email on file" });

  const first = String(nameOf(rec)).trim().split(/\s+/)[0] || "";
  const subject = family && first ? `A message from Dawn about ${first}` : "A message from Dawn";
  const text = `${String(m.body).trim()}

————————————
You can reply to this email, or read and answer in your Wellness From Within client portal:
${PORTAL}
(Sign in with ${to}${family && first ? `, then choose ${first} at the top` : ""}.)

Dawn Spain, PHom · Wellness From Within · ${PHONE} · www.dawnspain.com`;

  try {
    await mail.sendMail({ from: `"Dawn Spain, Wellness From Within" <${Deno.env.get("SMTP_USER")}>`, replyTo: REPLY_TO, to, subject, text });
  } catch (e) {
    console.error("send failed", (e as Error)?.message || e);
    return Response.json({ sent: false, why: "send failed" }, { status: 502 });
  }
  const now = new Date().toISOString();
  const r1 = await db.rpc("doc_merge", { p_path: path, p_data: { emailedAt: now } });
  if (r1.error) console.error("mark failed", r1.error.message);
  const log = [{ at: now, subject, kind: "auto" }, ...(rec.emailLog || [])].slice(0, 50);
  const r2 = await db.rpc("doc_merge", { p_path: "clients/" + cid, p_data: { emailLog: log } });
  if (r2.error) console.error("log failed", r2.error.message);
  return Response.json({ sent: true });
});

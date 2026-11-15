// Wellness From Within portal: email a client when Dawn sends them a portal message.
// Called by the database (auto-email.sql) right after Dawn's message is saved.
// The email never includes the message itself, only that one is waiting.
//
// Supabase → Edge Functions → Secrets needs:
//   SMTP_USER   the mailbox it sends from, e.g. portal@dawnspain.com
//   SMTP_PASS   that mailbox's password (Dawn types this in herself)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
// Safety: it only emails a person whose newest portal message is from Dawn and was sent in the last few minutes,
// and at most once per QUIET_MINUTES, so calling it any other way does nothing.
import nodemailer from "npm:nodemailer@6.9.16";
import { createClient } from "npm:@supabase/supabase-js@2";

const REPLY_TO = "wellnessfromwithin@icloud.com";
const PORTAL = "https://portal.dawnspain.com/#messages";
const PHONE = "252-626-4104";
const QUIET_MINUTES = 30; // at most one "new message" email per person in this window

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
  let cid = "";
  try { cid = String((await req.json()).cid || ""); } catch { /* fall through */ }
  if (!/^[A-Za-z0-9~_-]{1,80}$/.test(cid)) return new Response("bad request", { status: 400 });

  const { data: newest } = await db.from("docs").select("data").eq("parent", `clients/${cid}/messages`).order("updated_at", { ascending: false }).limit(1).maybeSingle();
  const m: Rec = newest?.data || {};
  if (m.from !== "dawn" || !m.at || Date.now() - Date.parse(m.at) > 5 * 60_000) return Response.json({ sent: false, why: "no new message from Dawn" });

  const { data: row } = await db.from("docs").select("data").eq("path", "clients/" + cid).maybeSingle();
  const rec: Rec = row?.data || {};
  let to = emailOf(rec);
  const base = cid.split("~")[0];
  const family = cid.includes("~");
  if (!to && family) {
    const { data: b } = await db.from("docs").select("data").eq("path", "clients/" + base).maybeSingle();
    to = emailOf(b?.data || {});
  }
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return Response.json({ sent: false, why: "no email on file" });

  const last = rec.autoEmailAt ? Date.parse(rec.autoEmailAt) : 0;
  if (last && Date.now() - last < QUIET_MINUTES * 60_000) return Response.json({ sent: false, why: "recently emailed" });

  const first = String(nameOf(rec)).trim().split(/\s+/)[0] || "";
  const hi = family ? "Hi there," : `Hi ${first || "there"},`;
  const about = family && first ? ` about ${first}` : "";
  const subject = "You have a new message from Dawn";
  const text = `${hi}

I've sent you a message${about} in your Wellness From Within client portal. To read it and reply:

${PORTAL}

Sign in with this email address (${to}) and open Messages.${family && first ? ` Then choose ${first} at the top.` : ""}

With warmth,
Dawn Spain, PHom
Wellness From Within
${PHONE}
www.dawnspain.com`;

  try {
    await mail.sendMail({ from: `"Dawn Spain, Wellness From Within" <${Deno.env.get("SMTP_USER")}>`, replyTo: REPLY_TO, to, subject, text });
  } catch (e) {
    console.error("send failed", e?.message || e);
    return Response.json({ sent: false, why: "send failed" }, { status: 502 });
  }
  const now = new Date().toISOString();
  const log = [{ at: now, subject, kind: "auto" }, ...(rec.emailLog || [])].slice(0, 50);
  const { error } = await db.rpc("doc_merge", { p_path: "clients/" + cid, p_data: { autoEmailAt: now, emailLog: log } });
  if (error) console.error("log failed", error.message);
  return Response.json({ sent: true });
});

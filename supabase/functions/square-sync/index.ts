// Wellness From Within portal: Square → portal.
//   booking.created / booking.updated  → a "Consult call" appointment on the client's record (added, moved or removed),
//                                          and "Needs a scan date" so Dawn picks the scan day.
//   payment.created / payment.updated   → when a payment is COMPLETED, it is recorded in the portal:
//                                          on the client's open invoice if one matches, otherwise as a new paid invoice.
//                                          Website (WooCommerce) payments are skipped: woo-order already records those.
// Secrets (Supabase → Edge Functions → Secrets), pasted in by Dawn:
//   SQUARE_TOKEN     Square production access token (read customers, bookings, orders)
//   SQUARE_SIG_KEY   the webhook subscription's signature key
// Safety: unsigned requests are never trusted; their booking or payment is looked up in Square itself.
import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const URL_SELF = "https://tvdnxiztylhobfbhywxk.supabase.co/functions/v1/square-sync";
type Rec = Record<string, any>;
const r2 = (n: any) => Math.round((+n || 0) * 100) / 100;
const lc = (s: any) => String(s || "").trim().toLowerCase();
const emailsOf = (d: Rec) => [d?.email, d?.intake?.email, d?.qest?.email, d?.followup?.email].map(lc).filter(Boolean);
const get = async (path: string) => (await db.from("docs").select("data").eq("path", path).maybeSingle()).data?.data as Rec | undefined;
const save = (path: string, data: Rec) => db.from("docs").upsert({ path, parent: path.slice(0, path.lastIndexOf("/")), id: path.slice(path.lastIndexOf("/") + 1), data, updated_at: new Date().toISOString() });
const merge = (path: string, data: Rec) => db.rpc("doc_merge", { p_path: path, p_data: data });
const ny = (iso: string) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(iso)).map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }; };


// ---------- automatic receipt (same look as the portal's receipt email) ----------
const A = "#087C9C";
const esc = (x: any) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const money = (n: any) => { const v = r2(n); return (v < 0 ? "-" : "") + "$" + Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ","); };
const fmtDate = (d: string) => { if (!d) return ""; const x = new Date(d.length === 10 ? d + "T12:00:00" : d); return isNaN(+x) ? d : x.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); };
const lineAmt = (i: Rec) => i.credit ? 0 : (i.kind === "discount" ? -1 : 1) * Math.abs((+i.qty || 1) * (+i.price || 0));
function invMath(v: Rec) {
  const sub = Math.max(0, r2((v.items || []).reduce((t: number, i: Rec) => t + lineAmt(i), 0)));
  const d = v.discount || {}; const disc = !(+d.value) ? 0 : d.type === "pct" ? r2(sub * (+d.value) / 100) : Math.min(sub, r2(d.value));
  const total = r2(Math.max(0, sub - disc)); const paid = r2((v.payments || []).reduce((t: number, x: Rec) => t + (+x.amount || 0), 0));
  return { sub, disc, total, paid, bal: r2(total - paid) };
}
async function autoReceipt(invId: string, v: Rec, p: Rec) {
  try {
    const settings = (await get("settings/practice")) || {};
    if ((settings.autoMail || {}).receipts === false || !v.clientId) return;
    const rec = (await get("clients/" + v.clientId)) || {};
    let to = emailsOf(rec)[0] || "";
    if (!to && String(v.clientId).includes("~")) to = emailsOf((await get("clients/" + String(v.clientId).split("~")[0])) || {})[0] || "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return;
    const nm = String(rec.intake?.nickname || rec.intake?.preferredName || rec.intake?.fullName || rec.qest?.fullName || rec.name || "").trim().split(/\s+/)[0] || "there";
    const m = invMath(v);
    const td = "padding:9px 6px;border-bottom:1px solid #eee;font-size:14px;vertical-align:top";
    const rows = (v.items || []).map((i: Rec) => `<tr><td style="${td}">${esc(i.desc || "Item")}${(+i.qty || 1) > 1 && i.kind !== "discount" ? `<div style="font-size:12px;color:#777">${esc(i.qty)} × ${esc(money(i.price))}</div>` : ""}</td><td style="${td};color:#555">${esc(i.for || "")}</td><td style="${td};text-align:right;white-space:nowrap${i.kind === "discount" ? ";color:#2e7d4f" : ""}">${i.credit ? "Prepaid" : esc(money(lineAmt(i)))}</td></tr>`).join("");
    const tot = (l: string, a: string, st = "") => `<tr><td colspan="2" style="padding:6px;text-align:right;font-size:14px;${st}">${l}</td><td style="padding:6px;text-align:right;white-space:nowrap;font-size:14px;${st}">${a}</td></tr>`;
    const table = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:6px 0 4px"><tr><td style="padding:6px;border-bottom:2px solid #ddd;font-size:12px;color:#777">Item</td><td style="padding:6px;border-bottom:2px solid #ddd;font-size:12px;color:#777">For</td><td style="padding:6px;border-bottom:2px solid #ddd;font-size:12px;color:#777;text-align:right">Amount</td></tr>${rows}
      ${m.disc ? tot("Subtotal", money(m.sub), "color:#555") + tot(`${esc(v.discount?.label || "Discount")}${v.discount?.type === "pct" ? ` (${esc(v.discount.value)}%)` : ""}`, "-" + money(m.disc), "color:#2e7d4f") : ""}
      ${tot("Total", money(m.total), "font-weight:bold")}
      ${(v.payments || []).map((x: Rec) => tot(`Paid ${esc(fmtDate(x.date))}${x.method ? ` · ${esc(String(x.method).split(" · ")[0])}` : ""}`, "-" + money(x.amount), "color:#555")).join("")}
      ${tot("Balance due", money(m.bal), "font-weight:bold;font-size:16px;border-top:2px solid #ddd")}</table>`;
    const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f2ee"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2ee"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e3dfd8;border-radius:10px;font-family:Helvetica,Arial,sans-serif;color:#2b2b2b">
  <tr><td style="padding:22px 28px;border-bottom:3px solid ${A}"><div style="font-family:Georgia,serif;font-size:22px;color:${A}">Wellness From Within</div><div style="font-size:12px;color:#777;margin-top:2px">Dawn Spain, PHom · A Roaring Fork Homeopathy Associate</div></td></tr>
  <tr><td style="padding:22px 28px 6px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:15px">Hi ${esc(nm)},</td><td style="text-align:right;font-size:12px;color:#777">Receipt<div style="font-size:20px;color:${A};font-weight:bold">#${esc(v.number || "")}</div></td></tr></table>
    <p style="font-size:14px;line-height:1.6;margin:10px 0 16px">Thank you! I received your payment of <b>${esc(money(p.amount))}</b> on ${esc(fmtDate(p.date))} by Square.</p>
    ${table}
    ${m.bal <= 0 ? `<p style="text-align:center;font-weight:bold;color:#2e7d4f;margin:16px 0">Paid in full. Thank you!</p>` : `<p style="text-align:center;font-size:14px;margin:16px 0">Remaining balance: <b>${esc(money(m.bal))}</b></p>`}
    <p style="font-size:13px;color:#555;margin:20px 0 6px">You can see your invoices any time in your <a href="https://portal.dawnspain.com/#billing" style="color:${A}">client portal</a> under Billing.</p>
  </td></tr>
  <tr><td style="padding:16px 28px;border-top:1px solid #eee;font-size:12px;color:#777;line-height:1.6">With warmth,<br><b style="color:#2b2b2b">Dawn Spain, PHom</b><br>Wellness From Within<br>252-626-4104 · <a href="https://www.dawnspain.com" style="color:${A}">www.dawnspain.com</a></td></tr>
  </table></td></tr></table></body></html>`;
    const subject = `Receipt for invoice #${v.number}`;
    const text = `Hi ${nm},\n\nThank you! I received your payment of ${money(p.amount)} on ${fmtDate(p.date)} by Square for invoice #${v.number}.\n\n${m.bal <= 0 ? "This invoice is now paid in full." : `Remaining balance: ${money(m.bal)}.`}\n\nYou can see your invoices any time in your client portal under Billing:\nhttps://portal.dawnspain.com/#billing\n\nWith warmth,\n\nDawn Spain, PHom\nWellness From Within\nA Roaring Fork Homeopathy Associate\n252-626-4104\nwww.dawnspain.com`;
    const mail = nodemailer.createTransport({ host: "smtp.hostinger.com", port: 465, secure: true, auth: { user: Deno.env.get("SMTP_USER"), pass: Deno.env.get("SMTP_PASS") } });
    await mail.sendMail({ from: `"Dawn Spain, Wellness From Within" <${Deno.env.get("SMTP_USER")}>`, replyTo: "wellnessfromwithin@icloud.com", to, subject, text, html });
    await merge("clients/" + v.clientId, { emailLog: [{ at: new Date().toISOString(), subject, kind: "receipt" }, ...(rec.emailLog || [])].slice(0, 50) });
    await merge("invoices/" + invId, { receiptSentAt: new Date().toISOString() });
  } catch (e) { console.error("receipt failed", (e as Error)?.message || e); }
}

async function sq(path: string) {
  const r = await fetch("https://connect.squareup.com/v2/" + path, { headers: { Authorization: "Bearer " + Deno.env.get("SQUARE_TOKEN"), "Square-Version": "2025-01-23", "Content-Type": "application/json" } });
  if (!r.ok) { console.error("square", path, r.status, (await r.text()).slice(0, 200)); return null; }
  return await r.json();
}
async function signatureOk(raw: string, sig: string) {
  const key = (Deno.env.get("SQUARE_SIG_KEY") || "").trim(); if (!key || !sig) { console.error("signature check: key set?", !!key, "sig present?", !!sig); return false; }
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(URL_SELF + raw)));
  const want = btoa(String.fromCharCode(...mac)); if (want.length !== sig.length) { console.error("signature length differs", want.length, sig.length); return false; }
  let d = 0; for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  if (d !== 0) console.error("signature mismatch (key length " + key.length + ")");
  return d === 0;
}
async function findOrMakeClient(cust: Rec) {
  const email = lc(cust.email_address), name = [cust.given_name, cust.family_name].filter(Boolean).join(" ").trim();
  if (email) {
    const { data: rows } = await db.from("docs").select("id,data").eq("parent", "clients");
    const hits = (rows || []).filter((r: Rec) => emailsOf(r.data).includes(email));
    hits.sort((a: Rec, c: Rec) => (a.id.includes("~") ? 1 : 0) - (c.id.includes("~") ? 1 : 0) || String(a.data?.createdAt || "").localeCompare(String(c.data?.createdAt || "")));
    if (hits[0]) return hits[0].id as string;
  }
  if (!email && !name) return "";
  const cid = "c-" + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  await save("clients/" + cid, { name: name || email, email, createdAt: new Date().toISOString(), source: "square", intake: {}, qest: { fullName: name, email, phone: cust.phone_number || "" } });
  return cid;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const raw = await req.text();
  let ev: Rec; try { ev = JSON.parse(raw); } catch { return new Response("bad body", { status: 400 }); }
  // Safety: a correctly signed request is trusted as is. Otherwise nothing in the request body is used: the booking or
  // payment is fetched fresh from Square with Dawn's token, so a fake request can't add anything that isn't really in Square.
  const signed = await signatureOk(raw, req.headers.get("x-square-hmacsha256-signature") || "");
  if (ev.check) { const loc = await sq("locations"); return Response.json({ token_ok: !!loc, signed }); }
  const type = String(ev.type || ""), obj: Rec = ev.data?.object || {};

  // ---------- bookings ----------
  if (type.startsWith("booking.")) {
    const bk: Rec = obj.booking || {}; if (!bk.id) return Response.json({ ok: true, skipped: "no booking" });
    const full = (await sq("bookings/" + bk.id))?.booking || (signed ? bk : null);
    if (!full) return Response.json({ ok: true, skipped: "booking not found in Square" });
    const cust = full.customer_id ? (await sq("customers/" + full.customer_id))?.customer || {} : {};
    const cid = await findOrMakeClient(cust); if (!cid) return Response.json({ ok: true, skipped: "no customer" });
    const rec = (await get("clients/" + cid)) || {};
    const aid = "sq-" + String(full.id).slice(0, 20);
    let list: Rec[] = Array.isArray(rec.appointments) ? rec.appointments.filter((a: Rec) => a.id !== aid) : (/^\d{4}-\d{2}-\d{2}$/.test(rec.nextVisit || "") ? [{ id: "nv" + Date.now(), type: "scan", date: rec.nextVisit, delivery: "imprint" }] : []);
    const cancelled = /CANCELLED|DECLINED|NO_SHOW/i.test(full.status || "");
    if (!cancelled && full.start_at) {
      const { date, time } = ny(full.start_at);
      const mins = (full.appointment_segments || []).reduce((t: number, s: Rec) => t + (+s.duration_minutes || 0), 0) || 30;
      const prevA = (Array.isArray(rec.appointments) ? rec.appointments : []).find((a: Rec) => a.id === aid) || {};
      const zoomUrl = String(prevA.zoomUrl || ((await get("settings/practice")) || {}).zoomUrl || "");
      list.push({ id: aid, type: "consult", date, time, mins, how: "Zoom", ...(zoomUrl ? { zoomUrl } : {}), note: "Booked in Square" });
    }
    list = list.sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
    const today = new Date().toISOString().slice(0, 10);
    const nextScan = list.filter((a) => a.type === "scan" && a.date >= today).map((a) => a.date).sort()[0] || "";
    const patch: Rec = { appointments: list };
    if (!cancelled && type === "booking.created" && !rec.scanToSchedule) {
      const { date } = ny(full.start_at || new Date().toISOString()); const by = new Date(date + "T12:00:00Z"); by.setUTCDate(by.getUTCDate() + 7);
      patch.scanToSchedule = { orderedAt: today, by: by.toISOString().slice(0, 10), source: "square", delivery: "" };
    }
    await merge("clients/" + cid, patch);
    return Response.json({ ok: true, client: cid, cancelled });
  }

  // ---------- payments ----------
  if (type.startsWith("payment.")) {
    const p0: Rec = obj.payment || {}; if (!p0.id) return Response.json({ ok: true, skipped: "no payment" });
    const p: Rec = (await sq("payments/" + p0.id))?.payment || (signed ? p0 : {});
    if (!p.id || p.status !== "COMPLETED") return Response.json({ ok: true, skipped: "not completed" });
    const pid = "sqp-" + String(p.id).slice(0, 24);
    const { data: done } = await db.from("docs").select("path").eq("parent", "invoices").contains("data", { sqPayment: p.id }).limit(1);
    if (done && done.length) return Response.json({ ok: true, skipped: "already recorded" });
    const amount = r2((p.amount_money?.amount || 0) / 100); if (!(amount > 0)) return Response.json({ ok: true, skipped: "zero" });
    const cust = p.customer_id ? (await sq("customers/" + p.customer_id))?.customer || {} : {};
    if (!cust.email_address && p.buyer_email_address) cust.email_address = p.buyer_email_address;
    if (!cust.given_name && p.shipping_address?.first_name) { cust.given_name = p.shipping_address.first_name; cust.family_name = p.shipping_address.last_name; }
    const order = p.order_id ? (await sq("orders/" + p.order_id))?.order || {} : {};
    const day = ny(p.created_at || new Date().toISOString()).date;
    const cid = await findOrMakeClient(cust);
    const { data: invRows } = await db.from("docs").select("id,data").eq("parent", "invoices");
    const invs = (invRows || []).map((r: Rec) => ({ id: r.id as string, v: r.data as Rec }));
    // Website orders paid through the WooCommerce Square plugin are already recorded by woo-order.
    if (cid && invs.some(({ id, v }) => id.startsWith("woo-") && v.clientId === cid && Math.abs(r2(v.items?.reduce((t: number, i: Rec) => t + i.qty * i.price, 0) || 0) - amount) < 0.01 && Math.abs(Date.parse(v.date) - Date.parse(day)) <= 2 * 864e5))
      return Response.json({ ok: true, skipped: "website order" });
    if (/woocommerce|order\s*#?\d+/i.test(String(p.note || "") + " " + String(order.reference_id || "") + " " + String(order.source?.name || "")) && /woo/i.test(String(order.source?.name || p.note || "")))
      return Response.json({ ok: true, skipped: "website order" });
    const method = "Square" + (p.application_details?.square_product === "APPOINTMENTS" ? " (booking)" : "") + (p.receipt_number ? ` · receipt ${p.receipt_number}` : "");
    const pay = { id: pid.slice(0, 20), date: day, amount, method, note: [p.note, ...(order.line_items || []).map((i: Rec) => i.note).filter(Boolean)].filter(Boolean).join(" · ").slice(0, 200) };
    // An open invoice for this client: prefer one whose balance equals the payment; else the oldest open one.
    const bal = (v: Rec) => { const sub = Math.max(0, (v.items || []).reduce((t: number, i: Rec) => t + (i.credit ? 0 : (i.kind === "discount" ? -1 : 1) * Math.abs((+i.qty || 0) * (+i.price || 0))), 0)); const d = v.discount || {}; const disc = !(+d.value) ? 0 : d.type === "pct" ? r2(sub * (+d.value) / 100) : Math.min(sub, r2(d.value)); return r2(Math.max(0, r2(sub - disc)) - (v.payments || []).reduce((t: number, x: Rec) => t + (+x.amount || 0), 0)); };
    const open = invs.filter(({ v }) => v.clientId === cid && v.status === "sent" && bal(v) > 0).sort((a, b) => String(a.v.date).localeCompare(String(b.v.date)));
    const byOrder = p.order_id ? invs.find(({ v }) => (v.sqOrderIds || []).includes(p.order_id) || v.sqLink?.orderId === p.order_id) : null;
    const target = byOrder || open.find(({ v }) => Math.abs(bal(v) - amount) < 0.01) || (open.length === 1 && amount <= bal(open[0].v) + 0.01 ? open[0] : null);
    if (target && (cid || byOrder)) {
      const nv = { ...target.v, payments: [...(target.v.payments || []), pay], sqPayment: p.id, updatedAt: new Date().toISOString() };
      await save("invoices/" + target.id, nv);
      await autoReceipt(target.id, nv, pay);
      return Response.json({ ok: true, applied: target.id });
    }
    const items = (order.line_items || []).map((i: Rec) => ({ kind: /zoom|consult/i.test(i.name || "") ? "consult" : /scan|qest/i.test(i.name || "") ? "scan" : "other", desc: [i.name, i.variation_name].filter((x: string) => x && x !== "Regular").join(" · ") || "Square payment", qty: Math.max(1, +i.quantity || 1), price: r2((i.total_money?.amount ?? i.base_price_money?.amount ?? 0) / 100 / Math.max(1, +i.quantity || 1)) }));
    if (!items.length) items.push({ kind: "other", desc: "Square payment", qty: 1, price: amount });
    const sum = r2(items.reduce((t: number, i: Rec) => t + i.qty * i.price, 0));
    const inv: Rec = { clientId: cid || "", number: "Square " + String(p.receipt_number || p.id).slice(0, 8), date: day, due: "", items, discount: sum > amount ? { label: "Discount", type: "amt", value: r2(sum - amount) } : { label: "", type: "amt", value: "" },
      status: "sent", payments: [pay], note: cid ? "Paid in Square." : "Paid in Square. No client matched: open it and choose the right client.", pay: {}, source: "square", sqPayment: p.id,
      createdAt: new Date().toISOString(), sentAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await save("invoices/" + pid, inv);
    return Response.json({ ok: true, created: pid });
  }
  return Response.json({ ok: true, skipped: type });
});

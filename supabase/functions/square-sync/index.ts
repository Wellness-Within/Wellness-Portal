// Wellness From Within portal: Square → portal.
//   booking.created / booking.updated  → a "Consult call" appointment on the client's record (added, moved or removed),
//                                          and "Needs a scan date" so Dawn picks the scan day.
//   payment.created / payment.updated   → when a payment is COMPLETED, it is recorded in the portal:
//                                          on the client's open invoice if one matches, otherwise as a new paid invoice.
//                                          Website (WooCommerce) payments are skipped: woo-order already records those.
// Secrets (Supabase → Edge Functions → Secrets), pasted in by Dawn:
//   SQUARE_TOKEN     Square production access token (read customers, bookings, orders)
//   SQUARE_SIG_KEY   the webhook subscription's signature key
// Safety: every request must carry Square's signature, or it is refused.
import { createClient } from "npm:@supabase/supabase-js@2";

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
  if (!(await signatureOk(raw, req.headers.get("x-square-hmacsha256-signature") || ""))) return new Response("bad signature", { status: 401 });
  let ev: Rec; try { ev = JSON.parse(raw); } catch { return new Response("bad body", { status: 400 }); }
  const type = String(ev.type || ""), obj: Rec = ev.data?.object || {};

  // ---------- bookings ----------
  if (type.startsWith("booking.")) {
    const bk: Rec = obj.booking || {}; if (!bk.id) return Response.json({ ok: true, skipped: "no booking" });
    const full = (await sq("bookings/" + bk.id))?.booking || bk;
    const cust = full.customer_id ? (await sq("customers/" + full.customer_id))?.customer || {} : {};
    const cid = await findOrMakeClient(cust); if (!cid) return Response.json({ ok: true, skipped: "no customer" });
    const rec = (await get("clients/" + cid)) || {};
    const aid = "sq-" + String(full.id).slice(0, 20);
    let list: Rec[] = Array.isArray(rec.appointments) ? rec.appointments.filter((a: Rec) => a.id !== aid) : (/^\d{4}-\d{2}-\d{2}$/.test(rec.nextVisit || "") ? [{ id: "nv" + Date.now(), type: "scan", date: rec.nextVisit, delivery: "imprint" }] : []);
    const cancelled = /CANCELLED|DECLINED|NO_SHOW/i.test(full.status || "");
    if (!cancelled && full.start_at) {
      const { date, time } = ny(full.start_at);
      const mins = (full.appointment_segments || []).reduce((t: number, s: Rec) => t + (+s.duration_minutes || 0), 0) || 30;
      list.push({ id: aid, type: "consult", date, time, mins, how: "Zoom", note: "Booked in Square" });
    }
    list = list.sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
    const today = new Date().toISOString().slice(0, 10);
    const nextScan = list.filter((a) => a.type === "scan" && a.date >= today).map((a) => a.date).sort()[0] || "";
    const patch: Rec = { appointments: list, nextVisit: nextScan };
    if (!cancelled && type === "booking.created" && !rec.scanToSchedule) {
      const { date } = ny(full.start_at || new Date().toISOString()); const by = new Date(date + "T12:00:00Z"); by.setUTCDate(by.getUTCDate() + 7);
      patch.scanToSchedule = { orderedAt: today, by: by.toISOString().slice(0, 10), source: "square", delivery: "" };
    }
    await merge("clients/" + cid, patch);
    return Response.json({ ok: true, client: cid, cancelled });
  }

  // ---------- payments ----------
  if (type.startsWith("payment.")) {
    const p: Rec = obj.payment || {}; if (!p.id || p.status !== "COMPLETED") return Response.json({ ok: true, skipped: "not completed" });
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
    const bal = (v: Rec) => { const sub = (v.items || []).reduce((t: number, i: Rec) => t + (i.credit ? 0 : (+i.qty || 0) * (+i.price || 0)), 0); const d = v.discount || {}; const disc = !(+d.value) ? 0 : d.type === "pct" ? r2(sub * (+d.value) / 100) : Math.min(sub, r2(d.value)); return r2(Math.max(0, r2(sub - disc)) - (v.payments || []).reduce((t: number, x: Rec) => t + (+x.amount || 0), 0)); };
    const open = invs.filter(({ v }) => v.clientId === cid && v.status === "sent" && bal(v) > 0).sort((a, b) => String(a.v.date).localeCompare(String(b.v.date)));
    const target = open.find(({ v }) => Math.abs(bal(v) - amount) < 0.01) || (open.length === 1 && amount <= bal(open[0].v) + 0.01 ? open[0] : null);
    if (cid && target) {
      await save("invoices/" + target.id, { ...target.v, payments: [...(target.v.payments || []), pay], sqPayment: p.id, updatedAt: new Date().toISOString() });
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

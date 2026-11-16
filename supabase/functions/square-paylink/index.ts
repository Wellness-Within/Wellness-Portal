// Wellness From Within portal: a Square payment link for the exact balance of one invoice.
// The portal calls this (with the signed-in person's session) when Dawn emails an invoice or a client presses "Pay online".
// Safety: the invoice is read with the caller's own session, so only Dawn, or the client the invoice belongs to, can get a link.
// The link is saved on the invoice and reused while the balance is unchanged. When it's paid, square-sync records the payment.
// Secrets used: SQUARE_TOKEN (already set).
import { createClient } from "npm:@supabase/supabase-js@2";

type Rec = Record<string, any>;
const URL_ = Deno.env.get("SUPABASE_URL")!, ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const r2 = (n: any) => Math.round((+n || 0) * 100) / 100;
function balance(v: Rec) {
  const items = v.items || [];
  const sub = Math.max(0, items.reduce((t: number, i: Rec) => t + (i.credit ? 0 : (i.kind === "discount" ? -1 : 1) * Math.abs((+i.qty || 0) * (+i.price || 0))), 0));
  const d = v.discount || {}; const disc = !(+d.value) ? 0 : d.type === "pct" ? r2(sub * (+d.value) / 100) : Math.min(sub, r2(d.value));
  return r2(Math.max(0, r2(sub - disc)) - (v.payments || []).reduce((t: number, p: Rec) => t + (+p.amount || 0), 0));
}
async function sq(path: string, body?: Rec) {
  const r = await fetch("https://connect.squareup.com/v2/" + path, { method: body ? "POST" : "GET", headers: { Authorization: "Bearer " + Deno.env.get("SQUARE_TOKEN"), "Square-Version": "2025-01-23", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) console.error("square", path, r.status, JSON.stringify(j).slice(0, 300));
  return r.ok ? j : null;
}
const out = (b: Rec, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return out({ error: "POST only" }, 405);
  const auth = req.headers.get("Authorization") || "";
  let body: Rec = {}; try { body = await req.json(); } catch { /* */ }
  const id = String(body.invoice || "");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || !auth.startsWith("Bearer ")) return out({ error: "bad request" }, 400);
  // read the invoice as the caller: RLS decides whether they may see it
  const asUser = createClient(URL_, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: row } = await asUser.from("docs").select("data").eq("path", "invoices/" + id).maybeSingle();
  const v: Rec | undefined = row?.data;
  if (!v || v.status !== "sent") return out({ error: "not found" }, 404);
  const bal = balance(v);
  if (!(bal > 0)) return out({ paid: true });
  const sig = JSON.stringify([v.items || [], v.discount || {}, bal]);
  if (v.sqLink?.url && Math.abs((+v.sqLink.amount || 0) - bal) < 0.005 && v.sqLink.sig === sig) return out({ url: v.sqLink.url, amount: bal });

  const locs = await sq("locations");
  const loc = (locs?.locations || []).find((l: Rec) => l.status === "ACTIVE") || (locs?.locations || [])[0];
  if (!loc) return out({ error: "square unavailable" }, 502);
  const who = (v.items || []).map((i: Rec) => i.for).filter(Boolean);
  const name = `Wellness From Within – Invoice #${v.number}`.slice(0, 255);
  // Itemized checkout (each invoice line + discounts) so the client sees the same breakdown as the invoice.
  // Falls back to a single "Invoice #" line when something has already been paid or the totals don't match exactly.
  const cents = (n: any) => Math.round(Math.abs(+n || 0) * 100);
  let order: Rec | null = null;
  if (!(v.payments || []).length) {
    const items = (v.items || []).filter((i: Rec) => !i.credit && i.kind !== "discount" && cents(i.price) > 0 && (+i.qty || 0) > 0);
    const line_items = items.map((i: Rec) => ({
      name: (`${i.desc || "Item"}${i.for ? " – for " + i.for : ""}`).slice(0, 500),
      quantity: String(+i.qty || 1),
      base_price_money: { amount: cents(i.price), currency: "USD" },
    }));
    const discounts: Rec[] = [];
    (v.items || []).filter((i: Rec) => !i.credit && i.kind === "discount").forEach((i: Rec) => {
      const a = Math.round(Math.abs((+i.qty || 1) * (+i.price || 0)) * 100);
      if (a > 0) discounts.push({ name: (i.desc || "Discount").slice(0, 255), type: "FIXED_AMOUNT", amount_money: { amount: a, currency: "USD" }, scope: "ORDER" });
    });
    const d = v.discount || {};
    if (+d.value > 0) discounts.push(d.type === "pct"
      ? { name: (d.label || "Discount").slice(0, 255), type: "FIXED_PERCENTAGE", percentage: String(+d.value), scope: "ORDER" }
      : { name: (d.label || "Discount").slice(0, 255), type: "FIXED_AMOUNT", amount_money: { amount: cents(d.value), currency: "USD" }, scope: "ORDER" });
    // only use it when it adds up to the invoice balance to the cent (percent discounts are checked the same way Square rounds)
    let sub = items.reduce((t: number, i: Rec) => t + Math.round((+i.qty || 1) * cents(i.price)), 0);
    discounts.filter(x => x.type === "FIXED_AMOUNT").forEach(x => sub -= x.amount_money.amount);
    discounts.filter(x => x.type === "FIXED_PERCENTAGE").forEach(x => sub -= Math.round(sub * (+x.percentage) / 100));
    if (line_items.length && sub === Math.round(bal * 100)) order = { location_id: loc.id, reference_id: `Invoice #${v.number}`.slice(0, 40), line_items, ...(discounts.length ? { discounts } : {}) };
  }
  const res = await sq("online-checkout/payment-links", {
    idempotency_key: crypto.randomUUID(),
    ...(order ? { order } : { quick_pay: { name: (v.payments || []).length ? `${name} – remaining balance` : name, price_money: { amount: Math.round(bal * 100), currency: "USD" }, location_id: loc.id } }),
    payment_note: `Invoice #${v.number}${who.length ? " · " + [...new Set(who)].join(", ") : ""}`.slice(0, 500),
    checkout_options: { redirect_url: "https://portal.dawnspain.com/#billing", ask_for_shipping_address: false },
  });
  let link = res?.payment_link;
  const got = res?.related_resources?.orders?.[0]?.total_money?.amount;
  if (order && link?.url && got != null && got !== Math.round(bal * 100)) {
    // totals disagree: don't risk the wrong amount, use a plain one-line link instead
    const res2 = await sq("online-checkout/payment-links", { idempotency_key: crypto.randomUUID(), quick_pay: { name, price_money: { amount: Math.round(bal * 100), currency: "USD" }, location_id: loc.id }, payment_note: `Invoice #${v.number}`, checkout_options: { redirect_url: "https://portal.dawnspain.com/#billing", ask_for_shipping_address: false } });
    link = res2?.payment_link;
  }
  if (!link?.url) return out({ error: "square unavailable" }, 502);
  await admin.rpc("doc_merge", { p_path: "invoices/" + id, p_data: { sqLink: { url: link.url, amount: bal, sig, orderId: link.order_id || "", id: link.id || "", at: new Date().toISOString() }, sqOrderIds: [...(v.sqOrderIds || []), link.order_id].filter(Boolean).slice(-10) } });
  return out({ url: link.url, amount: bal });
});

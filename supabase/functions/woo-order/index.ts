// Wellness From Within portal: receive website orders from the WooCommerce store on dawnspain.com.
// WooCommerce → Settings → Advanced → Webhooks sends each paid order here ("Order created" and "Order updated").
//
// For each paid order it:
//   - finds the client by email (or adds a new client record that connects when they sign in),
//   - adds a PAID invoice "Web <order number>" to their Billing, with the payment recorded,
//   - voids that invoice if the order is later refunded or cancelled.
//
// Supabase → Edge Functions → Secrets needs:
//   WOO_SECRET   the "Secret" shown on the WooCommerce webhook (Dawn copies it in herself)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
// Safety: every request must carry WooCommerce's signature made with WOO_SECRET, or it is refused.
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
type Rec = Record<string, any>;
const PAID = ["processing", "completed"];
const GONE = ["refunded", "cancelled"];
const r2 = (n: any) => Math.round((+n || 0) * 100) / 100;
const lc = (s: any) => String(s || "").trim().toLowerCase();
const emailsOf = (d: Rec) => [d?.email, d?.intake?.email, d?.qest?.email, d?.followup?.email].map(lc).filter(Boolean);

async function signatureOk(raw: Uint8Array, sig: string) {
  const secret = Deno.env.get("WOO_SECRET") || "";
  if (!secret || !sig) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, raw));
  const want = btoa(String.fromCharCode(...mac));
  if (want.length !== sig.length) return false;
  let diff = 0; for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}
const save = (path: string, data: Rec) => db.from("docs").upsert({ path, parent: path.slice(0, path.lastIndexOf("/")), id: path.slice(path.lastIndexOf("/") + 1), data, updated_at: new Date().toISOString() });

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const raw = new Uint8Array(await req.arrayBuffer());
  // WooCommerce's first "ping" when the webhook is saved has no topic; answer OK so it can be saved.
  if (!req.headers.get("x-wc-webhook-topic")) return Response.json({ ok: true, ping: true });
  if (!(await signatureOk(raw, req.headers.get("x-wc-webhook-signature") || ""))) return new Response("bad signature", { status: 401 });

  let o: Rec; try { o = JSON.parse(new TextDecoder().decode(raw)); } catch { return new Response("bad body", { status: 400 }); }
  if (!o?.id) return Response.json({ ok: true, skipped: "no order" });
  const path = "invoices/woo-" + o.id;
  const { data: have } = await db.from("docs").select("data").eq("path", path).maybeSingle();

  if (GONE.includes(o.status)) {
    if (have?.data && have.data.status !== "void") await save(path, { ...have.data, status: "void", voidedAt: new Date().toISOString(), note: `${have.data.note || ""}\nWebsite order ${o.status}.`.trim() });
    return Response.json({ ok: true, voided: !!have });
  }
  if (!PAID.includes(o.status)) return Response.json({ ok: true, skipped: "not paid yet: " + o.status });
  if (have?.data) return Response.json({ ok: true, skipped: "already in portal" });

  const b = o.billing || {}, s = o.shipping || {};
  const email = lc(b.email);
  const name = [b.first_name, b.last_name].filter(Boolean).join(" ").trim();
  const attrs = (li: Rec) => (li.meta_data || []).filter((m: Rec) => m.display_key && !String(m.key || "").startsWith("_")).map((m: Rec) => `${m.display_key}: ${String(m.display_value).replace(/<[^>]+>/g, "")}`);
  const allAttrs = (o.line_items || []).flatMap(attrs).join(" · ");
  const shipped = /ship|mail|tincture/i.test(allAttrs) && !/reports only/i.test(allAttrs);
  const ship = s.address_1 ? s : b;
  const shipTo = [[ship.first_name, ship.last_name].filter(Boolean).join(" "), [ship.address_1, ship.address_2].filter(Boolean).join(", "), [ship.city, [ship.state, ship.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", "), ship.country && ship.country !== "US" ? ship.country : ""].filter((x) => String(x || "").trim()).join("\n");

  // Find the client by email. Several matches (a family) → the sign-in's own record, else the oldest.
  let cid = "";
  if (email) {
    const { data: rows } = await db.from("docs").select("id,data").eq("parent", "clients");
    const hits = (rows || []).filter((r: Rec) => emailsOf(r.data).includes(email));
    hits.sort((a: Rec, c: Rec) => (a.id.includes("~") ? 1 : 0) - (c.id.includes("~") ? 1 : 0) || String(a.data?.createdAt || "").localeCompare(String(c.data?.createdAt || "")));
    cid = hits[0]?.id || "";
  }
  if (!cid) {
    cid = "c-" + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    await save("clients/" + cid, {
      name: name || email || "Website customer", email, createdAt: new Date().toISOString(), source: "website", intake: {},
      qest: { fullName: name, email, phone: b.phone || "", street: [b.address_1, b.address_2].filter(Boolean).join(", "), city: b.city || "", state: b.state || "", zip: b.postcode || "",
        ...(s.address_1 && (s.address_1 !== b.address_1 || s.postcode !== b.postcode) ? { shipDifferent: true, shipStreet: [s.address_1, s.address_2].filter(Boolean).join(", "), shipCity: s.city || "", shipState: s.state || "", shipZip: s.postcode || "" } : {}),
        ...(allAttrs ? { delivery: shipped ? "Shipped to me" : "Remote imprint" } : {}) },
    });
  }

  const items: Rec[] = (o.line_items || []).map((li: Rec) => {
    const qty = Math.max(1, +li.quantity || 1);
    const a = attrs(li).filter((x: string) => !/^consultation: no appointment/i.test(x));
    const kind = /zoom|consult/i.test(li.name + a.join(" ")) ? "consult" : /scan|qest/i.test(li.name) ? "scan" : "other";
    return { kind, desc: [li.name, ...a].join(" · "), qty, price: r2((+li.total || 0) / qty) };
  });
  if (+o.shipping_total) items.push({ kind: "shipping", desc: "Shipping", qty: 1, price: r2(o.shipping_total) });
  if (+o.total_tax) items.push({ kind: "other", desc: "Sales tax", qty: 1, price: r2(o.total_tax) });
  const fees = (o.fee_lines || []).filter((f: Rec) => +f.total);
  fees.forEach((f: Rec) => items.push({ kind: "other", desc: f.name || "Fee", qty: 1, price: r2(f.total) }));

  const day = String(o.date_paid || o.date_created || new Date().toISOString()).slice(0, 10);
  const total = r2(o.total);
  const inv: Rec = {
    clientId: cid, number: "Web " + (o.number || o.id), date: day, due: "", items,
    discount: { label: "", type: "amt", value: "" }, status: "sent",
    payments: total > 0 ? [{ id: "woo" + o.id, date: day, amount: total, method: `Website order #${o.number || o.id}${o.payment_method_title ? " · " + o.payment_method_title : ""}`, note: "" }] : [],
    note: `Ordered on dawnspain.com${allAttrs ? ` (${allAttrs})` : ""}.${o.customer_note ? "\nCustomer note: " + o.customer_note : ""}`,
    pay: {}, source: "website", wooOrder: o.id, ...(shipped && shipTo ? { shipTo } : {}),
    createdAt: new Date().toISOString(), sentAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  // Make the invoice total match what they actually paid (coupons are already in line totals).
  const sum = r2(items.reduce((t, i) => t + i.qty * i.price, 0));
  if (sum > total) inv.discount = { label: "Website discount", type: "amt", value: r2(sum - total) };
  const { error } = await save(path, inv);
  if (error) return new Response("save failed", { status: 500 });
  return Response.json({ ok: true, client: cid });
});

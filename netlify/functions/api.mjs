import { getStore } from "@netlify/blobs";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

function authorized(req) {
  const pass = process.env.APP_PASSWORD;
  if (!pass) return false;
  return req.headers.get("x-pass") === pass;
}

const MONTH = /^\d{4}-\d{2}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export default async (req) => {
  if (!process.env.APP_PASSWORD) return json({ error: "A jelszó nincs beállítva a szerveren (APP_PASSWORD)." }, 500);
  if (!authorized(req)) return json({ error: "Hibás jelszó." }, 401);

  const store = getStore({ name: "rogzito", consistency: "strong" });
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const m = req.method;

  // GET /api/ping – jelszó ellenőrzése
  if (parts[0] === "ping") return json({ ok: true });

  // Beállítások (ügyfelek, tételek, árak, ingyenes keretek, gyorsgombok)
  if (parts[0] === "config") {
    if (m === "GET") return json((await store.get("config", { type: "json" })) || {});
    if (m === "PUT") {
      const body = await req.json();
      if (!body || typeof body !== "object") return json({ error: "Hibás adat." }, 400);
      await store.setJSON("config", body);
      return json({ ok: true });
    }
  }

  // Tételek havonta: e/<YYYY-MM>/<id>
  if (parts[0] === "entries") {
    if (m === "GET") {
      const month = url.searchParams.get("month") || "";
      if (!MONTH.test(month)) return json({ error: "Hibás hónap." }, 400);
      const { blobs } = await store.list({ prefix: `e/${month}/` });
      const items = await Promise.all(blobs.map(async (b) => {
        const v = await store.get(b.key, { type: "json" });
        return v ? { ...v, id: b.key.split("/").pop() } : null;
      }));
      return json(items.filter(Boolean));
    }
    if (m === "POST") {
      const r = await req.json();
      const month = String(r.date || "").slice(0, 7);
      if (!MONTH.test(month) || !r.company) return json({ error: "Hiányzó adat." }, 400);
      const id = `${month}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const entry = {
        date: String(r.date).slice(0, 10), company: String(r.company).slice(0, 200), person: String(r.person || "").slice(0, 200),
        cat: String(r.cat || "Egyéb"), item: String(r.item || "").slice(0, 300), qty: +r.qty || 0, unit: +r.unit || 0,
        total: +r.total || 0, note: String(r.note || "").slice(0, 500), ts: +r.ts || Date.now(),
      };
      await store.setJSON(`e/${month}/${id}`, entry);
      return json({ ...entry, id });
    }
    if (m === "DELETE" && parts[1] && ID.test(parts[1])) {
      const month = parts[1].slice(0, 7);
      await store.delete(`e/${month}/${parts[1]}`);
      return json({ ok: true });
    }
  }

  return json({ error: "Ismeretlen kérés." }, 404);
};

export const config = { path: "/api/*" };

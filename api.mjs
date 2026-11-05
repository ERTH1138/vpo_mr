import { getStore } from "@netlify/blobs";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const MONTH = /^\d{4}-\d{2}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export default async (req) => {
  const store = getStore({ name: "rogzito", consistency: "strong" });
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const m = req.method;

  // GET /api/ping
  if (parts[0] === "ping") return json({ ok: true });

  // GET /api/mnb?date=YYYY-MM-DD – MNB hivatalos EUR árfolyam az adott napra (vagy a legutóbbi jegyzés)
  if (parts[0] === "mnb" && m === "GET") {
    const d = url.searchParams.get("date") || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return json({ error: "Hibás dátum." }, 400);
    const from = new Date(d + "T00:00:00Z");
    from.setUTCDate(from.getUTCDate() - 10);
    const body = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetExchangeRates xmlns="http://www.mnb.hu/webservices/"><startDate>${from.toISOString().slice(0, 10)}</startDate><endDate>${d}</endDate><currencyNames>EUR</currencyNames></GetExchangeRates></soap:Body></soap:Envelope>`;
    let text = null, lastErr = "";
    for (const endpoint of ["https://www.mnb.hu/arfolyamok.asmx", "http://www.mnb.hu/arfolyamok.asmx"]) {
      try {
        const r = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "text/xml; charset=utf-8", SOAPAction: '"http://www.mnb.hu/webservices/MNBArfolyamServiceSoap/GetExchangeRates"' },
          body,
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) { text = await r.text(); break; }
        lastErr = "HTTP " + r.status;
      } catch (e) { lastErr = e.message; }
    }
    if (!text) return json({ error: "Az MNB nem érhető el (" + lastErr + ")." }, 502);
    const x = text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    const days = [...x.matchAll(/<Day date="(\d{4}-\d{2}-\d{2})">([\s\S]*?)<\/Day>/g)]
      .map((mm) => {
        const v = mm[2].match(/<Rate[^>]*curr="EUR"[^>]*>([\d.,]+)<\/Rate>/);
        return v ? { date: mm[1], rate: +v[1].replace(",", ".") } : null;
      })
      .filter((o) => o && o.date <= d && o.rate > 0)
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    if (!days.length) return json({ error: "Erre a napra nincs MNB árfolyam." }, 404);
    return json(days[0]);
  }

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

  // Tárgyalófoglalások havonta: b/<YYYY-MM>/<id>
  if (parts[0] === "bookings") {
    const DAY = /^\d{4}-\d{2}-\d{2}$/, HM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
    const toMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
    const monthsBetween = (a, b) => { const out = []; let [y, mo] = a.slice(0, 7).split("-").map(Number); const [y2, m2] = b.slice(0, 7).split("-").map(Number);
      while (y < y2 || (y === y2 && mo <= m2)) { out.push(`${y}-${String(mo).padStart(2, "0")}`); mo++; if (mo > 12) { mo = 1; y++; } if (out.length > 24) break; } return out; };
    const loadMonth = async (month) => { const { blobs } = await store.list({ prefix: `b/${month}/` });
      const items = await Promise.all(blobs.map(async (b) => { const v = await store.get(b.key, { type: "json" }); return v ? { ...v, id: b.key.split("/").pop() } : null; }));
      return items.filter(Boolean); };
    const clean = (r) => {
      const date = String(r.date || ""), start = String(r.start || ""), end = String(r.end || "");
      if (!DAY.test(date) || !HM.test(start) || !HM.test(end)) return { error: "Hibás dátum vagy időpont." };
      if (toMin(end) <= toMin(start)) return { error: "A befejezésnek a kezdés után kell lennie." };
      if (!r.room) return { error: "Válassz termet." };
      return { b: { room: String(r.room).slice(0, 80), date, start, end, company: String(r.company || "").slice(0, 200), title: String(r.title || "").slice(0, 200),
        person: String(r.person || "").slice(0, 200), note: String(r.note || "").slice(0, 1000), src: String(r.src || "").slice(0, 40), ext: String(r.ext || "").slice(0, 120), ts: +r.ts || Date.now() } };
    };
    const clash = (list, b, selfId) => list.find((x) => x.id !== selfId && x.room === b.room && x.date === b.date && toMin(x.start) < toMin(b.end) && toMin(b.start) < toMin(x.end));
    const newId = (month) => `${month}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

    if (m === "GET") {
      const from = url.searchParams.get("from") || "", to = url.searchParams.get("to") || from;
      if (!DAY.test(from) || !DAY.test(to) || to < from) return json({ error: "Hibás időszak." }, 400);
      const all = (await Promise.all(monthsBetween(from, to).map(loadMonth))).flat();
      return json(all.filter((b) => b.date >= from && b.date <= to));
    }
    // Tömeges import (Skedda): a már meglévő azonos foglalásokat kihagyja
    if (m === "POST" && parts[1] === "import") {
      const body = await req.json();
      const list = Array.isArray(body.items) ? body.items.slice(0, 300) : [];
      const cache = {}; let added = 0, dup = 0, conflict = 0, bad = 0;
      for (const r of list) {
        const c = clean(r); if (c.error) { bad++; continue; }
        const b = c.b, month = b.date.slice(0, 7);
        cache[month] = cache[month] || await loadMonth(month);
        if (cache[month].some((x) => (b.ext && x.ext === b.ext) || (x.room === b.room && x.date === b.date && x.start === b.start && x.end === b.end && x.company === b.company))) { dup++; continue; }
        if (clash(cache[month], b)) { conflict++; continue; }
        const id = newId(month); await store.setJSON(`b/${month}/${id}`, b); cache[month].push({ ...b, id }); added++;
      }
      return json({ added, dup, conflict, bad });
    }
    if (m === "POST" || (m === "PUT" && parts[1] && ID.test(parts[1]))) {
      const c = clean(await req.json()); if (c.error) return json({ error: c.error }, 400);
      const b = c.b, month = b.date.slice(0, 7);
      let id = null, moveFrom = null;
      if (m === "PUT") {
        const oldKey = `b/${parts[1].slice(0, 7)}/${parts[1]}`;
        const prev = await store.get(oldKey, { type: "json" });
        if (!prev) return json({ error: "A foglalás már nem létezik (lehet, hogy valaki törölte)." }, 404);
        b.ts = prev.ts; b.src = prev.src || b.src; b.ext = prev.ext || "";
        if (parts[1].slice(0, 7) === month) id = parts[1]; else moveFrom = oldKey;
      }
      const x = clash(await loadMonth(month), b, parts[1]);
      if (x) return json({ error: `Ütközik egy másik foglalással: ${x.start}–${x.end} ${x.company || x.title || ""}`.trim(), clash: x }, 409);
      id = id || newId(month);
      await store.setJSON(`b/${month}/${id}`, b);
      if (moveFrom) await store.delete(moveFrom);
      return json({ ...b, id });
    }
    if (m === "DELETE" && parts[1] && ID.test(parts[1])) {
      await store.delete(`b/${parts[1].slice(0, 7)}/${parts[1]}`);
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
    if (m === "POST" || (m === "PUT" && parts[1] && ID.test(parts[1]))) {
      const r = await req.json();
      const month = String(r.date || "").slice(0, 7);
      if (!MONTH.test(month) || !r.company) return json({ error: "Hiányzó adat." }, 400);
      let id, moveFrom = null;
      if (m === "PUT") {
        const oldKey = `e/${parts[1].slice(0, 7)}/${parts[1]}`;
        const prev = await store.get(oldKey, { type: "json" });
        if (!prev) return json({ error: "A tétel már nem létezik (lehet, hogy valaki törölte)." }, 404);
        id = parts[1].slice(0, 7) === month ? parts[1] : null;
        if (!id) moveFrom = oldKey;
        r.ts = prev.ts;
      }
      id = id || `${month}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const entry = {
        date: String(r.date).slice(0, 10), company: String(r.company).slice(0, 200), person: String(r.person || "").slice(0, 200),
        cat: String(r.cat || "Egyéb"), item: String(r.item || "").slice(0, 300), qty: +r.qty || 0, unit: +r.unit || 0,
        total: +r.total || 0, cur: r.cur === "EUR" ? "EUR" : "HUF", note: String(r.note || "").slice(0, 500), ts: +r.ts || Date.now(),
      };
      await store.setJSON(`e/${month}/${id}`, entry);
      if (moveFrom) await store.delete(moveFrom);
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

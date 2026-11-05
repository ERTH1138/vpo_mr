import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

// ---------- Belépés ----------
// A felhasználók az APP_USERS környezeti változóban vannak (Netlify → Environment variables), soha nem a kódban:
// {"office@vpo.hu":"pbkdf2$<iterációk>$<só>$<hash>", ...}
const b64u = (b) => Buffer.from(b).toString("base64url");
function users() { try { const u = JSON.parse(process.env.APP_USERS || "null"); return u && typeof u === "object" ? u : null; } catch { return null; } }
const secret = () => crypto.createHash("sha256").update("vpo-session|" + (process.env.SESSION_SECRET || process.env.APP_USERS || "")).digest();
const fp = (stored) => crypto.createHash("sha256").update(stored).digest("base64url").slice(0, 10);
function checkPw(stored, pw) {
  const [alg, it, salt, hash] = String(stored).split("$");
  if (alg !== "pbkdf2" || !+it) return false;
  const h = crypto.pbkdf2Sync(String(pw), Buffer.from(salt, "base64url"), +it, 32, "sha256"), H = Buffer.from(hash, "base64url");
  return H.length === h.length && crypto.timingSafeEqual(h, H);
}
function sign(email, stored) {
  const p = b64u(JSON.stringify({ e: email, f: fp(stored), x: Date.now() + 30 * 864e5 }));
  return p + "." + b64u(crypto.createHmac("sha256", secret()).update(p).digest());
}
function whoIs(req) {
  const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const [p, s] = t.split(".");
  if (!p || !s) return null;
  const exp = b64u(crypto.createHmac("sha256", secret()).update(p).digest());
  if (s.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(exp))) return null;
  let o; try { o = JSON.parse(Buffer.from(p, "base64url").toString()); } catch { return null; }
  const U = users();
  if (!U || !U[o.e] || o.x < Date.now() || o.f !== fp(U[o.e])) return null;
  return o.e;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const MONTH = /^\d{4}-\d{2}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

// ---------- Catering-emlékeztető: a tárgyalás előtti munkanapra kerül a Leadandó infók közé ----------
const pad2 = (n) => String(n).padStart(2, "0");
const isoD = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
function easter(y) { const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3),
  h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
  mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1; return Date.UTC(y, mo - 1, da); }
function holidays(y) { const e = easter(y), D = (ms) => isoD(new Date(ms));
  return new Set([`${y}-01-01`, `${y}-03-15`, `${y}-05-01`, `${y}-08-20`, `${y}-10-23`, `${y}-11-01`, `${y}-12-24`, `${y}-12-25`, `${y}-12-26`,
    D(e - 2 * 864e5), D(e + 864e5), D(e + 50 * 864e5)]); }
function prevWorkday(date) { const d = new Date(date + "T12:00:00Z");
  for (let i = 0; i < 14; i++) { d.setUTCDate(d.getUTCDate() - 1); const w = d.getUTCDay(), s = isoD(d); if (w !== 0 && w !== 6 && !holidays(d.getUTCFullYear()).has(s)) return s; }
  return isoD(d); }
const ROOMNAMES = { panorama: "Panoráma terem", "kis-tav": "Kisterem távolabbi", nagy: "Nagyterem", "kis-koz": "Kisterem közelebbi" };
function cateringText(b) { const d = new Date(b.date + "T12:00:00Z");
  const day = d.toLocaleDateString("hu-HU", { month: "long", day: "numeric", weekday: "long", timeZone: "UTC" });
  return `Emlékeztető: catering rendelés – ${b.company || b.title || "foglalás"}${b.person ? " (" + b.person + ")" : ""}, ${day} ${b.start}, ${ROOMNAMES[b.room] || b.room}: ${b.catering}`; }
async function noteEdit(store, date, fn) { const key = `n/${date.slice(0, 7)}/${date}`; const v = (await store.get(key, { type: "json" })) || { items: [] };
  const items = fn((v.items || []).slice()); if (items.length) await store.setJSON(key, { items }); else await store.delete(key); }
// Régi és új állapot alapján frissíti a foglaláshoz tartozó emlékeztetőt (azonosító: cat-<foglalás id>)
async function syncCatering(store, user, oldB, oldId, newB, newId) {
  const oldDay = oldB && oldB.catering ? prevWorkday(oldB.date) : null, newDay = newB && newB.catering ? prevWorkday(newB.date) : null;
  const newItem = newDay ? { id: "cat-" + newId, t: cateringText(newB).slice(0, 400), done: false, by: user, ts: Date.now(), dby: "", bk: newId, kind: "catering" } : null;
  if (oldDay && (oldDay !== newDay || oldId !== newId)) await noteEdit(store, oldDay, (L) => L.filter((x) => x.id !== "cat-" + oldId));
  if (newDay) await noteEdit(store, newDay, (L) => { const i = L.findIndex((x) => x.id === newItem.id);
    if (i >= 0) { if (L[i].t === newItem.t) return L; L[i] = { ...newItem, ts: L[i].ts }; return L; } return L.concat(newItem); });
  return newDay;
}

export default async (req) => {
  const store = getStore({ name: "rogzito", consistency: "strong" });
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const m = req.method;

  // GET /api/ping
  if (parts[0] === "ping") return json({ ok: true });

  // POST /api/login {email, password}
  if (parts[0] === "login" && m === "POST") {
    const U = users();
    if (!U) return json({ error: "A belépés még nincs beállítva a szerveren (APP_USERS)." }, 503);
    const body = await req.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase();
    if (!U[email] || !checkPw(U[email], body.password || "")) {
      await new Promise((r) => setTimeout(r, 600));
      return json({ error: "Hibás e-mail-cím vagy jelszó." }, 401);
    }
    return json({ token: sign(email, U[email]), email });
  }

  // Minden más kéréshez belépés kell
  if (!users()) return json({ error: "A belépés még nincs beállítva a szerveren (APP_USERS).", auth: true }, 503);
  const user = whoIs(req);
  if (!user) return json({ error: "Jelentkezz be újra.", auth: true }, 401);
  if (parts[0] === "me") return json({ email: user });

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

  // Leadandó infók / napi teendők: n/<YYYY-MM>/<YYYY-MM-DD> = {items:[{id,t,done,by,ts}]}
  if (parts[0] === "notes") {
    const DAY = /^\d{4}-\d{2}-\d{2}$/;
    if (m === "GET") {
      const from = url.searchParams.get("from") || "", to = url.searchParams.get("to") || from;
      if (!DAY.test(from) || !DAY.test(to) || to < from) return json({ error: "Hibás időszak." }, 400);
      const months = []; let [y, mo] = from.slice(0, 7).split("-").map(Number); const [y2, m2] = to.slice(0, 7).split("-").map(Number);
      while ((y < y2 || (y === y2 && mo <= m2)) && months.length < 24) { months.push(`${y}-${String(mo).padStart(2, "0")}`); mo++; if (mo > 12) { mo = 1; y++; } }
      const out = {};
      for (const month of months) {
        const { blobs } = await store.list({ prefix: `n/${month}/` });
        await Promise.all(blobs.map(async (b) => { const d = b.key.split("/").pop(); if (d >= from && d <= to) { const v = await store.get(b.key, { type: "json" }); if (v && v.items && v.items.length) out[d] = v.items; } }));
      }
      return json(out);
    }
    if (m === "PUT" && DAY.test(parts[1] || "")) {
      const body = await req.json().catch(() => ({}));
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 200).map((x) => ({
        id: String(x.id || "").slice(0, 40) || Math.random().toString(36).slice(2, 10), t: String(x.t || "").slice(0, 400), done: !!x.done,
        by: String(x.by || user).slice(0, 120), ts: +x.ts || Date.now(), dby: x.done ? String(x.dby || user).slice(0, 120) : "",
        ...(x.bk ? { bk: String(x.bk).slice(0, 64), kind: String(x.kind || "").slice(0, 20) } : {}) })).filter((x) => x.t.trim());
      const key = `n/${parts[1].slice(0, 7)}/${parts[1]}`;
      if (items.length) await store.setJSON(key, { items }); else await store.delete(key);
      return json({ date: parts[1], items });
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
        person: String(r.person || "").slice(0, 200), note: String(r.note || "").slice(0, 1000), catering: String(r.catering || "").trim().slice(0, 1000), plate: String(r.plate || "").toUpperCase().replace(/\s+/g, " ").trim().slice(0, 120), src: String(r.src || "").slice(0, 40), ext: String(r.ext || "").slice(0, 120), ts: +r.ts || Date.now() } };
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
        b.by = user; const id = newId(month); await store.setJSON(`b/${month}/${id}`, b); cache[month].push({ ...b, id }); added++;
      }
      return json({ added, dup, conflict, bad });
    }
    if (m === "POST" || (m === "PUT" && parts[1] && ID.test(parts[1]))) {
      const c = clean(await req.json()); if (c.error) return json({ error: c.error }, 400);
      const b = c.b, month = b.date.slice(0, 7);
      let id = null, moveFrom = null, prev = null;
      if (m === "PUT") {
        const oldKey = `b/${parts[1].slice(0, 7)}/${parts[1]}`;
        prev = await store.get(oldKey, { type: "json" });
        if (!prev) return json({ error: "A foglalás már nem létezik (lehet, hogy valaki törölte)." }, 404);
        b.ts = prev.ts; b.src = prev.src || b.src; b.ext = prev.ext || ""; b.by = prev.by || ""; b.upd = user;
        if (parts[1].slice(0, 7) === month) id = parts[1]; else moveFrom = oldKey;
      }
      const x = clash(await loadMonth(month), b, parts[1]);
      if (x) return json({ error: `Ütközik egy másik foglalással: ${x.start}–${x.end} ${x.company || x.title || ""}`.trim(), clash: x }, 409);
      if (m === "POST") b.by = user;
      id = id || newId(month);
      await store.setJSON(`b/${month}/${id}`, b);
      if (moveFrom) await store.delete(moveFrom);
      const remind = await syncCatering(store, user, prev, parts[1], b, id);
      return json({ ...b, id, remind });
    }
    if (m === "DELETE" && parts[1] && ID.test(parts[1])) {
      const key = `b/${parts[1].slice(0, 7)}/${parts[1]}`, prev = await store.get(key, { type: "json" });
      await store.delete(key);
      if (prev) await syncCatering(store, user, prev, parts[1], null, null);
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
        total: +r.total || 0, cur: r.cur === "EUR" ? "EUR" : "HUF", note: String(r.note || "").slice(0, 500), ts: +r.ts || Date.now(), by: user,
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

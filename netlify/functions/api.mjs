import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

// ---------- Belépés ----------
// Adminok: az APP_USERS környezeti változóban (Netlify → Environment variables), soha nem a kódban:
// {"office@vpo.hu":"pbkdf2$<iterációk>$<só>$<hash>", ...}
// Ügyfél-fiókok: a tárolóban, u/<e-mail> kulcson (az iroda hozza létre, az ügyfél meghívó linkkel állít jelszót).
const b64u = (b) => Buffer.from(b).toString("base64url");
function users() { try { const u = JSON.parse(process.env.APP_USERS || "null"); return u && typeof u === "object" ? u : null; } catch { return null; } }
const secret = () => crypto.createHash("sha256").update("vpo-session|" + (process.env.SESSION_SECRET || process.env.APP_USERS || "")).digest();
const fp = (stored) => crypto.createHash("sha256").update(stored).digest("base64url").slice(0, 10);
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("base64url");
function checkPw(stored, pw) {
  const [alg, it, salt, hash] = String(stored).split("$");
  if (alg !== "pbkdf2" || !+it) return false;
  const h = crypto.pbkdf2Sync(String(pw), Buffer.from(salt, "base64url"), +it, 32, "sha256"), H = Buffer.from(hash, "base64url");
  return H.length === h.length && crypto.timingSafeEqual(h, H);
}
function makeHash(pw) { const salt = crypto.randomBytes(16), it = 120000;
  return `pbkdf2$${it}$${b64u(salt)}$${b64u(crypto.pbkdf2Sync(String(pw), salt, it, 32, "sha256"))}`; }
const hmac = (p) => b64u(crypto.createHmac("sha256", secret()).update(p).digest());
function signObj(o) { const p = b64u(JSON.stringify(o)); return p + "." + hmac(p); }
function readSigned(t) {
  const [p, s] = String(t || "").split(".");
  if (!p || !s) return null;
  const exp = hmac(p);
  if (s.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(exp))) return null;
  try { return JSON.parse(Buffer.from(p, "base64url").toString()); } catch { return null; }
}
const sign = (email, stored, role) => signObj({ e: email, f: fp(stored), x: Date.now() + 30 * 864e5, ...(role === "client" ? { r: "c" } : {}) });
const accKey = (email) => "u/" + String(email).trim().toLowerCase();
async function whoIs(req, store) {
  const o = readSigned((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""));
  if (!o || !o.e || o.x < Date.now()) return null;
  if (o.r === "c") {
    const a = await store.get(accKey(o.e), { type: "json" });
    if (!a || !a.hash || a.off || o.f !== fp(a.hash)) return null;
    return { email: o.e, role: "client", company: a.company, name: a.name || "" };
  }
  const U = users();
  if (!U || !U[o.e] || o.f !== fp(U[o.e])) return null;
  return { email: o.e, role: "admin" };
}

// ---------- E-mail: Microsoft 365 (Graph API) vagy Resend ----------
// Microsoft 365: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET (Entra alkalmazás, Mail.Send jog), MAIL_SENDER (pl. foglalas@vpo.hu).
// Resend (alternatíva): RESEND_API_KEY, MAIL_FROM (pl. "Vista Plus Offices <foglalas@mail.vpo.hu>").
// Közös: MAIL_REPLY_TO (pl. info@vpo.hu),
// NOTIFY_EMAIL (opcionális: ide megy értesítés az ügyfélportálos foglalásokról / lemondásokról), SITE_URL (opcionális).
const SITE = () => (process.env.SITE_URL || process.env.URL || "https://vpo-room-hours.netlify.app").replace(/\/$/, "");
const escH = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
async function sendMail(to, subject, lines, button) {
  if (!to) return { ok: false, error: "Nincs címzett." };
  if (!mailReady()) return { ok: false, error: "Az e-mail-küldés még nincs beállítva a Netlify-ban." };
  const html = `<!doctype html><html><body style="margin:0;background:#FAF8F6;font-family:Arial,Helvetica,sans-serif;color:#2B2B2B">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#FAF8F6;padding:24px 0"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #E6E3E0">
<tr><td style="height:5px;background:linear-gradient(90deg,#F5975A,#EF4130);background-color:#EF4130"></td></tr>
<tr><td style="padding:26px 28px 8px"><img src="${SITE()}/szolgaltatasok/logo.png" alt="Vista Plus Offices" width="160" style="display:block;height:auto;border:0"></td></tr>
<tr><td style="padding:8px 28px 4px"><h1 style="font-size:21px;margin:0 0 12px;line-height:1.3">${escH(subject)}</h1>
${lines.map((l) => `<p style="font-size:15px;line-height:1.55;margin:0 0 10px">${l}</p>`).join("")}</td></tr>
${button ? `<tr><td style="padding:10px 28px 6px"><a href="${escH(button.href)}" style="display:inline-block;background:#EF4130;color:#fff;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:999px;font-size:15px">${escH(button.label)}</a></td></tr>` : ""}
<tr><td style="padding:18px 28px 24px;font-size:12.5px;color:#7D7D7D">Vista Plus Offices · Ez egy automatikus üzenet.</td></tr>
</table></td></tr></table></body></html>`;
  const text = lines.map((l) => l.replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')).join("\n\n") + (button ? `\n\n${button.label}: ${button.href}` : "");
  if (msReady()) return sendMs(to, subject, html);
  const key = process.env.RESEND_API_KEY;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({ from: process.env.MAIL_FROM || "Vista Plus Offices <foglalas@vpo.hu>", to: [to], subject, html, text,
        ...(process.env.MAIL_REPLY_TO ? { reply_to: process.env.MAIL_REPLY_TO } : {}) }),
      signal: AbortSignal.timeout(10000),
    });
    return r.ok ? { ok: true } : { ok: false, error: "Resend: " + (await r.text()).slice(0, 300) };
  } catch (e) { return { ok: false, error: "Resend: " + e.message }; }
}

const E = process.env;
const msReady = () => !!(E.MS_TENANT_ID && E.MS_CLIENT_ID && E.MS_CLIENT_SECRET && E.MAIL_SENDER);
const mailReady = () => msReady() || !!E.RESEND_API_KEY;
let MSTOK = { t: "", x: 0 };
async function msToken() {
  if (MSTOK.t && MSTOK.x > Date.now() + 60000) return MSTOK.t;
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(E.MS_TENANT_ID)}/oauth2/v2.0/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: E.MS_CLIENT_ID, client_secret: E.MS_CLIENT_SECRET, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
    signal: AbortSignal.timeout(10000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error("Microsoft-belépés: " + (d.error_description || d.error || "HTTP " + r.status).split("\r")[0].slice(0, 200));
  MSTOK = { t: d.access_token, x: Date.now() + (+d.expires_in || 3000) * 1000 };
  return MSTOK.t;
}
async function sendMs(to, subject, html) {
  try {
    const tok = await msToken();
    const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(E.MAIL_SENDER)}/sendMail`, {
      method: "POST", headers: { authorization: "Bearer " + tok, "content-type": "application/json" },
      body: JSON.stringify({ message: { subject, body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }],
        ...(E.MAIL_REPLY_TO ? { replyTo: [{ emailAddress: { address: E.MAIL_REPLY_TO } }] } : {}) }, saveToSentItems: true }),
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) return { ok: true };
    const d = await r.json().catch(() => ({}));
    return { ok: false, error: "Microsoft 365: " + ((d.error && (d.error.code + " – " + d.error.message)) || "HTTP " + r.status).slice(0, 250) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ---------- Budapesti idő ----------
function tzOff(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Budapest", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
function bpMs(date, hm) { const [y, mo, d] = date.split("-").map(Number), [h, mi] = hm.split(":").map(Number);
  const g = Date.UTC(y, mo - 1, d, h, mi); return g - tzOff(g - tzOff(g)); }
const bpToday = (ms = Date.now()) => new Date(ms + tzOff(ms)).toISOString().slice(0, 10);

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const MONTH = /^\d{4}-\d{2}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

// ---------- Catering-emlékeztető: a tárgyalás előtti munkanap Catering dobozába kerül ----------
const pad2 = (n) => String(n).padStart(2, "0");
const isoD = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
function easter(y) { const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3),
  h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
  mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1; return Date.UTC(y, mo - 1, da); }
function holidays(y) { const e = easter(y), D = (ms) => isoD(new Date(ms));
  return new Set([`${y}-01-01`, `${y}-03-15`, `${y}-05-01`, `${y}-08-20`, `${y}-10-23`, `${y}-11-01`, `${y}-12-24`, `${y}-12-25`, `${y}-12-26`,
    D(e - 2 * 864e5), D(e + 864e5), D(e + 50 * 864e5)]); }
function workdaysBefore(date, n) { if (!(n > 0)) return date; let d = date; for (let i = 0; i < n; i++) d = prevWorkday(d); return d; }
function prevWorkday(date) { const d = new Date(date + "T12:00:00Z");
  for (let i = 0; i < 14; i++) { d.setUTCDate(d.getUTCDate() - 1); const w = d.getUTCDay(), s = isoD(d); if (w !== 0 && w !== 6 && !holidays(d.getUTCFullYear()).has(s)) return s; }
  return isoD(d); }
const ROOMNAMES = { panorama: "Panoráma terem", "kis-tav": "Kisterem távolabbi", nagy: "Nagyterem", "kis-koz": "Kisterem közelebbi" };
function cateringText(b) { const d = new Date(b.date + "T12:00:00Z");
  const day = d.toLocaleDateString("hu-HU", { month: "long", day: "numeric", weekday: "long", timeZone: "UTC" });
  return `${b.company || b.title || "foglalás"}${b.person ? " (" + b.person + ")" : ""}: ${b.catering} — tárgyalás: ${day} ${b.start}, ${ROOMNAMES[b.room] || b.room}`; }
async function noteEdit(store, date, fn, pre = "c") { const key = `${pre}/${date.slice(0, 7)}/${date}`; const v = (await store.get(key, { type: "json" })) || { items: [] };
  const items = fn((v.items || []).slice()); if (items.length) await store.setJSON(key, { items }); else await store.delete(key); }
// Régi és új állapot alapján frissíti a foglaláshoz tartozó emlékeztetőt (azonosító: cat-<foglalás id>)
async function syncCatering(store, user, oldB, oldId, newB, newId) {
  const lead = (b) => (b.cdays === undefined || b.cdays === null || b.cdays === "" ? 1 : +b.cdays);
  if (oldB && oldB.catering) await noteEdit(store, prevWorkday(oldB.date), (L) => L.filter((x) => x.id !== "cat-" + oldId), "n");
  const oldDay = oldB && oldB.catering ? workdaysBefore(oldB.date, lead(oldB)) : null, newDay = newB && newB.catering ? workdaysBefore(newB.date, lead(newB)) : null;
  const newItem = newDay ? { id: "cat-" + newId, t: cateringText(newB).slice(0, 400), done: false, by: user, ts: Date.now(), dby: "", bk: newId, kind: "catering", for: newB.date } : null;
  if (oldDay && (oldDay !== newDay || oldId !== newId)) await noteEdit(store, oldDay, (L) => L.filter((x) => x.id !== "cat-" + oldId));
  if (newDay) await noteEdit(store, newDay, (L) => { const i = L.findIndex((x) => x.id === newItem.id);
    if (i >= 0) { if (L[i].t === newItem.t) return L; L[i] = { ...newItem, ts: L[i].ts }; return L; } return L.concat(newItem); });
  return newDay;
}


// ---------- Közös foglalás-segédek (ügyfélportál, emlékeztető) ----------
const DAYRE = /^\d{4}-\d{2}-\d{2}$/, HMRE = /^([01]\d|2[0-3]):[0-5]\d$/;
const tMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
const bKey = (id) => `b/${id.slice(0, 7)}/${id}`;
const sameCo = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase() && String(a || "").trim() !== "";
function monthList(a, b) { const out = []; let [y, mo] = a.slice(0, 7).split("-").map(Number); const [y2, m2] = b.slice(0, 7).split("-").map(Number);
  while ((y < y2 || (y === y2 && mo <= m2)) && out.length < 24) { out.push(`${y}-${pad2(mo)}`); mo++; if (mo > 12) { mo = 1; y++; } } return out; }
async function monthBk(store, month) { const { blobs } = await store.list({ prefix: `b/${month}/` });
  return (await Promise.all(blobs.map(async (x) => { const v = await store.get(x.key, { type: "json" }); return v ? { ...v, id: x.key.split("/").pop() } : null; }))).filter(Boolean); }
function isWorkday(date) { const d = new Date(date + "T12:00:00Z"), w = d.getUTCDay(); return w !== 0 && w !== 6 && !holidays(d.getUTCFullYear()).has(date); }
const huDate = (date) => new Date(date + "T12:00:00Z").toLocaleDateString("hu-HU", { year: "numeric", month: "long", day: "numeric", weekday: "long", timeZone: "UTC" });
const whenTxt = (b) => `${huDate(b.date)}, ${b.start}–${b.end}`;
const roomTxt = (b) => ROOMNAMES[b.room] || b.room;
const respondLink = (id, email) => SITE() + "/ugyfel/?r=" + encodeURIComponent(signObj({ k: "r", i: id, e: email }));
const bookingLines = (b) => [`<b>${escH(roomTxt(b))}</b><br>${escH(whenTxt(b))}${b.title ? "<br>" + escH(b.title) : ""}`];
const H24 = 24 * 36e5;
const canCancel = (b, now = Date.now()) => b.src === "portal" && bpMs(b.date, b.start) > now && (bpMs(b.date, b.start) - now >= H24 || !!b.remAt);

async function notifyOffice(subject, b, extra) {
  if (!process.env.NOTIFY_EMAIL) return;
  await sendMail(process.env.NOTIFY_EMAIL, subject, [`${escH(b.company)}${b.person ? " (" + escH(b.person) + ")" : ""} · ${escH(b.own || "")}`, ...bookingLines(b), ...(extra || [])],
    { href: SITE() + "/foglalas/#d=" + b.date + "&v=nap", label: "Megnyitás a naptárban" });
}
async function cancelPortal(store, b, who, how) {
  await store.delete(bKey(b.id));
  await syncCatering(store, who, b, b.id, null, null);
  await sendMail(b.own, "Lemondtad a tárgyalófoglalást", [`Kedves ${escH(b.person || "Ügyfelünk")}!`, "A következő foglalásodat töröltük:", ...bookingLines(b), "Ha tévedésből történt, foglalj újra a portálon."],
    { href: SITE() + "/ugyfel/", label: "Ügyfélportál" });
  await notifyOffice("Ügyfél lemondta a foglalását" + (how ? " (" + how + ")" : ""), b);
}

// Óránként fut (reminder.mjs): a 24 órán belül kezdődő, ügyfélportálon rögzített foglalásokról emlékeztetőt küld.
export async function runReminders(store, now = Date.now()) {
  if (!mailReady()) return { skipped: "Az e-mail-küldés nincs beállítva." };
  let sent = 0, failed = 0;
  for (const month of [...new Set([bpToday(now).slice(0, 7), bpToday(now + 26 * 36e5).slice(0, 7)])]) {
    for (const b of await monthBk(store, month)) {
      if (!b.own || b.remAt || b.conf || (b.remFail || 0) >= 3) continue;
      const st = bpMs(b.date, b.start);
      if (st <= now || st - now > H24) continue;
      const r = await sendMail(b.own, "Emlékeztető: tárgyalófoglalás – jössz?", [`Kedves ${escH(b.person || "Ügyfelünk")}!`,
        "Emlékeztetünk, hogy a következő tárgyalófoglalásod 24 órán belül kezdődik:", ...bookingLines(b),
        "Kérjük, a gombra kattintva erősítsd meg, hogy jössz, vagy mondd le, ha mégsem lesz rá szükség."],
        { href: respondLink(b.id, b.own), label: "Jövök / lemondom" });
      const cur = await store.get(bKey(b.id), { type: "json" });
      if (!cur) continue;
      if (r.ok) { cur.remAt = now; delete cur.remFail; sent++; } else { cur.remFail = (cur.remFail || 0) + 1; failed++; }
      await store.setJSON(bKey(b.id), cur);
    }
  }
  return { sent, failed };
}

async function issueInvite(a, kind) {
  const rand = b64u(crypto.randomBytes(24)), now = Date.now();
  a.inv = sha(rand); a.invX = now + (kind === "reset" ? 2 : 14) * 864e5; a.invAt = now;
  const link = SITE() + "/ugyfel/?invite=" + b64u(a.email) + "." + rand;
  const hi = `Kedves ${escH(a.name || "Ügyfelünk")}!`;
  const r = kind === "reset"
    ? await sendMail(a.email, "Jelszó beállítása – Vista Plus Offices tárgyalófoglalás", [hi, "Új jelszó beállítását kérted a tárgyalófoglaló fiókodhoz. A gombra kattintva adhatod meg az új jelszót. A link 2 napig érvényes.", "Ha nem te kérted, nyugodtan hagyd figyelmen kívül ezt a levelet."], { href: link, label: "Új jelszó beállítása" })
    : await sendMail(a.email, "Meghívó – Vista Plus Offices tárgyalófoglalás", [hi, `Fiókot hoztunk létre számodra a(z) <b>${escH(a.company)}</b> nevében, amellyel tárgyalótermet foglalhatsz a Vista Plus Offices irodában.`,
        `Belépési e-mail-cím: <b>${escH(a.email)}</b>`, "A gombra kattintva állítsd be a jelszavadat. A link 14 napig érvényes."], { href: link, label: "Jelszó beállítása" });
  return { link, mailed: r.ok, mailError: r.ok ? "" : r.error };
}
const pubAcc = (a) => ({ email: a.email, company: a.company, name: a.name || "", active: !!a.hash, off: !!a.off, invX: a.invX || 0, created: a.created || 0, by: a.by || "", last: a.last || 0 });

// Nyilvános (belépés nélküli) kérések: jelszó beállítása, elfelejtett jelszó, emlékeztetőre adott válasz
async function publicRoutes(req, store, parts, url) {
  const m = req.method;
  if (parts[0] === "setpw" && m === "POST") {
    const body = await req.json().catch(() => ({}));
    const [eb, rand] = String(body.token || "").split(".");
    const pw = String(body.password || "");
    if (pw.length < 8) return json({ error: "A jelszó legalább 8 karakter legyen." }, 400);
    let email = ""; try { email = Buffer.from(eb || "", "base64url").toString(); } catch {}
    const a = email && (await store.get(accKey(email), { type: "json" }));
    if (!a || a.off || !a.inv || !rand || a.invX < Date.now() || sha(rand) !== a.inv)
      return json({ error: "A link lejárt vagy már felhasználták. A belépésnél az „Elfelejtett jelszó” gombbal kérhetsz újat." }, 400);
    a.hash = makeHash(pw); delete a.inv; delete a.invX; a.last = Date.now();
    await store.setJSON(accKey(email), a);
    return json({ token: sign(a.email, a.hash, "client"), email: a.email, role: "client", company: a.company, name: a.name || "" });
  }
  if (parts[0] === "forgot" && m === "POST") {
    const body = await req.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase();
    const a = /^[^@\s]+@[^@\s]+$/.test(email) && (await store.get(accKey(email), { type: "json" }));
    if (a && !a.off && !(a.invAt > Date.now() - 120000)) { await issueInvite(a, a.hash ? "reset" : "invite"); await store.setJSON(accKey(email), a); }
    await new Promise((r) => setTimeout(r, 400));
    return json({ ok: true });
  }
  if (parts[0] === "respond") {
    const body = m === "POST" ? await req.json().catch(() => ({})) : {};
    const o = readSigned(m === "POST" ? body.t : url.searchParams.get("t"));
    if (!o || o.k !== "r" || !ID.test(o.i || "")) return json({ error: "Érvénytelen link." }, 400);
    const b = await store.get(bKey(o.i), { type: "json" });
    if (!b || b.own !== o.e) return json({ error: "Ez a foglalás már nem létezik (lehet, hogy korábban lemondták)." }, 404);
    b.id = o.i;
    const past = bpMs(b.date, b.start) <= Date.now();
    const info = { room: roomTxt(b), date: b.date, start: b.start, end: b.end, company: b.company, title: b.title, person: b.person, conf: b.conf || "", past };
    if (m === "GET") return json(info);
    if (m === "POST") {
      if (past) return json({ error: "A foglalás már elkezdődött, ezért nem módosítható." }, 400);
      if (body.a === "yes") { const cur = { ...b }; delete cur.id; cur.conf = "yes"; cur.confAt = Date.now(); await store.setJSON(bKey(o.i), cur); return json({ ...info, conf: "yes" }); }
      if (body.a === "no") { await cancelPortal(store, b, o.e, "emlékeztetőből"); return json({ ...info, cancelled: true }); }
      return json({ error: "Hibás válasz." }, 400);
    }
  }
  return null;
}

// Ügyfélportál: csak saját cégük foglalásait látják részletesen, a többit „Foglalt” sávként
async function portalRoutes(req, store, parts, url, who) {
  const m = req.method, now = Date.now();
  const mine = (b) => sameCo(b.company, who.company);
  const view = (b) => mine(b)
    ? { id: b.id, room: b.room, date: b.date, start: b.start, end: b.end, title: b.title, person: b.person, note: b.note, plate: b.plate, catering: b.catering, src: b.src, own: b.own || "", conf: b.conf || "", remAt: b.remAt || 0, mine: true, canCancel: canCancel(b, now) }
    : { room: b.room, date: b.date, start: b.start, end: b.end };
  if (parts[1] === "bookings" && m === "GET") {
    const from = url.searchParams.get("from") || "", to = url.searchParams.get("to") || from;
    if (!DAYRE.test(from) || !DAYRE.test(to) || to < from || (new Date(to) - new Date(from)) > 62 * 864e5) return json({ error: "Hibás időszak." }, 400);
    const all = (await Promise.all(monthList(from, to).map((mo) => monthBk(store, mo)))).flat();
    return json(all.filter((b) => b.date >= from && b.date <= to).map(view));
  }
  if (parts[1] === "mine" && m === "GET") {
    const t = bpToday(now), d = new Date(t + "T12:00:00Z"); d.setUTCMonth(d.getUTCMonth() + 6);
    const all = (await Promise.all(monthList(t, isoD(d)).map((mo) => monthBk(store, mo)))).flat();
    return json(all.filter((b) => mine(b) && b.date >= t).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)).map(view));
  }
  if (parts[1] === "bookings" && m === "POST") {
    const r = await req.json().catch(() => ({}));
    const date = String(r.date || ""), start = String(r.start || ""), end = String(r.end || ""), room = String(r.room || "");
    if (!DAYRE.test(date) || !HMRE.test(start) || !HMRE.test(end)) return json({ error: "Hibás dátum vagy időpont." }, 400);
    if (!ROOMNAMES[room]) return json({ error: "Válassz termet." }, 400);
    if (tMin(end) <= tMin(start)) return json({ error: "A befejezésnek a kezdés után kell lennie." }, 400);
    if (!isWorkday(date) || tMin(start) < 8 * 60 || tMin(end) > 18 * 60) return json({ error: "Foglalni munkanapokon 8:00 és 18:00 között lehet." }, 400);
    if (bpMs(date, start) <= now) return json({ error: "Múltbeli időpontra nem lehet foglalni." }, 400);
    if (date > isoD(new Date(now + 180 * 864e5))) return json({ error: "Legfeljebb fél évre előre lehet foglalni." }, 400);
    const b = { room, date, start, end, company: who.company, title: String(r.title || "").slice(0, 200), person: String(r.person || who.name || "").slice(0, 200),
      note: String(r.note || "").slice(0, 1000), catering: String(r.catering || "").trim().slice(0, 1000), cdays: 1, rep: "", repEnd: "", repLast: false,
      plate: String(r.plate || "").toUpperCase().replace(/\s+/g, " ").trim().slice(0, 120), src: "portal", ext: "", ts: now, by: who.email, own: who.email, conf: "", remAt: 0 };
    if (!b.plate && b.company) b.plate = await clientPlates(store, b.company);
    if (bpMs(date, start) - now < H24) { b.conf = "yes"; b.confAt = now; b.remAt = now; }
    const month = date.slice(0, 7), list = await monthBk(store, month);
    if (list.some((x) => x.room === room && x.date === date && tMin(x.start) < tMin(end) && tMin(start) < tMin(x.end))) return json({ error: "Ez az időpont már foglalt. Válassz másikat." }, 409);
    const id = `${month}_${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    await store.setJSON(bKey(id), b);
    await syncCatering(store, who.email, null, null, b, id);
    const mail = await sendMail(who.email, "Visszaigazolás: tárgyalófoglalás", [`Kedves ${escH(b.person || "Ügyfelünk")}!`, "Rögzítettük a tárgyalófoglalásodat:", ...bookingLines(b),
      b.conf ? "A foglalás 24 órán belül kezdődik, ezért külön emlékeztetőt nem küldünk." : "A kezdés előtt 24 órával emlékeztetőt küldünk, amelyben megerősítheted vagy lemondhatod a foglalást. A portálon lemondani a kezdés előtt legalább 24 órával lehet."],
      { href: SITE() + "/ugyfel/", label: "Foglalásaim" });
    await notifyOffice("Új foglalás az ügyfélportálon", { ...b, id });
    return json({ ...view({ ...b, id }), mailed: mail.ok });
  }
  if (parts[1] === "bookings" && m === "DELETE" && ID.test(parts[2] || "")) {
    const b = await store.get(bKey(parts[2]), { type: "json" });
    if (!b || !mine(b)) return json({ error: "A foglalás már nem létezik." }, 404);
    b.id = parts[2];
    if (b.src !== "portal") return json({ error: "Ezt a foglalást az iroda rögzítette. Lemondáshoz kérjük, írj nekünk." }, 403);
    if (!canCancel(b, now)) return json({ error: "Lemondani csak a kezdés előtt legalább 24 órával lehet. Kérjük, ilyenkor írj nekünk." }, 403);
    await cancelPortal(store, b, who.email, "portálon");
    return json({ ok: true });
  }
  if (parts[1] === "confirm" && m === "POST" && ID.test(parts[2] || "")) {
    const b = await store.get(bKey(parts[2]), { type: "json" });
    if (!b || !mine(b)) return json({ error: "A foglalás már nem létezik." }, 404);
    b.conf = "yes"; b.confAt = now; await store.setJSON(bKey(parts[2]), b);
    return json(view({ ...b, id: parts[2] }));
  }
  return json({ error: "Ismeretlen kérés." }, 404);
}

// Admin: ügyfél-fiókok kezelése
async function accountRoutes(req, store, parts, user) {
  const m = req.method;
  if (m === "GET" && !parts[1]) {
    const { blobs } = await store.list({ prefix: "u/" });
    const L = await Promise.all(blobs.map((x) => store.get(x.key, { type: "json" })));
    return json(L.filter(Boolean).map(pubAcc).sort((a, b) => a.company.localeCompare(b.company, "hu") || a.email.localeCompare(b.email)));
  }
  if (m === "POST" && !parts[1]) {
    const body = await req.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase(), company = String(body.company || "").trim().slice(0, 200);
    if (!/^[^@\s/]+@[^@\s/]+\.[^@\s/]+$/.test(email) || email.length > 120) return json({ error: "Hibás e-mail-cím." }, 400);
    if (!company) return json({ error: "Hiányzik az ügyfél neve." }, 400);
    if ((users() || {})[email]) return json({ error: "Ez egy admin e-mail-cím." }, 400);
    if (await store.get(accKey(email), { type: "json" })) return json({ error: "Ehhez az e-mail-címhez már van fiók." }, 409);
    const a = { email, company, name: String(body.name || "").trim().slice(0, 120), created: Date.now(), by: user };
    const r = await issueInvite(a, "invite");
    await store.setJSON(accKey(email), a);
    return json({ ...pubAcc(a), ...r });
  }
  const email = decodeURIComponent(parts[1] || "").toLowerCase();
  const a = email && (await store.get(accKey(email), { type: "json" }));
  if (!a) return json({ error: "Nincs ilyen fiók." }, 404);
  if (m === "POST" && parts[2] === "invite") { const r = await issueInvite(a, a.hash ? "reset" : "invite"); await store.setJSON(accKey(email), a); return json({ ...pubAcc(a), ...r }); }
  if (m === "PUT") {
    const body = await req.json().catch(() => ({}));
    if (body.company !== undefined && String(body.company).trim()) a.company = String(body.company).trim().slice(0, 200);
    if (body.name !== undefined) a.name = String(body.name).trim().slice(0, 120);
    if (body.off !== undefined) a.off = !!body.off;
    await store.setJSON(accKey(email), a);
    return json(pubAcc(a));
  }
  if (m === "DELETE") { await store.delete(accKey(email)); return json({ ok: true }); }
  return json({ error: "Ismeretlen kérés." }, 404);
}

// Ügyfélhez mentett rendszámok (config.clients[].plates) – új foglalásnál automatikusan bekerülnek
async function clientPlates(store, company) {
  const n = String(company || "").trim().toLowerCase(); if (!n) return "";
  const cfg = (await store.get("config", { type: "json" })) || {};
  const c = (Array.isArray(cfg.clients) ? cfg.clients : []).find((x) => String(x.n || "").trim().toLowerCase() === n);
  return c && Array.isArray(c.plates) ? c.plates.join(", ").slice(0, 120) : "";
}

export default async (req) => {
  const store = getStore({ name: "rogzito", consistency: "strong" });
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const m = req.method;

  // GET /api/ping
  if (parts[0] === "ping") return json({ ok: true });

  // POST /api/login {email, password} – admin (APP_USERS) vagy ügyfél-fiók
  if (parts[0] === "login" && m === "POST") {
    const U = users();
    const body = await req.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase(), pw = body.password || "";
    if (U && U[email] && checkPw(U[email], pw)) return json({ token: sign(email, U[email]), email, role: "admin" });
    const a = /^[^@\s/]+@[^@\s/]+$/.test(email) ? await store.get(accKey(email), { type: "json" }) : null;
    if (a && a.hash && !a.off && checkPw(a.hash, pw)) {
      a.last = Date.now(); await store.setJSON(accKey(email), a);
      return json({ token: sign(email, a.hash, "client"), email, role: "client", company: a.company, name: a.name || "" });
    }
    await new Promise((r) => setTimeout(r, 600));
    if (!U && !a) return json({ error: "A belépés még nincs beállítva a szerveren (APP_USERS)." }, 503);
    return json({ error: "Hibás e-mail-cím vagy jelszó." }, 401);
  }

  const pub = await publicRoutes(req, store, parts, url);
  if (pub) return pub;

  // Minden más kéréshez belépés kell
  if (!users()) return json({ error: "A belépés még nincs beállítva a szerveren (APP_USERS).", auth: true }, 503);
  const who = await whoIs(req, store);
  if (!who) return json({ error: "Jelentkezz be újra.", auth: true }, 401);
  const user = who.email;
  if (parts[0] === "me") return json(who);

  if (who.role === "client") {
    if (parts[0] === "portal") return portalRoutes(req, store, parts, url, who);
    return json({ error: "Ez ügyfélfiók – a tárgyalófoglaláshoz az ügyfélportált használd: " + SITE() + "/ugyfel/", auth: true }, 403);
  }
  if (parts[0] === "accounts") return accountRoutes(req, store, parts, user);

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
  // Kézzel rögzített parkolás: p/<YYYY-MM>/<nap> = {items:[{id,t:rendszám,co:cég,tm:időpont,by,ts}]}
  if (parts[0] === "notes" || parts[0] === "catering" || parts[0] === "parking") {
    const PRE = { notes: "n", catering: "c", parking: "p" }[parts[0]];
    const DAY = /^\d{4}-\d{2}-\d{2}$/;
    if (m === "GET") {
      const from = url.searchParams.get("from") || "", to = url.searchParams.get("to") || from;
      if (!DAY.test(from) || !DAY.test(to) || to < from) return json({ error: "Hibás időszak." }, 400);
      const months = []; let [y, mo] = from.slice(0, 7).split("-").map(Number); const [y2, m2] = to.slice(0, 7).split("-").map(Number);
      while ((y < y2 || (y === y2 && mo <= m2)) && months.length < 24) { months.push(`${y}-${String(mo).padStart(2, "0")}`); mo++; if (mo > 12) { mo = 1; y++; } }
      const out = {};
      for (const month of months) {
        const { blobs } = await store.list({ prefix: `${PRE}/${month}/` });
        await Promise.all(blobs.map(async (b) => { const d = b.key.split("/").pop(); if (d >= from && d <= to) { const v = await store.get(b.key, { type: "json" }); if (v && v.items && v.items.length) out[d] = v.items; } }));
      }
      return json(out);
    }
    if (m === "PUT" && DAY.test(parts[1] || "")) {
      const body = await req.json().catch(() => ({}));
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 200).map((x) => ({
        id: String(x.id || "").slice(0, 40) || Math.random().toString(36).slice(2, 10), t: String(x.t || "").slice(0, 400), done: !!x.done,
        by: String(x.by || user).slice(0, 120), ts: +x.ts || Date.now(), dby: x.done ? String(x.dby || user).slice(0, 120) : "",
        ...(PRE === "p" ? { t: String(x.t || "").toUpperCase().replace(/\s+/g, " ").trim().slice(0, 40), co: String(x.co || "").trim().slice(0, 200), tm: String(x.tm || "").trim().slice(0, 40) } : {}),
        ...(x.bk ? { bk: String(x.bk).slice(0, 64), kind: String(x.kind || "").slice(0, 20), for: String(x.for || "").slice(0, 10) } : {}) })).filter((x) => x.t.trim());
      const key = `${PRE}/${parts[1].slice(0, 7)}/${parts[1]}`;
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
        person: String(r.person || "").slice(0, 200), note: String(r.note || "").slice(0, 1000), catering: String(r.catering || "").trim().slice(0, 1000), rep: String(r.rep || "").slice(0, 40), repEnd: /^\d{4}-\d{2}-\d{2}$/.test(r.repEnd || "") ? r.repEnd : "", repLast: !!r.repLast, cdays: Math.max(0, Math.min(10, r.cdays === undefined || r.cdays === "" ? 1 : parseInt(r.cdays, 10) || 0)), plate: String(r.plate || "").toUpperCase().replace(/\s+/g, " ").trim().slice(0, 120), src: String(r.src || "").slice(0, 40), ext: String(r.ext || "").slice(0, 120), ts: +r.ts || Date.now() } };
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
        if (!b.rep && prev.rep) { b.rep = prev.rep; b.repEnd = prev.repEnd || ""; b.repLast = !!prev.repLast; }
        if (prev.own) { // ügyfélportálos foglalás: megtartjuk a visszaigazolási állapotot; ha az időpont változik, újra emlékeztetünk
          b.own = prev.own; const same = prev.date === b.date && prev.start === b.start;
          b.conf = same ? prev.conf || "" : ""; b.remAt = same ? prev.remAt || 0 : 0; if (same && prev.confAt) b.confAt = prev.confAt; }
        if (parts[1].slice(0, 7) === month) id = parts[1]; else moveFrom = oldKey;
      }
      const x = clash(await loadMonth(month), b, parts[1]);
      if (x) return json({ error: `Ütközik egy másik foglalással: ${x.start}–${x.end} ${x.company || x.title || ""}`.trim(), clash: x }, 409);
      if (m === "POST") b.by = user;
      if (m === "POST" && !b.plate && b.company) b.plate = await clientPlates(store, b.company);
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

  // Futárrendelések: f/<YYYY-MM>/<id> = {date,carrier,company,person,addr,awb,orderedBy,note,cost,price,eid,ts,by}
  // Ha a rendelésnek van ára, automatikusan átkerül a Kiegészítő szolgáltatások tételei közé (e/<YYYY-MM>/<eid>, courier: <id>)
  if (parts[0] === "couriers") {
    const syncEntry = async (id, o, prevEid) => {
      const month = o.date.slice(0, 7);
      let eid = prevEid || null;
      if (eid && eid.slice(0, 7) !== month) { await store.delete(`e/${eid.slice(0, 7)}/${eid}`); eid = null; }
      if (!(o.price > 0) || !o.company) { if (eid) await store.delete(`e/${month}/${eid}`); return null; }
      eid = eid || `${month}_f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const prevE = await store.get(`e/${month}/${eid}`, { type: "json" });
      const entry = {
        date: o.date, company: o.company, person: o.person, cat: "Irodai", item: "Futárszolgálat" + (o.carrier ? " – " + o.carrier : ""),
        qty: 1, unit: o.price, total: o.price, cur: "HUF",
        note: [o.addr, o.awb ? "Fuvarlevél: " + o.awb : ""].filter(Boolean).join(" · ").slice(0, 500),
        ts: (prevE && prevE.ts) || Date.now(), by: o.by, courier: id,
      };
      await store.setJSON(`e/${month}/${eid}`, entry);
      return eid;
    };
    if (m === "GET") {
      const month = url.searchParams.get("month") || "";
      if (!MONTH.test(month)) return json({ error: "Hibás hónap." }, 400);
      const { blobs } = await store.list({ prefix: `f/${month}/` });
      const items = await Promise.all(blobs.map(async (b) => { const v = await store.get(b.key, { type: "json" }); return v ? { ...v, id: b.key.split("/").pop() } : null; }));
      return json(items.filter(Boolean));
    }
    if (m === "POST" || (m === "PUT" && parts[1] && ID.test(parts[1]))) {
      const r = await req.json().catch(() => ({}));
      const date = String(r.date || "").slice(0, 10), month = date.slice(0, 7);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !String(r.company || "").trim()) return json({ error: "Add meg a dátumot és az ügyfelet." }, 400);
      let id = null, prev = null, oldKey = null;
      if (m === "PUT") {
        oldKey = `f/${parts[1].slice(0, 7)}/${parts[1]}`;
        prev = await store.get(oldKey, { type: "json" });
        if (!prev) return json({ error: "A rendelés már nem létezik (lehet, hogy valaki törölte)." }, 404);
        if (parts[1].slice(0, 7) === month) { id = parts[1]; oldKey = null; }
      }
      id = id || `${month}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const num = (v) => { const n = Number(v); return v === "" || v == null || !isFinite(n) || n < 0 ? null : Math.round(n * 100) / 100; };
      const o = {
        date, carrier: String(r.carrier || "").trim().slice(0, 80), company: String(r.company).trim().slice(0, 200), person: String(r.person || "").trim().slice(0, 200),
        addr: String(r.addr || "").trim().slice(0, 400), awb: String(r.awb || "").trim().slice(0, 80), orderedBy: String(r.orderedBy || "").trim().slice(0, 80),
        note: String(r.note || "").trim().slice(0, 500), cost: num(r.cost), price: num(r.price),
        ts: (prev && prev.ts) || Date.now(), by: (prev && prev.by) || user, upd: user,
      };
      o.eid = await syncEntry(id, o, prev && prev.eid);
      await store.setJSON(`f/${month}/${id}`, o);
      if (oldKey) await store.delete(oldKey);
      return json({ ...o, id });
    }
    if (m === "DELETE" && parts[1] && ID.test(parts[1])) {
      const key = `f/${parts[1].slice(0, 7)}/${parts[1]}`, prev = await store.get(key, { type: "json" });
      if (prev && prev.eid) await store.delete(`e/${prev.eid.slice(0, 7)}/${prev.eid}`);
      await store.delete(key);
      return json({ ok: true });
    }
  }
  if (parts[0] === "courierconfig") {
    if (m === "GET") return json((await store.get("courierconfig", { type: "json" })) || {});
    if (m === "PUT") {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Hibás adat." }, 400);
      if (JSON.stringify(body).length > 50000) return json({ error: "Túl sok adat." }, 413);
      await store.setJSON("courierconfig", body);
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
        if (prev.courier) return json({ error: "Ez futárrendelésből jött tétel – a Futár oldalon módosítható." }, 409);
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
      const prev = await store.get(`e/${month}/${parts[1]}`, { type: "json" });
      if (prev && prev.courier) return json({ error: "Ez futárrendelésből jött tétel – a Futár oldalon törölhető." }, 409);
      await store.delete(`e/${month}/${parts[1]}`);
      return json({ ok: true });
    }
  }

  // Irodabérleti tájékoztatók (leadek): l/<id> = {...űrlapadatok}; alapértékek: leadconfig
  if (parts[0] === "leads") {
    if (m === "GET") {
      const { blobs } = await store.list({ prefix: "l/" });
      const items = await Promise.all(blobs.map(async (b) => { const v = await store.get(b.key, { type: "json" }); return v ? { id: b.key.slice(2), data: v } : null; }));
      return json(items.filter(Boolean));
    }
    if (m === "POST" || (m === "PUT" && parts[1] && ID.test(parts[1]))) {
      const body = await req.json().catch(() => null);
      const d = body && body.data;
      if (!d || typeof d !== "object" || Array.isArray(d)) return json({ error: "Hibás adat." }, 400);
      if (JSON.stringify(d).length > 100000) return json({ error: "Túl sok adat." }, 413);
      const id = m === "PUT" ? parts[1] : `L${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const prev = m === "PUT" ? await store.get("l/" + id, { type: "json" }) : null;
      const data = { ...d, by: (prev && prev.by) || user, upd: user };
      await store.setJSON("l/" + id, data);
      return json({ id, data });
    }
    if (m === "DELETE" && parts[1] && ID.test(parts[1])) { await store.delete("l/" + parts[1]); return json({ ok: true }); }
  }
  // Szerződések: k/<id> = {...szerződésadatok}; beállítások: contractconfig
  if (parts[0] === "contracts") {
    // Aktiválás: a szerződés "aktiv" lesz, az ügyfél felkerül / frissül a Kiegészítő szolgáltatások ügyféllistáján (config.clients)
    if (m === "POST" && parts[1] && ID.test(parts[1]) && parts[2] === "activate") {
      const key = "k/" + parts[1];
      const k = await store.get(key, { type: "json" });
      if (!k) return json({ error: "A szerződés nem található." }, 404);
      const body = await req.json().catch(() => ({}));
      const c = body && body.client || {};
      const n = String(c.n || "").trim().slice(0, 200);
      if (!n) return json({ error: "Add meg az ügyfél nevét." }, 400);
      const free = Math.max(0, Number(c.free) || 0);
      const cfg = (await store.get("config", { type: "json" })) || {};
      if (!Array.isArray(cfg.clients)) return json({ error: "Előbb nyisd meg egyszer a Kiegészítő szolgáltatások oldalt, hogy az ügyféllista létrejöjjön." }, 409);
      const norm = (s) => String(s || "").trim().toLowerCase();
      let cl = cfg.clients.find((x) => norm(x.n) === norm(n));
      const created = !cl;
      const prices = Array.isArray(c.prices) ? c.prices.slice(0, 200).map((p) => ({ i: String(p && p.i || "").trim().slice(0, 200), u: Number(p && p.u), cur: p && p.cur === "EUR" ? "EUR" : "HUF" })).filter((p) => p.i && isFinite(p.u) && p.u >= 0) : null;
      const people = Array.isArray(c.people) ? [...new Set(c.people.map((x) => String(x || "").trim().slice(0, 120)).filter(Boolean))].slice(0, 50) : null;
      if (cl) { cl.eur = !!c.eur; cl.free = free; if (prices) cl.prices = prices; if (people) cl.people = [...new Set([...(cl.people || []), ...people])]; }
      else { cl = { n, eur: !!c.eur, free, note: "", prices: prices || [], people: people || [] }; cfg.clients.push(cl); if (Array.isArray(cfg.quick) && !cfg.quick.some((q) => norm(q) === norm(n))) cfg.quick.push(n); }
      await store.setJSON("config", cfg);
      const data = { ...k, status: "aktiv", activatedAt: new Date().toISOString(), activatedBy: user, clientName: cl.n, upd: user };
      await store.setJSON(key, data);
      return json({ id: parts[1], data, client: cl, created });
    }
    if (m === "GET") {
      const { blobs } = await store.list({ prefix: "k/" });
      const items = await Promise.all(blobs.map(async (b) => { const v = await store.get(b.key, { type: "json" }); return v ? { id: b.key.slice(2), data: v } : null; }));
      return json(items.filter(Boolean));
    }
    if (m === "POST" || (m === "PUT" && parts[1] && ID.test(parts[1]))) {
      const body = await req.json().catch(() => null);
      const d = body && body.data;
      if (!d || typeof d !== "object" || Array.isArray(d)) return json({ error: "Hibás adat." }, 400);
      if (JSON.stringify(d).length > 100000) return json({ error: "Túl sok adat." }, 413);
      const id = m === "PUT" ? parts[1] : `K${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const prev = m === "PUT" ? await store.get("k/" + id, { type: "json" }) : null;
      const data = { ...d, by: (prev && prev.by) || user, upd: user };
      // Szerződésszám: O-ÉÉÉÉ-001 (iroda), VO-ÉÉÉÉ-001 (virtuális iroda), MR-ÉÉÉÉ-001 (tárgyaló) – típusonként és évente folyamatos
      if (!String(data.no || "").trim() && !(prev && prev.no)) {
        const pre = { iroda: "O", vo: "VO", targyalo: "MR" }[data.kind] || "O", yr = String(data.date || "").slice(0, 4).match(/^\d{4}$/) ? String(data.date).slice(0, 4) : String(new Date().getFullYear());
        const { blobs } = await store.list({ prefix: "k/" }); let max = 0;
        const rx = new RegExp("^" + pre + "-" + yr + "-(\\d+)$");
        for (const bl of blobs) { const v = await store.get(bl.key, { type: "json" }); const mm = v && String(v.no || "").match(rx); if (mm) max = Math.max(max, +mm[1]); }
        data.no = `${pre}-${yr}-${String(max + 1).padStart(3, "0")}`;
      } else if (!String(data.no || "").trim() && prev && prev.no) data.no = prev.no;
      await store.setJSON("k/" + id, data);
      return json({ id, data });
    }
    if (m === "DELETE" && parts[1] && ID.test(parts[1])) { await store.delete("k/" + parts[1]); return json({ ok: true }); }
  }
  if (parts[0] === "contractconfig") {
    if (m === "GET") return json((await store.get("contractconfig", { type: "json" })) || {});
    if (m === "PUT") {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Hibás adat." }, 400);
      await store.setJSON("contractconfig", body);
      return json({ ok: true });
    }
  }
  if (parts[0] === "leadconfig") {
    if (m === "GET") return json((await store.get("leadconfig", { type: "json" })) || {});
    if (m === "PUT") {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Hibás adat." }, 400);
      await store.setJSON("leadconfig", body);
      return json({ ok: true });
    }
  }

  return json({ error: "Ismeretlen kérés." }, 404);
};

export const config = { path: "/api/*" };

// Nooby-server-logger: one Durable Object holds live sessions (memory) + bans (storage).
// Events are only executed by script clients that poll /sync; nothing here controls arbitrary Roblox servers.
const TTL = 120000, EV_TTL = 120000, MAXL = 500;
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const eq = (a, b) => { a = String(a || ""); b = String(b || ""); let d = a.length ^ b.length; for (let i = 0; i < b.length; i++) d |= (a.charCodeAt(i) || 0) ^ b.charCodeAt(i); return !!b && d === 0; };
const has = (list, uid, un) => String(list || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean).some(t => t === String(uid) || t === String(un || "").toLowerCase());
const OIDS = env => env.OWNER_IDS || "Kingbaconnon19";
// A key is only required when the OWNER_KEY / COOWNER_KEY secret exists; otherwise the username / ID alone decides.
const roleOf = (env, uid, un, k) => {
  const ok = (key, ids) => has(ids, uid, un) && (!key || eq(k, key));
  return ok(env.OWNER_KEY, OIDS(env)) ? "owner" : ok(env.COOWNER_KEY, env.COOWNER_IDS) ? "coowner" : null;
};

export default {
  async fetch(req, env) {
    if (req.method !== "POST") return new Response("ok");
    return env.HUB.get(env.HUB.idFromName("g")).fetch(req);
  },
};

export class Hub {
  constructor(state, env) {
    this.st = state;
    this.envv = env;
    this.s = new Map();   // uid -> session
    this.q = new Map();   // uid -> events
    this.ver = 1;
    this.n = 1;
    this.bans = null;
  }
  sweep(now) {
    for (const [u, s] of this.s) if (now - s.t > TTL) { this.s.delete(u); this.ver++; }
    for (const [u, l] of this.q) { const f = l.filter(e => now - e.t < EV_TTL); f.length ? this.q.set(u, f) : this.q.delete(u); }
  }
  async fetch(req) {
    const now = Date.now();
    let b; try { b = await req.json(); } catch { return J({ err: "bad" }, 400); }
    const path = new URL(req.url).pathname, uid = String(b.u || "").replace(/\D/g, "").slice(0, 16);
    if (!uid) return J({ err: "uid" }, 400);
    if (!this.bans) this.bans = (await this.st.storage.get("bans")) || {};
    this.sweep(now);

    if (path === "/act") {
      const role = roleOf(this.envv, uid, b.n, b.k);
      if (!role) return J({ err: "denied" }, 403);
      const x = String(b.x || "").replace(/\D/g, ""), t = b.t;
      if (!x || !["kill", "deanimate", "kick", "ban", "unban"].includes(t)) return J({ err: "bad" }, 400);
      const tgt = this.s.get(x);
      if (tgt && tgt.role && (role !== "owner" || tgt.role === "owner")) return J({ err: "protected" }, 403);
      if (has(OIDS(this.envv), x, tgt && tgt.un) || (role !== "owner" && has(this.envv.COOWNER_IDS, x, tgt && tgt.un))) return J({ err: "protected" }, 403);
      if (t === "unban") { delete this.bans[x]; await this.st.storage.put("bans", this.bans); return J({ ok: 1 }); }
      if (t === "ban") { this.bans[x] = { by: uid, t: now }; await this.st.storage.put("bans", this.bans); }
      else if (!tgt) return J({ err: "offline" }, 404);
      const ev = { id: this.n++, k: t === "ban" ? "kick" : t, f: b.n || uid, r: role, t: now };
      if (tgt || t === "ban") { const l = this.q.get(x) || []; l.push(ev); this.q.set(x, l); }
      return J({ ok: 1 });
    }

    // /sync: heartbeat + ack + list + count + events + moderator presence in one round trip
    if (this.bans[uid]) return J({ ban: 1 });
    if (b.off) { if (this.s.delete(uid)) this.ver++; return J({ ok: 1 }); }
    const un = String(b.n || "").slice(0, 40), role = roleOf(this.envv, uid, un, b.k);
    const old = this.s.get(uid), jid = String(b.j || "").slice(0, 64);
    if (!old || old.jid !== jid || old.role !== role) this.ver++;
    this.s.set(uid, { uid, un, dn: String(b.d || un).slice(0, 40), pid: String(b.p || "").slice(0, 20), jid, role, t: now });
    if (Array.isArray(b.a) && b.a.length) { const l = this.q.get(uid); if (l) { const f = l.filter(e => !b.a.includes(e.id)); f.length ? this.q.set(uid, f) : this.q.delete(uid); } }
    const r = { c: this.s.size, v: this.ver, e: this.q.get(uid) || [], m: {}, r: role };
    for (const s of this.s.values()) if (s.role) r.m[s.role === "owner" ? "o" : "c"] = [s.jid, s.un];
    if (b.w && b.v !== this.ver) { r.l = []; for (const s of this.s.values()) { if (r.l.length >= MAXL) break; r.l.push([s.uid, s.un, s.dn, s.pid, s.jid]); } }
    return J(r);
  }
}

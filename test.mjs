// Local logic test for worker.js — runs the real Worker code against Node's
// built-in SQLite through a small D1-shaped shim. Not part of the deploy.
// Run: node test.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "./worker.js";

const db = new DatabaseSync(":memory:");
db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));

class Stmt {
  constructor(sql) { this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async run() {
    const r = db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
  }
  async all() { return { success: true, results: db.prepare(this.sql).all(...this.args) }; }
  async first() { return db.prepare(this.sql).get(...this.args) ?? null; }
}
const DB = { prepare: (sql) => new Stmt(sql) };
const env = { DB, ADMIN_KEY: "test-owner-key" };
const ctx = { waitUntil() {} };

let failures = 0;
function check(name, cond) {
  console.log((cond ? "PASS" : "FAIL") + "  " + name);
  if (!cond) failures++;
}
async function call(method, path, { body, headers = {}, ip = "1.2.3.4" } = {}) {
  const req = new Request("https://board.test" + path, {
    method,
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(req, env, ctx);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// 1. Empty board lists clean.
let r = await call("GET", "/posts");
check("empty list", r.status === 200 && r.data.posts.length === 0);

// 2. A plain post goes up and is listed, without its email anywhere in the public view.
r = await call("POST", "/posts", { body: { name: "Robert B.", email: "robert@example.com", message: "Heard the band tracks. Chicago '88 — what a night." } });
check("post accepted", r.status === 200 && r.data.ok && r.data.post.badge === 0);
r = await call("GET", "/posts");
check("post listed", r.data.posts.length === 1 && r.data.posts[0].name === "Robert B.");
check("email never public", !("email" in r.data.posts[0]) && JSON.stringify(r.data).indexOf("robert@example.com") === -1);

// 3. Honeypot: filled trap field returns success but stores nothing.
r = await call("POST", "/posts", { body: { name: "Bot", message: "cheap links", website: "http://spam.example" } });
check("honeypot fake-accepts", r.status === 200 && r.data.ok === true);
r = await call("GET", "/posts");
check("honeypot stored nothing", r.data.posts.length === 1);

// 4. Empty name/message rejected; bad email rejected with guidance.
r = await call("POST", "/posts", { body: { name: "", message: "hi" } });
check("empty name rejected", r.status === 400);
r = await call("POST", "/posts", { body: { name: "A", email: "not-an-email", message: "hi" } });
check("bad email rejected", r.status === 400);

// 5. Badge flow: issue a code, claim it, second claim of the same code fails soft.
r = await call("GET", "/badge/issue", { ip: "9.9.9.9" });
check("code issued", r.status === 200 && /^JAI-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(r.data.code || ""));
const code = r.data.code;
r = await call("POST", "/posts", { body: { name: "Winner", message: "Four searches deep!", code } });
check("badge claim sticks", r.status === 200 && r.data.post.badge === 1);
r = await call("POST", "/posts", { body: { name: "Copycat", message: "me too", code }, ip: "8.8.8.8" });
check("spent code posts without badge + explains", r.status === 200 && r.data.post.badge === 0 && !!r.data.badge_error);

// 6. Pace limit: 5 posts per 10 min per IP pass, the 6th is refused.
for (let i = 0; i < 5; i++) {
  r = await call("POST", "/posts", { body: { name: "Fast", message: "post " + i }, ip: "5.5.5.5" });
}
check("five quick posts pass", r.status === 200);
r = await call("POST", "/posts", { body: { name: "Fast", message: "one too many" }, ip: "5.5.5.5" });
check("sixth is pace-limited", r.status === 429);

// 7. Owner tools: hide needs the key, hides from the public list, export sees all incl. emails.
r = await call("GET", "/posts");
const someId = r.data.posts[0].id;
r = await call("POST", "/admin/hide", { body: { id: someId } });
check("hide without key refused", r.status === 403);
r = await call("POST", "/admin/hide", { body: { id: someId }, headers: { "X-Admin-Key": "test-owner-key" } });
check("hide with key works", r.status === 200);
const after = await call("GET", "/posts");
check("hidden post off the board", !after.data.posts.some((p) => p.id === someId));
r = await call("GET", "/admin/export", { headers: { "X-Admin-Key": "test-owner-key" } });
check("export includes emails", r.status === 200 && JSON.stringify(r.data).indexOf("robert@example.com") > -1);
r = await call("POST", "/admin/restore", { body: { id: someId }, headers: { "X-Admin-Key": "test-owner-key" } });
const restored = await call("GET", "/posts");
check("restore brings it back", restored.data.posts.some((p) => p.id === someId));

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures ? 1 : 0);

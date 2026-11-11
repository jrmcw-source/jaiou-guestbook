// jaiou-guestbook — the guestbook board for jaiou.com, running on Cloudflare Workers + D1.
// One file, no dependencies. Jason's board rules are the spec:
//   - Posts publish the moment they are written. No approval queue, ever.
//   - A guest needs only a name and something to say. Email is optional and is never shown on the board.
//   - The only spam defenses are invisible ones (a trap field and a pace limit) — nothing piles steps in front of a guest.
//   - The owner holds a key that can hide a post, restore it, and export the poster list.
//
// Routes:
//   GET  /posts          -> public list of visible posts (newest first). Emails are never included.
//   POST /posts          -> add a post. JSON: {name, message, email?, code?, website?, parent_id?}
//                           "parent_id" makes the post a reply, nested under the post it answers.
//                           "website" is the honeypot: humans never see it; if it is filled, the post is silently dropped.
//                           "code" is a McWoogle badge claim code; a good code stamps the post with the jAIou badge.
//   GET  /badge/issue    -> mint a one-time badge claim code (the McWoogle win screen calls this).
//   POST /admin/hide     -> owner only (x-admin-key header). JSON: {id}
//   POST /admin/restore  -> owner only. JSON: {id}
//   GET  /admin/export   -> owner only. All posts incl. emails; add ?format=csv for a spreadsheet file.
//   GET  /health         -> {ok:true}
//
// Secrets/vars: DB (D1 binding), ADMIN_KEY (secret), RESEND_API_KEY (secret, optional),
//               NOTIFY_TO (var, optional — defaults to Jason's Gmail).

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L — codes get read aloud and typed by hand
const MAX_POSTS_PER_10_MIN = 5;
const MAX_CODES_PER_DAY = 10;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newClaimCode() {
  const pick = () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  const group = () => Array.from({ length: 4 }, pick).join("");
  return `JAI-${group()}-${group()}`;
}

function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

async function notify(env, post) {
  // One email to Jason per new post. Runs only when the sending key is set;
  // the board never waits on it and never fails because of it.
  if (!env.RESEND_API_KEY) return;
  const to = env.NOTIFY_TO || "jrmcwhirter2@gmail.com";
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "jaiou Guestbook <onboarding@resend.dev>",
        to: [to],
        subject: post.parent_id ? `New guestbook reply from ${post.name}` : `New guestbook post from ${post.name}`,
        text:
          `${post.name} just ${post.parent_id ? "replied" : "posted"} on the jaiou.com guestbook` +
          (post.badge ? " (with a jAIou badge claim — it checked out)" : "") +
          `:\n\n${post.message}\n\n—\nSee it at https://jaiou.com/guestbook.html`,
      }),
    });
  } catch (_) {
    // A failed notification is a lost email, never a lost post.
  }
}

async function listPosts(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, message, badge, created_at, parent_id FROM posts WHERE hidden = 0 ORDER BY id DESC LIMIT 500"
  ).all();
  return json({ posts: results });
}

async function addPost(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "That post did not arrive in one piece. Try again." }, 400);
  }

  // Honeypot: the form carries a field humans never see. Filled means a bot —
  // answer as if it worked and keep nothing.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return json({ ok: true });
  }

  const name = cleanText(body.name, 40);
  const message = cleanText(body.message, 1000);
  let email = cleanText(body.email, 120).toLowerCase();
  if (!name || !message) {
    return json({ error: "A name and a message are all it takes — one of those came up empty." }, 400);
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: "That email address does not look complete. It is optional — you can clear it and post without one." }, 400);
  }
  if (!email) email = null;

  // A reply names the post it answers. That post has to be on the board —
  // a missing or hidden target refuses the reply with the way out in the message.
  let parentId = null;
  if (body.parent_id !== undefined && body.parent_id !== null && body.parent_id !== "") {
    parentId = Number(body.parent_id);
    if (!Number.isInteger(parentId) || parentId <= 0) {
      return json({ error: "That reply lost track of the post it answers. Cancel the reply and try once more." }, 400);
    }
    const parent = await env.DB.prepare(
      "SELECT id FROM posts WHERE id = ? AND hidden = 0"
    ).bind(parentId).first();
    if (!parent) {
      return json({ error: "The post you are answering is no longer on the board. Cancel the reply and yours can still go up on its own." }, 400);
    }
  }

  const ipHash = await sha256Hex(request.headers.get("CF-Connecting-IP") || "unknown");
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM posts WHERE ip_hash = ? AND created_at > datetime('now', '-10 minutes')"
  ).bind(ipHash).first();
  if (recent && recent.n >= MAX_POSTS_PER_10_MIN) {
    return json({ error: "Easy there — that is a lot of posts in a row. Give it a few minutes." }, 429);
  }

  // Badge claim: a good code stamps the post and is spent. A bad code never blocks the post.
  let badge = 0;
  let badgeError = null;
  const code = cleanText(body.code, 20).toUpperCase();
  if (code) {
    const codeHash = await sha256Hex(code);
    const row = await env.DB.prepare(
      "SELECT id FROM badge_codes WHERE code_hash = ? AND used = 0 AND created_at > datetime('now', '-30 days')"
    ).bind(codeHash).first();
    if (row) {
      badge = 1;
      await env.DB.prepare("UPDATE badge_codes SET used = 1, used_at = datetime('now') WHERE id = ?").bind(row.id).run();
    } else {
      badgeError = "That claim code did not check out, so the post went up without the badge. Winning codes come from the McWoogle win screen.";
    }
  }

  const result = await env.DB.prepare(
    "INSERT INTO posts (name, email, message, badge, ip_hash, parent_id) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(name, email, message, badge, ipHash, parentId).run();

  const post = { id: result.meta.last_row_id, name, message, badge, parent_id: parentId, created_at: new Date().toISOString() };
  ctx.waitUntil(notify(env, post));
  return json({ ok: true, post, ...(badgeError ? { badge_error: badgeError } : {}) });
}

async function issueCode(request, env) {
  const ipHash = await sha256Hex(request.headers.get("CF-Connecting-IP") || "unknown");
  const today = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM badge_codes WHERE ip_hash = ? AND created_at > datetime('now', '-1 day')"
  ).bind(ipHash).first();
  if (today && today.n >= MAX_CODES_PER_DAY) {
    return json({ error: "Plenty of codes for one day." }, 429);
  }
  // Collisions are near-impossible, but a duplicate hash would throw — retry a few times.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newClaimCode();
    try {
      await env.DB.prepare("INSERT INTO badge_codes (code_hash, ip_hash) VALUES (?, ?)")
        .bind(await sha256Hex(code), ipHash).run();
      return json({ code });
    } catch (_) {
      // hash collision — mint another
    }
  }
  return json({ error: "Could not mint a code just now. The badge is still yours — try once more." }, 500);
}

function isOwner(request, env) {
  return env.ADMIN_KEY && request.headers.get("X-Admin-Key") === env.ADMIN_KEY;
}

async function adminSetHidden(request, env, hidden) {
  if (!isOwner(request, env)) return json({ error: "That needs the owner key." }, 403);
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "Missing post id." }, 400);
  }
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return json({ error: "Missing post id." }, 400);
  await env.DB.prepare("UPDATE posts SET hidden = ? WHERE id = ?").bind(hidden, id).run();
  return json({ ok: true, id, hidden });
}

async function adminExport(request, env, url) {
  if (!isOwner(request, env)) return json({ error: "That needs the owner key." }, 403);
  const { results } = await env.DB.prepare(
    "SELECT id, parent_id, name, email, message, badge, hidden, created_at FROM posts ORDER BY id ASC"
  ).all();
  if (url.searchParams.get("format") === "csv") {
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [
      "id,parent_id,name,email,message,badge,hidden,created_at",
      ...results.map((r) => [r.id, r.parent_id, r.name, r.email, r.message, r.badge, r.hidden, r.created_at].map(esc).join(",")),
    ].join("\n");
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": 'attachment; filename="guestbook-posters.csv"',
        ...corsHeaders(),
      },
    });
  }
  return json({ posts: results });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/posts")) return await listPosts(env);
      if (request.method === "POST" && url.pathname === "/posts") return await addPost(request, env, ctx);
      if (request.method === "GET" && url.pathname === "/badge/issue") return await issueCode(request, env);
      if (request.method === "POST" && url.pathname === "/admin/hide") return await adminSetHidden(request, env, 1);
      if (request.method === "POST" && url.pathname === "/admin/restore") return await adminSetHidden(request, env, 0);
      if (request.method === "GET" && url.pathname === "/admin/export") return await adminExport(request, env, url);
      if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });
      return json({ error: "Nothing lives at that address." }, 404);
    } catch (err) {
      return json({ error: "The board stumbled. The post was not saved — try once more.", detail: String(err && err.message || err) }, 500);
    }
  },
};

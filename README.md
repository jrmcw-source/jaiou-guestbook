# jaiou Guestbook

A guestbook that a man owns outright — no vendor, no submission caps, no monthly bill.
It is the board on [jaiou.com/guestbook](https://jaiou.com/guestbook.html), built to replace a
free third-party widget that started warning about limits before the board had any real traffic.

It runs on Cloudflare's free tier: one Worker (the code in `worker.js`) and one D1 database
(Cloudflare's hosted SQLite). The same account runs the McWoogle search relay, the same way —
small programs that wake up, answer, and go back to sleep, at $0.

## The board rules it was built to

- **Posts publish the moment they are written.** No approval queue. The owner sweeps up after
  the fact, when he feels like it — that is a product decision, written into the design, not a
  missing feature.
- **A guest needs a name and something to say.** Email is optional, is never shown on the board,
  and exists for one reason: so the owner has his own poster list — for a reply, or a contest
  someday. Required fields just collect fake addresses.
- **Spam defense stays invisible.** A trap field no human ever sees, and a pace limit
  (5 posts per 10 minutes per address). Nothing — no account, no captcha — piles steps in
  front of a guest who just wants to say hello.
- **The owner holds a key.** It hides a post (nothing is ever deleted), restores it, and exports
  the full poster list, emails included, as JSON or CSV. That export *is* the guestbook register.

## The badge circuit

McWoogle (the companion joke-that-works search engine) awards a **jAIou badge** to anyone who
searches four deep. The win screen asks this board's `GET /badge/issue` for a one-time claim
code — codes are minted as `JAI-XXXX-XXXX`, stored only as SHA-256 hashes, and good for 30 days.
The winner types the code into the guestbook form; the board checks it, spends it, and stamps
the post with the badge art (`jaiou-badge.svg`, the same art McWoogle hands out). A code that
doesn't check out never blocks the post — it just goes up without the badge, with a plain
explanation. Real enough for fun, which is the correct security level for a guestbook badge.

## Files

| File | What it is |
|---|---|
| `worker.js` | The whole backend. One file, no dependencies. |
| `schema.sql` | The D1 schema — `posts` and `badge_codes`, with the reasoning in comments. |
| `guestbook.js` | The board front end that lives on the guestbook page. Renders poster text with `textContent` only — nothing a guest types is ever run as markup. |
| `snippet.html` | The markup that sits on the page where the old widget used to be. |
| `style-additions.css` | The board's styles, merged into the site's `style.css`. |
| `jaiou-badge.svg` | The badge art, shared with McWoogle. |
| `test.mjs` | Logic tests: runs the real Worker against Node's built-in SQLite through a D1-shaped shim. 18 checks — posting, the honeypot, the pace limit, the badge claim/spend cycle, owner hide/restore/export, and that an email address never appears in a public response. |

## Run the tests

```
node test.mjs
```

## Deploy notes

1. Create the D1 database, run `schema.sql` in its console.
2. Create the Worker from `worker.js`; bind the database as `DB`.
3. Set the `ADMIN_KEY` secret (the owner's key) and, for post notifications, `RESEND_API_KEY`.
   Each new post emails the owner — the thing the old widget never did.
4. On the site, swap the widget block for `snippet.html`, add `guestbook.js` and the badge art,
   and merge the styles.

## Design notes

- **Nothing is ever deleted.** Hiding is a flag. The record is the protection — the same rule
  the owner runs his shop software by.
- **Emails are data, not display.** They are stored once, shown nowhere, and leave the system
  only through the owner's own export.
- **Failure is soft everywhere it can be.** A dead notification service loses an email, never a
  post. A bad badge code loses a stamp, never a post. A bot in the trap field gets a cheerful
  success message and stores nothing at all.

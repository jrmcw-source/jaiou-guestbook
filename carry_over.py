#!/usr/bin/env python3
"""Carry the Common Ninja guestbook export into the new board's D1 table.

Reads the CSV the owner exported from Common Ninja, and inserts every
comment as a post with its ORIGINAL date, in chronological order, so the
board shows the conversation exactly as it happened. Words are carried
verbatim; only surrounding whitespace is trimmed. Emails were empty for
every poster in the export.

Usage: carry_over.py PATH_TO_CSV
Prints names, dates and the new row ids only — never message bodies.
"""
import csv
import json
import sys
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

ACCOUNT = "2b4e817dee2efabb13a0cfdb3d2a29b4"
DB = "340d67da-3d26-43c7-8cb0-9caa09eabd57"
URL = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{DB}/query"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused")


def d1(sql, params):
    body = json.dumps({"sql": sql, "params": params}).encode()
    req = urllib.request.Request(URL, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
    with urllib.request.build_opener(NoRedirect()).open(req, timeout=90) as r:
        return read_json_response(r)


def parse_author(field):
    parts = {}
    for chunk in field.split(";"):
        if "<=>" in chunk:
            k, v = chunk.split("<=>", 1)
            parts[k.strip()] = v.strip()
    return parts.get("name", ""), parts.get("email", "") or None


def main():
    with open(sys.argv[1], newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    posts = []
    for row in rows:
        name, email = parse_author(row["author"])
        dt = datetime.fromisoformat(row["date"].replace("Z", "+00:00")).astimezone(timezone.utc)
        posts.append({
            "name": name,
            "email": email,
            "message": row["text"].strip(),
            "created_at": dt.strftime("%Y-%m-%d %H:%M:%S"),
        })
    posts.sort(key=lambda p: p["created_at"])
    print(f"{len(posts)} posts to carry over")
    for p in posts:
        d = d1(
            "INSERT INTO posts (name, email, message, badge, hidden, ip_hash, created_at) VALUES (?, ?, ?, 0, 0, NULL, ?)",
            [p["name"], p["email"], p["message"], p["created_at"]],
        )
        assert d.get("success"), d.get("errors")
        meta = d["result"][0]["meta"]
        print(f"  id {meta['last_row_id']}: {p['name']} @ {p['created_at']} UTC")


if __name__ == "__main__":
    main()

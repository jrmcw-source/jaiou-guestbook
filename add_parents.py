#!/usr/bin/env python3
"""Add posts.parent_id to the live guestbook D1 and restore the reply links
of the carried-over Common Ninja thread (ids assigned by carry_over.py).

Mapping (D1 id -> parent D1 id), from the Common Ninja export's own
parentCommentId chain: 7->6, 8->7, 9->8, 10->9, 12->11. Opening posts
(4, 5, 6, 11) keep NULL. Prints the resulting tree for verification.
"""
import json
import sys
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

ACCOUNT = "2b4e817dee2efabb13a0cfdb3d2a29b4"
DB = "340d67da-3d26-43c7-8cb0-9caa09eabd57"
URL = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{DB}/query"
PARENTS = {7: 6, 8: 7, 9: 8, 10: 9, 12: 11}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused")


def d1(sql, params=None):
    body = json.dumps({"sql": sql, "params": params or []}).encode()
    req = urllib.request.Request(URL, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
    with urllib.request.build_opener(NoRedirect()).open(req, timeout=90) as r:
        return read_json_response(r)


def main():
    cols = d1("SELECT name FROM pragma_table_info('posts')")["result"][0]["results"]
    names = [c["name"] for c in cols]
    print("columns before:", names)
    if "parent_id" not in names:
        d = d1("ALTER TABLE posts ADD COLUMN parent_id INTEGER")
        assert d.get("success"), d.get("errors")
        print("parent_id column added")
    for child, parent in PARENTS.items():
        d = d1("UPDATE posts SET parent_id = ? WHERE id = ?", [parent, child])
        assert d.get("success"), d.get("errors")
        assert d["result"][0]["meta"]["changes"] == 1, (child, d["result"][0]["meta"])
    rows = d1("SELECT id, parent_id, name, created_at FROM posts ORDER BY id ASC")["result"][0]["results"]
    for r in rows:
        print(f"  id {r['id']}: parent={r['parent_id']} {r['name']} @ {r['created_at']}")


if __name__ == "__main__":
    main()

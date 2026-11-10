// guestbook.js — the board front end for jaiou.com/guestbook.html.
// Talks to the jaiou-guestbook Worker. All poster text is rendered with
// textContent — nothing a guest types is ever run as markup.
(function () {
  var API = "https://jaiou-guestbook.jrmcw.workers.dev";
  var postsBox = document.getElementById("gb-posts");
  var form = document.getElementById("gb-form");
  var note = document.getElementById("gb-note");
  if (!postsBox || !form) return;

  function ownerKey() {
    try { return localStorage.getItem("gb_admin") || ""; } catch (e) { return ""; }
  }

  function fmtDate(iso) {
    var d = new Date(String(iso).replace(" ", "T") + (String(iso).indexOf("Z") > -1 ? "" : "Z"));
    if (isNaN(d)) return "";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function render(posts) {
    postsBox.textContent = "";
    if (!posts.length) {
      var p = document.createElement("p");
      p.className = "gb-empty";
      p.textContent = "No posts yet — be the first to say hello.";
      postsBox.appendChild(p);
      return;
    }
    var isOwner = !!ownerKey();
    posts.forEach(function (post) {
      var wrap = document.createElement("div");
      wrap.className = "gb-post";

      var head = document.createElement("p");
      head.className = "gb-head";
      var name = document.createElement("strong");
      name.textContent = post.name;
      head.appendChild(name);
      var when = document.createElement("span");
      when.className = "gb-when";
      when.textContent = " · " + fmtDate(post.created_at);
      head.appendChild(when);
      wrap.appendChild(head);

      if (post.badge) {
        var b = document.createElement("p");
        b.className = "gb-badge";
        var img = document.createElement("img");
        img.src = "images/jaiou-badge.svg";
        img.alt = "The jAIou badge";
        img.className = "gb-badgeimg";
        b.appendChild(img);
        var cap = document.createElement("span");
        cap.textContent = "jAIou badge — won on McWoogle, four searches deep";
        b.appendChild(cap);
        wrap.appendChild(b);
      }

      var msg = document.createElement("p");
      msg.className = "gb-msg";
      msg.textContent = post.message;
      wrap.appendChild(msg);

      if (isOwner) {
        var tools = document.createElement("p");
        tools.className = "gb-tools";
        var hide = document.createElement("button");
        hide.type = "button";
        hide.textContent = "Hide this post";
        hide.addEventListener("click", function () {
          fetch(API + "/admin/hide", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Admin-Key": ownerKey() },
            body: JSON.stringify({ id: post.id }),
          }).then(function (r) {
            if (r.status === 403) {
              try { localStorage.removeItem("gb_admin"); } catch (e) {}
              note.textContent = "That owner key did not work — it has been cleared. Tap Owner to enter it again.";
              load();
            } else {
              load();
            }
          });
        });
        tools.appendChild(hide);
        wrap.appendChild(tools);
      }
      postsBox.appendChild(wrap);
    });
  }

  function load() {
    fetch(API + "/posts")
      .then(function (r) { return r.json(); })
      .then(function (d) { render(d.posts || []); })
      .catch(function () {
        postsBox.textContent = "";
        var p = document.createElement("p");
        p.className = "gb-empty";
        p.textContent = "The board did not answer just now. Give it a moment and refresh.";
        postsBox.appendChild(p);
      });
  }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    note.textContent = "Posting…";
    var payload = {
      name: form.elements["name"].value,
      email: form.elements["email"].value,
      code: form.elements["code"].value,
      message: form.elements["message"].value,
      website: form.elements["website"].value,
    };
    fetch(API + "/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
      .then(function (res) {
        if (res.status === 200 && res.d.ok) {
          form.elements["message"].value = "";
          form.elements["code"].value = "";
          note.textContent = res.d.badge_error ? res.d.badge_error : "Posted — it is on the board below.";
          load();
        } else {
          note.textContent = res.d.error || "The post did not go through. Try once more.";
        }
      })
      .catch(function () {
        note.textContent = "The board did not answer just now. Your words are still in the form — try once more.";
      });
  });

  var ownerBtn = document.getElementById("gb-owner");
  var ownerTools = document.getElementById("gb-ownertools");
  function paintOwnerTools() {
    if (!ownerTools) return;
    ownerTools.textContent = "";
    if (!ownerKey()) return;
    var exp = document.createElement("button");
    exp.type = "button";
    exp.textContent = "Export poster list (CSV)";
    exp.addEventListener("click", function () {
      fetch(API + "/admin/export?format=csv", { headers: { "X-Admin-Key": ownerKey() } })
        .then(function (r) { return r.blob(); })
        .then(function (blob) {
          var a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "guestbook-posters.csv";
          a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
        });
    });
    ownerTools.appendChild(exp);
    var out = document.createElement("button");
    out.type = "button";
    out.textContent = "Owner sign-out";
    out.addEventListener("click", function () {
      try { localStorage.removeItem("gb_admin"); } catch (e) {}
      paintOwnerTools();
      load();
    });
    ownerTools.appendChild(out);
  }
  if (ownerBtn) {
    ownerBtn.addEventListener("click", function () {
      if (ownerKey()) { paintOwnerTools(); load(); return; }
      // Inline unlock instead of a browser prompt() — dialogs are too easy
      // for a browser to block, and a real field is easier to read anyway.
      ownerTools.textContent = "";
      var input = document.createElement("input");
      input.type = "password";
      input.placeholder = "Owner key";
      input.className = "gb-keyin";
      var go = document.createElement("button");
      go.type = "button";
      go.textContent = "Unlock";
      go.addEventListener("click", function () {
        var k = input.value.trim();
        if (k) {
          try { localStorage.setItem("gb_admin", k); } catch (e) {}
          paintOwnerTools();
          load();
        }
      });
      ownerTools.appendChild(input);
      ownerTools.appendChild(go);
      input.focus();
    });
  }

  paintOwnerTools();
  load();
})();

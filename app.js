(function () {
  "use strict";
  var C = window.VIBE_CONFIG;
  var history = [];          // current session only: [{role:"user"|"assistant", content}]
  var controller = null;
  var busy = false;
  var modelName = "";

  var $ = function (id) { return document.getElementById(id); };
  var messagesEl = $("messages"), scroller = $("scroller"), welcome = $("welcome");
  var input = $("input"), sendBtn = $("sendBtn"), stopBtn = $("stopBtn");
  var statusEl = $("status"), statusText = $("statusText");

  /* ---------- safe rendering: escape everything first, then add our own tags ---------- */
  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function inline(s) {
    return esc(s).replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  }
  function renderText(text) {
    var parts = text.split("```"), html = "";
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        var code = parts[i].replace(/^[^\n]*\n/, "");
        html += "<pre><code>" + esc(code.replace(/\n$/, "")) + "</code></pre>";
        continue;
      }
      var lines = parts[i].split("\n"), list = null, para = [];
      var flushPara = function () { if (para.length) { html += "<p>" + para.join("<br>") + "</p>"; para = []; } };
      var flushList = function () { if (list) { html += "</" + list + ">"; list = null; } };
      for (var j = 0; j < lines.length; j++) {
        var ln = lines[j], ul = /^\s*[-*]\s+(.*)/.exec(ln), ol = /^\s*\d+[.)]\s+(.*)/.exec(ln);
        if (ul || ol) {
          flushPara();
          var kind = ul ? "ul" : "ol";
          if (list !== kind) { flushList(); html += "<" + kind + ">"; list = kind; }
          html += "<li>" + inline((ul || ol)[1]) + "</li>";
        } else if (ln.trim() === "") { flushPara(); flushList(); }
        else { flushList(); para.push(inline(ln)); }
      }
      flushPara(); flushList();
    }
    return html;
  }

  /* ---------- UI helpers ---------- */
  function scrollDown() { scroller.scrollTop = scroller.scrollHeight; }
  function addMessage(role) {
    var wrap = document.createElement("div");
    wrap.className = "msg " + (role === "user" ? "user" : "ai");
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    return { wrap: wrap, bubble: bubble };
  }
  function setMeta(wrap, text) {
    var m = wrap.querySelector(".meta");
    if (!m) { m = document.createElement("div"); m.className = "meta"; wrap.appendChild(m); }
    m.textContent = text;
  }
  function showError(wrap, title, detail) {
    var old = wrap.querySelector(".bubble");
    if (old && !old.textContent.trim()) old.remove();
    var e = document.createElement("div");
    e.className = "error"; e.setAttribute("role", "alert");
    var s = document.createElement("strong"); s.textContent = title;
    e.appendChild(s); e.appendChild(document.createTextNode(detail));
    wrap.appendChild(e);
  }
  function setBusy(b) {
    busy = b;
    sendBtn.hidden = b; stopBtn.hidden = !b;
    input.disabled = b;
    if (!b) input.focus();
  }
  function setStatus(kind, text) {
    statusEl.className = "status status-" + kind;
    statusText.textContent = text;
  }
  function autoGrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  }

  /* ---------- server check (does not call the AI, so it costs nothing) ---------- */
  function checkStatus() {
    return fetch("/api/status", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (d) {
        modelName = d.model || "";
        if (!d.configured) setStatus("warn", "API key missing");
        else setStatus("ok", "Online · " + (d.provider || "AI"));
      })
      .catch(function () { setStatus("bad", "Server offline"); });
  }

  var ERROR_TITLES = {
    no_key: "API key missing",
    bad_key: "API key rejected",
    rate_limit: "Free limit reached",
    ssl: "SSL certificate problem",
    network: "No connection to the AI service",
    no_curl: "PHP cURL is disabled",
    model: "The AI service rejected the request",
    provider: "The AI service returned an error"
  };

  /* ---------- sending a message and streaming the AI's reply ---------- */
  function send(text) {
    text = (text || "").trim();
    if (busy || !text) return;
    if (text.length > C.MAX_INPUT_CHARS) text = text.slice(0, C.MAX_INPUT_CHARS);

    welcome.hidden = true;
    var u = addMessage("user");
    u.bubble.textContent = text;
    history.push({ role: "user", content: text });
    input.value = ""; autoGrow();

    var a = addMessage("ai");
    a.bubble.innerHTML = '<div class="typing" aria-label="VibeAI is thinking"><span></span><span></span><span></span></div>';
    scrollDown();

    controller = new AbortController();
    setBusy(true);

    var reply = "", started = false, t0 = Date.now(), failed = false;

    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ messages: history.slice(-C.MAX_CONTEXT_MESSAGES) })
    })
      .then(function (res) {
        if (!res.ok) {
          return res.text().then(function (body) {
            var code = "", msg = "";
            try { var j = JSON.parse(body); code = j.error.code; msg = j.error.message; } catch (e) { msg = "Server answered HTTP " + res.status + ". Is Apache/PHP running correctly?"; }
            var err = new Error(msg); err.title = ERROR_TITLES[code] || "Something went wrong"; throw err;
          });
        }
        modelName = res.headers.get("X-VibeAI-Model") || modelName;
        var reader = res.body.getReader(), dec = new TextDecoder(), buf = "";
        function handleLine(line) {
          line = line.trim();
          if (line.indexOf("data:") !== 0) return;
          var payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") return;
          var obj;
          try { obj = JSON.parse(payload); } catch (e) { return; }
          if (obj.error) { var er = new Error(obj.error.message || "The AI service reported an error."); er.title = "The AI service returned an error"; throw er; }
          var d = obj.choices && obj.choices[0] && obj.choices[0].delta;
          if (d && d.content) {
            reply += d.content; started = true;
            a.bubble.innerHTML = renderText(reply);
            scrollDown();
          }
        }
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) { if (buf) handleLine(buf); return; }
            buf += dec.decode(r.value, { stream: true });
            var lines = buf.split("\n"); buf = lines.pop();
            lines.forEach(handleLine);
            return pump();
          });
        }
        return pump();
      })
      .then(function () {
        if (!reply.trim()) { var e = new Error("The AI finished without producing any text. Try again."); e.title = "Empty response"; throw e; }
        history.push({ role: "assistant", content: reply });
        setMeta(a.wrap, (modelName ? modelName + " · " : "") + ((Date.now() - t0) / 1000).toFixed(1) + "s");
      })
      .catch(function (err) {
        failed = true;
        if (err.name === "AbortError") {
          if (reply.trim()) { history.push({ role: "assistant", content: reply }); setMeta(a.wrap, "Stopped"); }
          else { a.wrap.remove(); history.pop(); input.value = text; autoGrow(); }
          return;
        }
        if (started && reply.trim()) history.push({ role: "assistant", content: reply });
        else { history.pop(); input.value = text; autoGrow(); }
        if (err.title) showError(a.wrap, err.title, err.message);
        else showError(a.wrap, "Cannot reach the VibeAI server",
          "Could not reach the server. Check your internet connection and try again. Your message was put back in the box.");
        checkStatus();
      })
      .then(function () {
        controller = null; setBusy(false); scrollDown();
        if (!failed) checkStatus();
      });
  }

  /* ---------- events ---------- */
  $("composer").addEventListener("submit", function (e) { e.preventDefault(); send(input.value); });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input.value); }
  });
  input.addEventListener("input", autoGrow);
  stopBtn.addEventListener("click", function () { if (controller) controller.abort(); });
  $("newChat").addEventListener("click", function () {
    if (controller) controller.abort();
    history = [];
    messagesEl.querySelectorAll(".msg").forEach(function (n) { n.remove(); });
    welcome.hidden = false; input.value = ""; autoGrow(); input.focus();
    checkStatus();
  });

  var chips = $("chips");
  C.SUGGESTIONS.forEach(function (s) {
    var b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.textContent = s;
    b.addEventListener("click", function () { send(s); });
    chips.appendChild(b);
  });

  checkStatus();
  setInterval(function () { if (!busy) checkStatus(); }, 20000);
})();

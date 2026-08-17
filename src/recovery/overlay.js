(function () {
  var BOOT = typeof window !== "undefined" && window.__SKILLHUB_RECOVERY_BOOT__
    ? window.__SKILLHUB_RECOVERY_BOOT__
    : {
      button: "快速修复 · 卸载全部第三方",
      warningTitle: "粗暴模式 · 会卸载所有第三方插件",
      warningBody: "不逐个甄别肇事项：一次性移除 profile 内全部第三方包（含 anime-find、skillhub 等），再重启 dsh web。基线内置插件保留。",
      hint: "目标：立刻拉回可用 UI。副作用：第三方能力全部清掉，需事后按需重装。",
      running: "正在执行粗暴快速修复…",
      successTitle: "服务已恢复（安全模式）",
      successBody: "全部第三方插件已卸载；仅基线能力在线。正在等待 dsh web 重启…",
      restartHint: "若页面未自动恢复，请手动重启 dsh web 并强制刷新。",
      retry: "重试",
      nonce: "",
    };
  var COPY = BOOT;
  var CSS_ID = "skillhub-recovery-style";
  var ROOT_ID = "skillhub-recovery-root";
  var CSS = [
    "#skillhub-recovery-root{width:min(520px,calc(100vw - 2rem));margin:18px auto 0;font-family:Avenir Next,Segoe UI,PingFang SC,Hiragino Sans GB,Microsoft YaHei,sans-serif;color:#141414}",
    "#skillhub-recovery-root *{box-sizing:border-box}",
    "#skillhub-recovery-root .sh-rec-warn{margin:0;padding:.7rem .8rem;border:1px solid #fecaca;background:#fff1f0;color:#7f1d1d;font-size:.8rem;text-align:left}",
    "#skillhub-recovery-root .sh-rec-warn strong{display:block;margin-bottom:.2rem;font-size:.84rem}",
    "#skillhub-recovery-root .sh-rec-actions{margin-top:1rem;display:flex;flex-wrap:wrap;align-items:center;gap:.65rem}",
    "#skillhub-recovery-root .sh-rec-nuke{appearance:none;border:0;cursor:pointer;font:inherit;font-weight:800;font-size:.95rem;color:#fff;background:#9f1239;padding:.78rem 1.2rem}",
    "#skillhub-recovery-root .sh-rec-nuke:hover{background:#7f0f2e}",
    "#skillhub-recovery-root .sh-rec-nuke:disabled{opacity:.55;cursor:not-allowed}",
    "#skillhub-recovery-root .sh-rec-hint{margin:0;font-size:.76rem;color:#5e5e5e;max-width:28em;text-align:left}",
    "#skillhub-recovery-root .sh-rec-log{margin:0;padding:.85rem .95rem;background:#111;color:#e8e8e8;font-family:SFMono-Regular,Cascadia Mono,Consolas,monospace;font-size:.73rem;line-height:1.65;min-height:140px;text-align:left;white-space:pre-wrap}",
    "#skillhub-recovery-root .sh-rec-log .ok{color:#86efac}",
    "#skillhub-recovery-root .sh-rec-log .bad{color:#fda4af}",
    "#skillhub-recovery-root .sh-rec-log .warn{color:#fcd34d}",
    "#skillhub-recovery-root .sh-rec-bar{margin-top:.8rem;height:4px;background:#e5e5e5;overflow:hidden}",
    "#skillhub-recovery-root .sh-rec-bar>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#9f1239,#ea580c);transition:width .3s ease}",
    "#skillhub-recovery-root .sh-rec-ok{display:flex;gap:.7rem;padding:.85rem .95rem;border:1px solid #b7dfc8;background:#eef7f1;text-align:left}",
    "#skillhub-recovery-root .sh-rec-ok h2{margin:0 0 .15rem;font-size:.95rem}",
    "#skillhub-recovery-root .sh-rec-ok p{margin:0;font-size:.8rem;color:#5e5e5e}",
    "#skillhub-recovery-root .sh-rec-err{margin:.6rem 0 0;color:#9f1239;font-size:.8rem;text-align:left}",
  ].join("");

  function ensureCss() {
    if (!document.getElementById(CSS_ID)) {
      var style = document.createElement("style");
      style.id = CSS_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
  }

  function isFailPage() {
    var text = document.body ? document.body.innerText : "";
    if (text.indexOf("Failed to load plugins") === -1) return false;
    // Prefer the user-facing options.id regression text when present.
    return true;
  }

  function looksLikeOptionsIdFailure() {
    var text = document.body ? document.body.innerText : "";
    return text.indexOf('requires options.id') !== -1 || text.indexOf("settings.plugin.item") !== -1;
  }

  function apiUrl(path) {
    return new URL(path, document.baseURI).href;
  }

  function safeLabel(value) {
    return String(value == null ? "" : value).replace(/[^\w@/.\-+#: ]+/g, "");
  }

  function mount() {
    if (document.getElementById(ROOT_ID) || !isFailPage()) return;
    ensureCss();
    var root = document.createElement("div");
    root.id = ROOT_ID;
    root.setAttribute("data-skillhub-recovery-ui", "fail");
    if (looksLikeOptionsIdFailure()) root.setAttribute("data-skillhub-fail-kind", "options-id");
    document.body.appendChild(root);
    renderFail(root);
  }

  function renderFail(root, error) {
    root.setAttribute("data-skillhub-recovery-ui", error ? "error" : "fail");
    root.textContent = "";
    var warn = document.createElement("div");
    warn.className = "sh-rec-warn";
    var strong = document.createElement("strong");
    strong.textContent = COPY.warningTitle;
    warn.appendChild(strong);
    warn.appendChild(document.createTextNode(COPY.warningBody));
    var actions = document.createElement("div");
    actions.className = "sh-rec-actions";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sh-rec-nuke";
    btn.id = "skillhub-recovery-nuke";
    btn.textContent = error ? COPY.retry + " · " + COPY.button : COPY.button;
    btn.addEventListener("click", function () { runFix(root, btn); });
    var hint = document.createElement("p");
    hint.className = "sh-rec-hint";
    hint.textContent = COPY.hint;
    actions.appendChild(btn);
    actions.appendChild(hint);
    root.appendChild(warn);
    root.appendChild(actions);
    if (error) {
      var err = document.createElement("p");
      err.className = "sh-rec-err";
      err.textContent = String(error);
      root.appendChild(err);
    }
  }

  function renderRun(root) {
    root.setAttribute("data-skillhub-recovery-ui", "running");
    root.textContent = "";
    var head = document.createElement("p");
    head.style.fontWeight = "750";
    head.textContent = COPY.running;
    var log = document.createElement("pre");
    log.className = "sh-rec-log";
    log.id = "skillhub-recovery-log";
    var bar = document.createElement("div");
    bar.className = "sh-rec-bar";
    var barInner = document.createElement("i");
    barInner.id = "skillhub-recovery-bar";
    bar.appendChild(barInner);
    root.appendChild(head);
    root.appendChild(log);
    root.appendChild(bar);
  }

  function addLog(text, cls) {
    var log = document.getElementById("skillhub-recovery-log");
    if (!log) return;
    var line = document.createElement("div");
    if (cls) line.className = cls;
    line.textContent = text;
    log.appendChild(line);
  }

  function setProgress(pct) {
    var bar = document.getElementById("skillhub-recovery-bar");
    if (bar) bar.style.width = pct + "%";
  }

  function renderOk(root, body) {
    root.setAttribute("data-skillhub-recovery-ui", "success");
    var removed = (body && body.removed) || [];
    root.textContent = "";
    var banner = document.createElement("div");
    banner.className = "sh-rec-ok";
    var wrap = document.createElement("div");
    var h2 = document.createElement("h2");
    h2.textContent = COPY.successTitle;
    var p1 = document.createElement("p");
    p1.textContent = COPY.successBody;
    var p2 = document.createElement("p");
    p2.textContent = COPY.restartHint;
    var p3 = document.createElement("p");
    var labels = removed.map(safeLabel).filter(Boolean);
    p3.textContent = "已卸载: " + (labels.join(", ") || "—");
    wrap.appendChild(h2);
    wrap.appendChild(p1);
    wrap.appendChild(p2);
    wrap.appendChild(p3);
    banner.appendChild(wrap);
    root.appendChild(banner);
  }

  async function runFix(root, btn) {
    btn.disabled = true;
    renderRun(root);
    addLog("$ dsh plugin --profile web list --third-party", "");
    setProgress(12);
    addLog("→ enumerating third-party (no cherry-pick)", "warn");
    setProgress(28);
    try {
      if (!COPY.nonce) throw new Error("recovery nonce missing — reload the fail page");
      var res = await fetch(apiUrl("./skillhub/recovery/nuke"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "nuke-third-party", nonce: COPY.nonce }),
      });
      var body = await res.json().catch(function () { return {}; });
      if (!res.ok || body.ok === false) throw new Error(body.error || ("HTTP " + res.status));
      var logs = body.logs || [];
      for (var i = 0; i < logs.length; i++) {
        var text = String(logs[i]);
        var cls = text.indexOf("×") === 0 ? "bad" : text.indexOf("✓") === 0 ? "ok" : "";
        addLog(text, cls);
        setProgress(40 + Math.round(((i + 1) / Math.max(logs.length, 1)) * 50));
      }
      addLog("$ restart dsh web && force-reload", "");
      setProgress(100);
      renderOk(root, body);
      waitForReload();
    } catch (err) {
      renderFail(root, err && err.message ? err.message : String(err));
    }
  }

  function waitForReload() {
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      fetch(apiUrl("./"), { method: "HEAD", cache: "no-store" }).then(function (res) {
        if (res.ok) {
          clearInterval(timer);
          location.reload();
        }
      }).catch(function () {});
      if (tries > 80) clearInterval(timer);
    }, 1500);
  }

  function watch() {
    mount();
    var obs = new MutationObserver(function () { mount(); });
    if (document.body) obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    setInterval(mount, 800);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch);
  else watch();
})();

// The source editor. Every change goes straight to the overlay; there's no Save button.
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const form = $("#form");
  let state = { sources: [], settings: {}, hotkeyErrors: {}, displays: [] };
  let selected = new URLSearchParams(location.search).get("select");
  let view = "source"; // source | settings

  const current = () => state.sources.find((s) => s.id === selected);

  // ---------- toast ----------
  let toastTimer;
  function say(text) {
    const t = $("#toast");
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 1400);
  }

  // ---------- icons ----------
  const svg = (body) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  const ICONS = {
    shown: svg('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
    hidden: svg('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><path d="M4 4l16 16"/>'),
    locked: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
    unlocked: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.6-1.7"/>'),
  };

  function describe(s) {
    let what = "Custom HTML";
    if (s.kind === "file") what = s.file.split(/[\\/]/).pop() || "Local file";
    if (s.kind === "url") {
      try {
        what = new URL(/^[a-z]+:/i.test(s.url) ? s.url : "https://" + s.url).host || s.url;
      } catch {
        what = s.url || "Web page";
      }
    }
    const fill = { screen: " · whole screen", workarea: " · screen minus taskbar" }[s.fill] || "";
    return what + fill;
  }

  // ---------- rendering ----------
  function render() {
    const any = state.sources.length > 0;
    $("#toggle-all").textContent = state.sources.some((s) => s.visible) ? "Hide all" : "Show all";
    $("#lock-all").textContent = state.sources.some((s) => !s.locked) ? "Lock all" : "Unlock all";
    $("#toggle-all").disabled = $("#lock-all").disabled = !any;

    if (selected && !current()) selected = null;
    if (!selected && any) selected = state.sources[0].id;

    renderList();
    form.hidden = view !== "source" || !current();
    $("#settings").hidden = view !== "settings";
    $("#empty").hidden = view !== "source" || any;
    if (!form.hidden) renderForm();
    if (view === "settings") renderSettings();
  }

  function renderList() {
    const ul = $("#sources");
    ul.innerHTML = "";
    for (const s of state.sources) {
      const li = document.createElement("li");
      li.className = `src${s.id === selected && view === "source" ? " sel" : ""}${s.visible ? "" : " off"}`;
      li.dataset.id = s.id;
      li.innerHTML = `
        <button class="icon${s.visible ? " on" : ""}" data-toggle="visible" title="${s.visible ? "Hide" : "Show"}">${s.visible ? ICONS.shown : ICONS.hidden}</button>
        <div class="name"></div>
        <button class="icon${s.locked ? "" : " on"}" data-toggle="locked" title="${s.locked ? "Unlock to move and resize" : "Lock in place"}">${s.locked ? ICONS.locked : ICONS.unlocked}</button>`;
      const name = $(".name", li);
      name.textContent = s.name || "(unnamed)";
      const kind = document.createElement("small");
      kind.className = "kind";
      kind.textContent = describe(s);
      name.append(kind);
      ul.append(li);
    }
    $("#list-empty").hidden = state.sources.length > 0;
  }

  // Fills the form from the selected source, leaving alone whatever is being typed in.
  function renderForm() {
    const s = current();
    const displaySel = $("#display");
    const primary = state.displays.find((d) => d.primary);
    const labels = state.displays.map((d) => d.label).join("\n");
    if (displaySel.dataset.labels !== labels) {
      displaySel.dataset.labels = labels;
      displaySel.innerHTML = "";
      for (const d of state.displays) displaySel.add(new Option(d.label, String(d.id)));
    }

    for (const el of $$("[data-field]", form)) {
      if (el === document.activeElement && el.type !== "radio" && el.type !== "checkbox") continue;
      const v = s[el.dataset.field];
      if (el.type === "checkbox") el.checked = !!v;
      else if (el.type === "radio") el.checked = el.value === String(v);
      else {
        // only when it changed: rewriting a long HTML or CSS box on every update is slow
        const text = el === displaySel ? String(v ?? primary?.id) : String(v ?? "");
        if (el.value !== text) el.value = text;
      }
    }
    for (const el of $$("[data-when]", form)) {
      const [, key, op, value] = el.dataset.when.match(/^(\w+)(!?=)(\w+)$/);
      el.hidden = (String(s[key]) === value) !== (op === "=");
    }
    for (const f of ["width", "height"]) $(`[data-field="${f}"]`, form).disabled = !!s.fit;
    const isStats = s.kind === "url" && !!state.stats && s.url.startsWith(state.stats.url);
    $("#stats-hint").hidden = $("#stats-card").hidden = !isStats;
    if (isStats) renderStatsCard(s.url);
    const hk = $('[data-hotkey="hotkey"]', form);
    if (!hk.classList.contains("capturing")) hk.value = pretty(s.hotkey);
    $('[data-error="source"]', form).textContent = state.hotkeyErrors[s.id] || "";
    const i = state.sources.indexOf(s);
    $("#up").disabled = i === 0;
    $("#down").disabled = i === state.sources.length - 1;
  }

  function renderSettings() {
    for (const el of $$("#settings [data-hotkey]")) {
      if (!el.classList.contains("capturing")) el.value = pretty(state.settings[el.dataset.hotkey]);
    }
    for (const el of $$("#settings [data-error]")) el.textContent = state.hotkeyErrors[el.dataset.error] || "";
    $("#launch").checked = !!state.settings.launchAtLogin;
    $("#version").textContent = "v" + state.version;

    $("#stats-url").value = state.stats.url;
    $("#stats-error").textContent = state.stats.error || "";
    $("#fps-status").textContent = FPS_STATUS[state.stats.fps];
    $("#fps-allow-row").hidden = state.stats.fps !== "setup";
  }

  const FPS_STATUS = {
    ok: "On. It follows whichever app is in focus.",
    signout: "Almost there: sign out of Windows and back in to finish.",
    setup: "Off. Windows needs your OK once.",
  };

  // ---------- the stats panel's settings, kept in its address ----------
  const STATS_ROWS = ["cpu", "gpu", "vram", "fps", "app"];

  function renderStatsCard(url) {
    const q = new URL(url).searchParams;
    const shown = (q.get("show") || STATS_ROWS.join(",")).split(",");
    for (const el of $$("[data-stats-row]")) el.checked = shown.includes(el.dataset.statsRow);
    for (const el of $$('[data-stats="layout"]')) el.checked = el.value === (q.get("layout") === "row" ? "row" : "column");
    for (const el of $$('[data-stats="scale"]')) el.checked = el.value === String(Math.round(+q.get("scale") || 2));
    $('[data-stats="bg"]').checked = q.get("bg") !== "0";
  }

  $("#stats-card").addEventListener("change", () => {
    const s = current();
    if (!s) return;
    const url = new URL(s.url);
    const q = url.searchParams;
    const rows = $$("[data-stats-row]").filter((el) => el.checked).map((el) => el.dataset.statsRow);
    if (rows.length && rows.length < STATS_ROWS.length) q.set("show", rows.join(","));
    else q.delete("show");
    const layout = $('[data-stats="layout"]:checked')?.value;
    if (layout === "row") q.set("layout", "row");
    else q.delete("layout");
    const scale = $('[data-stats="scale"]:checked')?.value;
    if (scale && scale !== "2") q.set("scale", scale);
    else q.delete("scale");
    if ($('[data-stats="bg"]').checked) q.delete("bg");
    else q.set("bg", "0");
    commit("url", url.toString().replace(/%2C/gi, ","));
  });

  // ---------- editing a source ----------
  const pending = new Map(); // field -> timer, for changes made while typing

  function commit(field, value) {
    const s = current();
    if (!s) return;
    clearTimeout(pending.get(field));
    pending.delete(field);
    s[field] = value; // show it now; the app's answer follows
    app.update(s.id, { [field]: value });
    render();
  }

  function commitLater(field, value, ms) {
    clearTimeout(pending.get(field));
    const id = selected;
    pending.set(
      field,
      setTimeout(() => {
        if (selected === id) commit(field, value);
      }, ms),
    );
  }

  // Changes still waiting on a timer are sent before the selection moves on.
  function flush() {
    for (const el of $$("[data-field]", form)) {
      if (pending.has(el.dataset.field) && el.type !== "radio") commit(el.dataset.field, valueOf(el));
    }
  }

  function valueOf(el) {
    if (el.type === "checkbox") return el.checked;
    if (el.id === "display") return Number(el.value);
    if (el.type === "number" || el.type === "range") return Number(el.value);
    return el.value;
  }

  form.addEventListener("input", (e) => {
    const el = e.target;
    const field = el.dataset.field;
    if (!field) return;
    if (el.type === "range" || el.type === "number") {
      if (el.value === "") return;
      // keep the slider and its number box together while dragging
      for (const twin of $$(`[data-field="${field}"]`, form)) if (twin !== el) twin.value = el.value;
      commitLater(field, Number(el.value), 60);
    } else if (el.dataset.commit === "input") {
      commitLater(field, el.value, 300);
    }
  });

  form.addEventListener("change", (e) => {
    const el = e.target;
    const field = el.dataset.field;
    if (!field || el.dataset.commit === "input") return;
    if ((el.type === "number" || el.type === "range") && el.value === "") return renderForm();
    commit(field, valueOf(el));
  });

  // Enter in a text box applies it (the address box, mostly).
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const el = document.activeElement;
    if (el?.dataset.field) commit(el.dataset.field, valueOf(el));
  });

  // Ctrl+S applies the text box you're in (HTML, CSS).
  document.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "s" || !e.ctrlKey) return;
    e.preventDefault();
    const el = document.activeElement;
    if (el?.dataset.field) {
      commit(el.dataset.field, valueOf(el));
      say("Applied!");
    }
  });

  $('[data-apply="html"]').addEventListener("click", () => {
    commit("html", $('[data-field="html"]', form).value);
    say("Applied!");
  });

  $("#browse").addEventListener("click", async () => {
    const file = await app.pickFile();
    if (!file) return;
    const s = current();
    if (s && (!s.name || ["Local file", "New overlay"].includes(s.name))) {
      commit("name", file.split(/[\\/]/).pop().replace(/\.[^.]+$/, ""));
    }
    commit("file", file);
  });

  $("#reset-css").addEventListener("click", () => {
    $('[data-field="css"]', form).value = state.defaultCss;
    commit("css", state.defaultCss);
  });

  $("#center").addEventListener("click", () => app.center(selected));
  $("#reload").addEventListener("click", () => {
    app.reload(selected);
    say("Reloaded!");
  });
  $("#devtools").addEventListener("click", () => app.devtools(selected));
  $("#duplicate").addEventListener("click", async () => {
    flush();
    const id = await app.duplicate(selected);
    if (id) select(id);
  });
  $("#up").addEventListener("click", () => app.move(selected, -1));
  $("#down").addEventListener("click", () => app.move(selected, 1));
  $("#remove").addEventListener("click", () => {
    const s = current();
    if (s && confirm(`Delete "${s.name}"?`)) app.remove(s.id);
  });

  // ---------- the list and the top bar ----------
  function select(id) {
    flush();
    selected = id;
    view = "source";
    render();
  }

  $("#sources").addEventListener("click", (e) => {
    const li = e.target.closest(".src");
    if (!li) return;
    const toggle = e.target.closest("[data-toggle]")?.dataset.toggle;
    const s = state.sources.find((x) => x.id === li.dataset.id);
    if (toggle && s) {
      s[toggle] = !s[toggle];
      app.update(s.id, { [toggle]: s[toggle] });
      render();
    } else {
      select(li.dataset.id);
    }
  });

  for (const btn of $$("[data-add]")) {
    btn.addEventListener("click", async () => {
      const id = await app.add(btn.dataset.add);
      select(id);
      const focus = { url: '[data-field="url"]', file: "#browse", html: '[data-field="html"]' }[btn.dataset.add];
      $(focus, form)?.focus();
      if (btn.dataset.add === "file") $("#browse").click();
    });
  }

  $("#toggle-all").addEventListener("click", () => {
    const show = !state.sources.some((s) => s.visible);
    for (const s of state.sources) app.update(s.id, { visible: show });
  });
  $("#lock-all").addEventListener("click", () => {
    const lock = state.sources.some((s) => !s.locked);
    for (const s of state.sources) app.update(s.id, { locked: lock });
  });

  // ---------- settings ----------
  $("#open-settings").addEventListener("click", () => {
    flush();
    view = view === "settings" ? "source" : "settings";
    render();
  });
  $("#close-settings").addEventListener("click", () => {
    view = "source";
    render();
  });
  $("#launch").addEventListener("change", (e) => app.settings({ launchAtLogin: e.target.checked }));
  $("#add-stats").addEventListener("click", async () => select(await app.addStats()));
  $("#copy-stats").addEventListener("click", () => {
    app.copy(state.stats.url);
    say("Copied!");
  });
  $("#fps-allow").addEventListener("click", async (e) => {
    e.target.disabled = true;
    $("#fps-status").textContent = "Waiting for Windows…";
    const result = await app.allowFps();
    state.stats.fps = result;
    e.target.disabled = false;
    if (result === "setup") say("Not turned on");
    renderSettings();
  });
  $("#open-data").addEventListener("click", () => app.openData());
  for (const a of $$("[data-url]")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      app.openUrl(a.dataset.url);
    });
  }

  // ---------- hotkey boxes: click, then press the keys ----------
  const pretty = (accel) => (accel || "").replace(/CommandOrControl|CmdOrCtrl/g, "Ctrl");

  const KEYS = {
    Space: "Space", Enter: "Enter", Tab: "Tab", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert", Delete: "Delete",
    Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Comma: ",",
    Period: ".", Slash: "/", Backslash: "\\", Backquote: "`", Pause: "Pause", ScrollLock: "Scrolllock",
    NumpadAdd: "numadd", NumpadSubtract: "numsub", NumpadMultiply: "nummult", NumpadDivide: "numdiv", NumpadDecimal: "numdec",
  };

  function keyName(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^Numpad\d$/.test(code)) return "num" + code.slice(6);
    if (/^F\d{1,2}$/.test(code)) return code;
    return KEYS[code] || null;
  }

  function saveHotkey(el, accel) {
    const key = el.dataset.hotkey;
    if (key === "hotkey") commit("hotkey", accel);
    else app.settings({ [key]: accel });
    el.value = pretty(accel);
  }

  for (const el of $$("[data-hotkey]")) {
    el.addEventListener("focus", () => {
      el.classList.add("capturing");
      el.value = "";
      el.placeholder = "Press the keys…";
    });
    el.addEventListener("blur", () => {
      el.classList.remove("capturing");
      el.placeholder = "Click, then press keys";
      render();
    });
    el.addEventListener("keydown", (e) => {
      e.preventDefault();
      const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean);
      if (e.key === "Escape") return el.blur();
      if ((e.key === "Backspace" || e.key === "Delete") && !mods.length) {
        saveHotkey(el, "");
        return el.blur();
      }
      const key = keyName(e.code);
      el.value = [...mods, key || ""].join("+");
      // a bare letter would stop that letter working everywhere else, so those need a modifier
      if (!key || (!mods.length && !/^F\d+$|^Pause$|^Scrolllock$/.test(key))) return;
      saveHotkey(el, [...mods, key].join("+"));
      el.blur();
    });
  }

  // ---------- start ----------
  app.onState((s) => {
    state = s;
    render();
  });
  app.onSelect((id) => select(id));
  app.state().then((s) => {
    state = s;
    render();
  });
})();

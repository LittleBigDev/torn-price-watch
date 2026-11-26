// ==UserScript==
// @name         Torn Price Watch
// @namespace    https://github.com/LittleBigDev/torn-price-watch
// @version      1.7
// @description  Alerts when a watched item is listed under your max price, on the item market or in a bazaar.
// @author       Workaround
// @license      MIT
// @match        https://www.torn.com/*
// @connect      api.torn.com
// @connect      weav3r.dev
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_info
// @downloadURL  https://raw.githubusercontent.com/LittleBigDev/torn-price-watch/main/torn-price-watch.user.js
// @updateURL    https://raw.githubusercontent.com/LittleBigDev/torn-price-watch/main/torn-price-watch.user.js
// ==/UserScript==

(function () {
  "use strict";

  const LAUNCHER_ID = "price-watch-launcher";
  const VERSION = (() => { try { return GM_info.script.version; } catch { return ""; } })();
  const TICK_MS = 5000;             // how often each tab checks whether a poll is due
  const POLL_CHOICES = [30, 60, 120, 300];  // seconds, same choices as Stock Watch
  const SEEN_TTL_MS = 24 * 3600e3;  // a listing alerts once, then again only after a day out of sight
  const CATALOG_TTL_MS = 24 * 3600e3;  // market values move daily

  const store = {
    get: (k, d) => { try { const v = GM_getValue(k); return v === undefined ? d : v; } catch { return d; } },
    set: (k, v) => { try { GM_setValue(k, v); } catch {} },
  };

  // ---------- network ----------

  function getJSON(url) {
    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((resolve, reject) => GM_xmlhttpRequest({
        method: "GET", url, timeout: 20000,
        onload: (r) => { try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); } },
        onerror: () => reject(new Error("network error")),
        ontimeout: () => reject(new Error("timeout")),
      }));
    }
    return fetch(url).then((r) => r.json());
  }

  async function tornAPI(path) {
    const key = store.get("key", "");
    if (!key) throw new Error("no API key");
    const sep = path.includes("?") ? "&" : "?";
    const d = await getJSON(`https://api.torn.com/v2/${path}${sep}key=${encodeURIComponent(key)}&comment=PriceWatch`);
    if (d?.error) throw new Error(`Torn API: ${d.error.error}`);
    return d;
  }

  async function catalog() {
    const c = store.get("catalog", null);
    if (c && Date.now() - c.t < CATALOG_TTL_MS && c.items[0]?.length === 3) return c.items;
    const d = await tornAPI("torn/items");
    const items = (d.items || []).map((i) => [i.id, i.name, i.value?.market_price || 0]);
    store.set("catalog", { t: Date.now(), items });
    return items;
  }

  async function itemMarket(id) {
    const d = await tornAPI(`market/${id}/itemmarket`);
    return (d.itemmarket?.listings || []).map((l) => ({
      src: "Market", price: l.price, qty: l.amount, seller: "",
      key: `im:${id}:${l.price}`,  // no seller in the API: a partial buy must not re-alert
      url: `https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=${id}`,
    }));
  }

  async function bazaars(id) {
    const d = await getJSON(`https://weav3r.dev/api/marketplace/${id}`);
    return (d.listings || []).map((l) => ({
      src: "Bazaar", price: l.price, qty: l.quantity, seller: l.player_name,
      key: `bz:${l.player_id}:${id}:${l.price}`,
      url: `https://www.torn.com/bazaar.php?userId=${l.player_id}&tt-item-id=${id}`,  // TornTools outlines and scrolls to it
    }));
  }

  // ---------- polling (one tab at a time, shared through GM storage) ----------

  let busy = false;
  const pollSeconds = () => (POLL_CHOICES.includes(store.get("pollSeconds")) ? store.get("pollSeconds") : 30);

  async function poll(force = false) {
    const items = store.get("items", []);
    const every = pollSeconds() * 1000;
    if (busy || !items.length || !store.get("key", "") || (!force && store.get("paused", false))) return;
    if (!force && Date.now() - store.get("lastRun", 0) < every) return;
    busy = true;
    store.set("lastRun", Date.now());
    // matches = listings under the max at this check; a source that failed keeps its previous matches
    const best = store.get("best", {}), seen = store.get("seen", {}), old = store.get("matches", []);
    const matches = [], fresh = [];
    let error = "";
    for (const it of items) {
      const res = await Promise.allSettled([itemMarket(it.id), bazaars(it.id)]);
      const [im, bz] = res.map((r) => (r.status === "fulfilled" ? r.value : null));
      res.forEach((r) => { if (r.status === "rejected") error = String(r.reason?.message || r.reason); });
      // cheapest listing of each source, kept from the last check if that source failed
      const low = (l, prev) => (!l ? prev ?? null : l.reduce((a, x) => (!a || x.price < a.price ? x : a), null));
      const pick = (l) => l && { price: l.price, url: l.url };
      best[it.id] = { im: pick(low(im, best[it.id]?.im)), bz: pick(low(bz, best[it.id]?.bz)), t: Date.now() };
      [[im, "Market"], [bz, "Bazaar"]].forEach(([list, src]) => {
        if (!list) return matches.push(...old.filter((m) => m.id === it.id && m.src === src));
        for (const l of list) {
          if (l.price > it.max) continue;
          const m = { ...l, id: it.id, name: it.name, max: it.max };
          matches.push(m);
          if (!seen[l.key]) fresh.push(m);
          seen[l.key] = Date.now();
        }
      });
    }
    for (const k of Object.keys(seen)) if (Date.now() - seen[k] > SEEN_TTL_MS) delete seen[k];
    store.set("best", best);
    store.set("seen", seen);
    store.set("error", error);
    store.set("matches", matches);
    if (fresh.length) notify(fresh, matches);
    busy = false;
    render();
    paintBar();
  }

  // New listings trigger the alert, but it always points to the best current listing of the items concerned
  function notify(fresh, matches) {
    const ids = new Set(fresh.map((m) => m.id));
    const a = matches.filter((m) => ids.has(m.id)).sort((x, y) => x.price / x.max - y.price / y.max)[0];
    const text = listingText(a) + (fresh.length > 1 ? ` · ${fresh.length} new listings` : "");
    if (typeof GM_notification === "function") {
      try { GM_notification({ title: "Price Watch", text, onclick: () => window.open(a.url, "_blank") }); } catch {}
    }
    store.set("bar", [...ids]);
  }

  // ---------- UI ----------

  const money = (n) => (n == null ? "-" : "$" + Number(n).toLocaleString("en-US"));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let panel = null, open = store.get("open", false), tab = store.get("key", "") ? "watch" : "settings";
  let shareText = "", shareMsg = "";  // kept across re-renders (a poll redraws the panel)

  // Shared settings: watched items and check interval; the API key is never included
  const exportShared = () => JSON.stringify({ priceWatch: 1, items: store.get("items", []), pollSeconds: pollSeconds() });
  function importShared(text) {
    let d;
    try { d = JSON.parse(text); } catch { return "This is not valid JSON."; }
    const items = Array.isArray(d?.items) ? d.items : null;
    if (!items || !items.every((i) => Number.isInteger(i?.id) && typeof i.name === "string" && Number(i.max) > 0)) {
      return "These are not Price Watch settings.";
    }
    store.set("items", items.map((i) => ({ id: i.id, name: i.name, max: Number(i.max) })));
    if (POLL_CHOICES.includes(d.pollSeconds)) store.set("pollSeconds", d.pollSeconds);
    return "";
  }

  // Alert bar, styled like Torn Oracle's export alert: on top of the page content, every Torn tab, as long as
  // the alerted item has a listing under its max; the close button hides it until the next alert
  const BAR_ID = "price-watch-bar";
  const listingText = (a) => `${a.name}: ${money(a.price)} x${a.qty} (${a.src}${a.seller ? ", " + a.seller : ""})`;

  function paintBar() {
    const ids = store.get("bar", []), items = store.get("items", []);
    const maxOf = Object.fromEntries(items.map((i) => [i.id, i.max]));
    const a = store.get("matches", []).filter((m) => ids.includes(m.id) && m.price <= maxOf[m.id])
      .sort((x, y) => x.price / maxOf[x.id] - y.price / maxOf[y.id])[0];
    let bar = document.getElementById(BAR_ID);
    if (!a) { bar?.remove(); return; }
    if (!bar) {
      bar = document.createElement("div");
      bar.id = BAR_ID;
      bar.addEventListener("click", (e) => {
        if (!e.target.closest("[data-close]")) return;
        store.set("bar", []);
        paintBar();
      });
    }
    const wrap = document.querySelector(".content-wrapper");
    if (wrap) { if (wrap.firstChild !== bar) wrap.insertBefore(bar, wrap.firstChild); }
    else if (!bar.isConnected) document.body.prepend(bar);
    bar.classList.toggle("o-dark", document.body.classList.contains("dark-mode"));
    const html = `<div class="oa-line"><span class="oa-brand">Price Watch</span>
        <span class="oa-note">Under max price</span>
        <button type="button" class="oa-x" data-close title="Hide until the next alert">&times;</button></div>
      <a class="oa-go" href="${esc(a.url)}">${esc(listingText(a))}</a>`;
    if (bar.dataset.html !== html) { bar.innerHTML = html; bar.dataset.html = html; }
  }

  function ensureLauncher() {
    const current = document.getElementById(LAUNCHER_ID);
    if (current && !current.classList.contains("is-floating")) return;
    const list = document.querySelector('#sidebarroot ul[class*="status-icons_"], #sidebarroot ul[class*="statusIcons_"]');
    if (current && !list) return;
    current?.remove();  // the status icons showed up after the floating fallback
    const li = document.createElement(list ? "li" : "div");
    li.id = LAUNCHER_ID;
    if (!list) li.classList.add("is-floating");
    li.innerHTML = `<button type="button" title="Price Watch" aria-label="Price Watch">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.4 11.6 12.4 2.6A2 2 0 0 0 11 2H4a2 2 0 0 0-2 2v7c0 .55.22 1.05.59 1.42l9 9a2 2 0 0 0 2.82 0l7-7a2 2 0 0 0 0-2.82ZM6.5 8A1.5 1.5 0 1 1 6.5 5a1.5 1.5 0 0 1 0 3Z"/></svg></button>`;
    li.querySelector("button").addEventListener("click", (e) => { e.preventDefault(); open = !open; store.set("open", open); render(); });
    (list || document.body)[list ? "prepend" : "appendChild"](li);
  }

  function render() {
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "price-watch-panel";
      document.body.appendChild(panel);
      panel.addEventListener("click", onClick);
      panel.addEventListener("submit", onSubmit);
      panel.addEventListener("change", onChange);
      panel.addEventListener("input", (e) => { if (e.target.name === "share") shareText = e.target.value; });
    }
    panel.classList.toggle("o-dark", document.body.classList.contains("dark-mode"));
    panel.classList.toggle("is-open", open);
    document.querySelector(`#${LAUNCHER_ID} button`)?.setAttribute("aria-expanded", String(open));
    if (!open) return;
    const items = store.get("items", []), best = store.get("best", {});
    const maxOf = Object.fromEntries(items.map((i) => [i.id, i.max]));
    // listings of the item picked in the dropdown (remembered; first watch if it was removed)
    const shownId = items.some((i) => i.id === store.get("shown")) ? store.get("shown") : items[0]?.id;
    const matches = store.get("matches", []).filter((m) => m.id === shownId && m.price <= maxOf[m.id])
      .sort((a, b) => a.price - b.price);
    const key = store.get("key", ""), error = store.get("error", ""), last = store.get("lastRun", 0);
    const paused = store.get("paused", false);
    const mv = Object.fromEntries((store.get("catalog", null)?.items || []).map(([id, , v]) => [id, v]));
    const rows = items.map((it) => {
      const b = best[it.id] || {};
      const hit = (l) => (l?.price != null && l.price <= it.max ? "go" : "");
      const cell = (l) => (l?.url ? `<a class="o-best" href="${esc(l.url)}">${money(l.price)}</a>` : money(l?.price ?? (typeof l === "number" ? l : null)));
      return `<tr><td>${esc(it.name)}${mv[it.id] ? `<span class="o-sub">Market value: ${money(mv[it.id])}</span>` : ""}</td>
        <td class="num"><input type="number" class="o-max" data-id="${it.id}" value="${it.max}" min="1"></td>
        <td class="num ${hit(b.im)}">${cell(b.im)}</td><td class="num ${hit(b.bz)}">${cell(b.bz)}</td>
        <td><button class="o-icon" data-del="${it.id}" title="Remove">✕</button></td></tr>`;
    }).join("");
    const alertRows = matches.slice(0, 5).map((a) => `<tr><td><a href="${esc(a.url)}" target="_blank">${a.src}</a>
        <span class="o-sub">${a.seller ? esc(a.seller) : "Item market"}</span></td>
        <td class="num go">${money(a.price)}</td><td class="num">x${a.qty}</td></tr>`).join("");
    panel.innerHTML = `
      <div class="o-head"><span class="o-dot ${error ? "is-bad" : key && !paused ? "is-live" : "is-warn"}"></span>
        <span class="o-brand">Price Watch</span>
        <span class="o-head-line">${paused ? "Paused" : error ? esc(error) : last ? "Last check " + new Date(last).toLocaleTimeString() : "Not checked yet"}</span>
        <button class="o-btn ${paused ? "is-primary" : ""}" data-act="pause">${paused ? "Resume" : "Pause"}</button>
        <button class="o-icon" data-act="close" title="Close">✕</button></div>
      <div class="o-tabs">
        <button class="o-tab ${tab === "watch" ? "is-on" : ""}" data-tab="watch">Watch</button>
        <button class="o-tab ${tab === "settings" ? "is-on" : ""}" data-tab="settings">Settings</button></div>
      <div class="o-body${tab === "watch" ? " is-watch" : ""}">${tab === "settings" ? `
        <h4>Check every</h4>
        <div class="o-acts"><select name="poll">${POLL_CHOICES.map((s) => `<option value="${s}"${s === pollSeconds() ? " selected" : ""}>${s < 60 ? s + " s" : s / 60 + " min"}</option>`).join("")}</select></div>
        <h4>API key</h4>
        <form class="o-acts" data-form="key">
          <input type="password" name="key" placeholder="Public Only API key" value="${esc(key)}" class="o-grow">
          <button class="o-btn">Save key</button></form>
        <p class="o-note">A <b>Public Only</b> key is enough. It stays in your userscript manager and is only sent to api.torn.com.</p>
        <p class="o-note">Market: Torn API. Bazaars: weav3r.dev (community data, can lag a few minutes). Nothing is ever bought for you.</p>
        <h4>Share settings</h4>
        <p class="o-note">Watched items, max prices and check interval. Your API key is not included. Importing replaces your watch list.</p>
        <textarea class="o-share" name="share" rows="5" spellcheck="false" placeholder="Paste settings here to import them">${esc(shareText)}</textarea>
        <div class="o-acts">
          <button class="o-btn" data-act="share-export">Copy my settings</button>
          <button class="o-btn" data-act="share-import">Import</button></div>
        ${shareMsg ? `<p class="o-note">${esc(shareMsg)}</p>` : ""}
        ${VERSION ? `<p class="o-note">Price Watch v${esc(VERSION)}</p>` : ""}` : `
        ${key ? "" : `<div class="o-banner">Enter a <b>Public Only</b> API key in Settings to start.</div>`}
        <form class="o-acts o-add" data-form="add">
          <input type="text" name="name" list="price-watch-items" placeholder="Item name" class="o-grow" required>
          <input type="number" name="max" placeholder="Max price" min="1" required>
          <button class="o-btn is-primary">Add</button></form>
        <datalist id="price-watch-items"></datalist>
        <div class="o-scroll o-list"><table><thead><tr><th>Item</th><th class="num">Max</th><th class="num">Market</th><th class="num">Bazaar</th><th></th></tr></thead>
          <tbody>${rows || `<tr><td colspan="5" class="o-empty">No item watched yet.</td></tr>`}</tbody></table></div>
        <h4 class="o-h-pick">Under max price${matches.length ? ` (${matches.length})` : ""}
          ${items.length ? `<select name="shown">${items.map((i) => `<option value="${i.id}"${i.id === shownId ? " selected" : ""}>${esc(i.name)}</option>`).join("")}</select>` : ""}</h4>
        <div class="o-scroll"><table><tbody>${alertRows || `<tr><td class="o-empty">Nothing under your max price.</td></tr>`}</tbody></table></div>
        <div class="o-acts">
          <button class="o-btn" data-act="check">Check now</button>
        </div>`}
      </div>`;
    fillCatalog();
  }

  async function fillCatalog() {
    if (!store.get("key", "")) return;
    try {
      const before = store.get("catalog", null)?.t;
      const items = await catalog();
      if (store.get("catalog", null)?.t !== before) return render();  // fresh market values
      const dl = panel.querySelector("#price-watch-items");
      if (dl && !dl.children.length) dl.innerHTML = items.map(([, n]) => `<option value="${esc(n)}">`).join("");
    } catch {}
  }

  function onClick(e) {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.tab) { tab = b.dataset.tab; shareMsg = ""; render(); }
    else if (b.dataset.act === "share-export") {
      shareText = exportShared();
      navigator.clipboard.writeText(shareText).then(() => "Settings copied.", () => "Settings are in the box. Copy them from there.")
        .then((m) => { shareMsg = m; render(); });
    } else if (b.dataset.act === "share-import") {
      if (!shareText.trim()) { shareMsg = "Paste settings into the box first."; render(); return; }
      const err = importShared(shareText.trim());
      shareMsg = err || `Imported ${store.get("items", []).length} watched items.`;
      if (!err) { shareText = ""; poll(true); }
      render();
    }
    else if (b.dataset.del) {
      store.set("items", store.get("items", []).filter((i) => String(i.id) !== b.dataset.del));
      render();
    } else if (b.dataset.act === "close") { open = false; store.set("open", false); render(); }
    else if (b.dataset.act === "check") poll(true);
    else if (b.dataset.act === "pause") { store.set("paused", !store.get("paused", false)); render(); }
  }

  async function onSubmit(e) {
    e.preventDefault();
    const f = e.target, data = new FormData(f);
    if (f.dataset.form === "key") {
      store.set("key", String(data.get("key")).trim());
      store.set("error", "");
      tab = "watch";
      render();
      return;
    }
    const name = String(data.get("name")).trim().toLowerCase(), max = Number(data.get("max"));
    try {
      const hit = (await catalog()).find(([, n]) => n.toLowerCase() === name);
      if (!hit) throw new Error(`unknown item "${data.get("name")}"`);
      const items = store.get("items", []).filter((i) => i.id !== hit[0]);
      store.set("items", [...items, { id: hit[0], name: hit[1], max }]);
      store.set("error", "");
      render();
      poll(true);
    } catch (err) {
      store.set("error", String(err.message || err));
      render();
    }
  }

  function onChange(e) {
    const t = e.target;
    if (t.classList.contains("o-max")) {
      store.set("items", store.get("items", []).map((i) => (String(i.id) === t.dataset.id ? { ...i, max: Number(t.value) } : i)));
      render();
      poll(true);  // a higher max needs listings the last check did not keep
    } else if (t.name === "poll") store.set("pollSeconds", Number(t.value));
    else if (t.name === "shown") { store.set("shown", Number(t.value)); render(); }
  }

  // ---------- style (from Torn Oracle: Travel) ----------

  const CSS = `
#price-watch-panel {
  --o-bg: #ffffff; --o-bg-sunk: #f4f6f8; --o-bg-raise: #ffffff; --o-line: #dde3e9;
  --o-text: #10161c; --o-dim: #4a5763; --o-faint: #626f7c; --o-accent: #0d9488;
  --o-go: #047857; --o-warn: #b45309; --o-bad: #b91c1c; --o-bad-soft: #fee2e2;
  --o-radius: 10px;
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483646;
  width: min(420px, calc(100vw - 24px)); max-height: min(650px, calc(100vh - 36px)); max-height: min(650px, calc(100dvh - 36px));
  display: none; flex-direction: column; box-sizing: border-box;
  border: 1px solid var(--o-line); border-radius: var(--o-radius);
  background: var(--o-bg); color: var(--o-text); box-shadow: 0 18px 50px rgba(0,0,0,.35);
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; overflow: hidden;
  color-scheme: light;
}
#price-watch-panel.o-dark {
  --o-bg: #171d24; --o-bg-sunk: #10151b; --o-bg-raise: #1e262f; --o-line: #2c3742;
  --o-text: #e7edf3; --o-dim: #b3c0cd; --o-faint: #97a5b3; --o-accent: #2dd4bf;
  --o-go: #34d399; --o-warn: #fbbf24; --o-bad: #f87171; --o-bad-soft: #450a0a;
  color-scheme: dark;
}
#price-watch-panel.is-open { display: flex; }
#price-watch-panel *, #price-watch-panel *::before, #price-watch-panel *::after { box-sizing: border-box; }
#price-watch-panel table, #price-watch-panel td, #price-watch-panel th, #price-watch-panel p,
#price-watch-panel h4, #price-watch-panel span, #price-watch-panel label, #price-watch-panel div {
  color: inherit; font-family: inherit; font-size: inherit; line-height: inherit;
}
#price-watch-panel .o-head {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  background: var(--o-bg-raise); border-bottom: 1px solid var(--o-line);
}
#price-watch-panel .o-brand { font-weight: 700; letter-spacing: .02em; color: var(--o-accent); }
#price-watch-panel .o-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--o-faint); flex: 0 0 auto; }
#price-watch-panel .o-dot.is-live { background: var(--o-go); }
#price-watch-panel .o-dot.is-warn { background: var(--o-warn); }
#price-watch-panel .o-dot.is-bad { background: var(--o-bad); }
#price-watch-panel .o-head-line { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--o-dim); }
#price-watch-panel .o-body { padding: 10px; overflow-y: auto; }
#price-watch-panel .o-tabs { display: flex; gap: 2px; padding: 6px 6px 0; background: var(--o-bg-raise); border-bottom: 1px solid var(--o-line); }
#price-watch-panel .o-tab {
  appearance: none; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--o-dim);
  font: inherit; font-weight: 600; padding: 7px 11px; border-radius: 8px 8px 0 0; cursor: pointer;
}
#price-watch-panel .o-tab:hover { color: var(--o-text); background: var(--o-bg-sunk); }
#price-watch-panel .o-tab.is-on { color: var(--o-accent); border-bottom-color: var(--o-accent); background: var(--o-bg); }
#price-watch-panel .o-body > h4:first-child { margin-top: 0; }
#price-watch-panel h4 { margin: 14px 0 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--o-faint); }
#price-watch-panel .o-scroll { overflow-x: auto; }
/* Watch tab: only the watched list scrolls, the rest stays in view */
#price-watch-panel .o-body.is-watch { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow: hidden; }
#price-watch-panel .o-body.is-watch > * { flex: 0 0 auto; }
#price-watch-panel .o-body.is-watch > .o-list { flex: 1 1 auto; min-height: 110px; overflow-y: auto; }
#price-watch-panel .o-list thead th { position: sticky; top: 0; z-index: 1; background: var(--o-bg); }
#price-watch-panel table { width: 100%; border-collapse: collapse; font-size: 12px; }
#price-watch-panel th { text-align: left; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--o-faint); padding: 6px 8px; border-bottom: 1px solid var(--o-line); white-space: nowrap; }
#price-watch-panel td { padding: 7px 8px; border-bottom: 1px solid var(--o-line); vertical-align: middle; }
#price-watch-panel tbody tr:last-child td { border-bottom: 0; }
#price-watch-panel .num { text-align: right; font-variant-numeric: tabular-nums; }
#price-watch-panel .o-sub { display: block; font-size: 10px; color: var(--o-faint); }
#price-watch-panel .go { color: var(--o-go); font-weight: 600; }
#price-watch-panel a { color: var(--o-accent); }
#price-watch-panel a.o-best { color: inherit; text-decoration: underline; text-decoration-color: var(--o-line); text-underline-offset: 3px; }
#price-watch-panel a.o-best:hover { text-decoration-color: currentColor; }
#price-watch-panel .o-empty { padding: 16px 10px; text-align: center; color: var(--o-faint); }
#price-watch-panel button.o-btn {
  appearance: none; font: inherit; font-weight: 600; cursor: pointer; padding: 6px 12px; border-radius: 8px;
  border: 1px solid var(--o-line); background: var(--o-bg-raise); color: var(--o-text);
}
#price-watch-panel button.o-btn:hover { border-color: var(--o-accent); color: var(--o-accent); }
#price-watch-panel button.o-btn.is-primary { background: var(--o-accent); border-color: var(--o-accent); color: #fff; }
#price-watch-panel button.o-icon { appearance: none; border: 0; background: transparent; color: var(--o-dim); padding: 4px 6px; border-radius: 6px; cursor: pointer; }
#price-watch-panel button.o-icon:hover { background: var(--o-bg-sunk); color: var(--o-accent); }
#price-watch-panel button.o-link { appearance: none; border: 0; background: transparent; font: inherit; font-size: 11px; color: var(--o-accent); cursor: pointer; text-decoration: underline; }
#price-watch-panel input[type=text], #price-watch-panel input[type=number], #price-watch-panel input[type=password], #price-watch-panel select {
  font: inherit; padding: 5px 7px; border-radius: 7px; border: 1px solid var(--o-line);
  background: var(--o-bg); color: var(--o-text); max-width: 100%; min-width: 0;
}
#price-watch-panel textarea.o-share {
  display: block; width: 100%; margin-top: 8px; font: 11px/1.4 ui-monospace, Consolas, monospace; padding: 6px 7px;
  border-radius: 7px; border: 1px solid var(--o-line); background: var(--o-bg); color: var(--o-text); resize: vertical;
}
#price-watch-panel input.o-max { width: 8.5em; text-align: right; }
#price-watch-panel input[name=max] { width: 8em; }
#price-watch-panel input:focus-visible, #price-watch-panel button:focus-visible { outline: 2px solid var(--o-accent); outline-offset: 1px; }
#price-watch-panel .o-acts { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 10px; }
#price-watch-panel .o-grow { flex: 1 1 auto; }
#price-watch-panel .o-add { margin: 0 0 10px; }
#price-watch-panel h4.o-h-pick { display: flex; align-items: center; gap: 8px; }
#price-watch-panel h4.o-h-pick select { flex: 0 1 auto; min-width: 0; text-transform: none; letter-spacing: 0; font-size: 12px; font-weight: 600; color: var(--o-text); }
#price-watch-panel .o-note { margin: 10px 0 0; font-size: 11px; color: var(--o-dim); }
#price-watch-panel .o-banner { margin-bottom: 10px; padding: 8px 10px; border-radius: 8px; background: var(--o-bad-soft); color: var(--o-bad); font-size: 12px; }
#${LAUNCHER_ID} { list-style: none; display: inline-flex; width: 34px; height: 34px; margin: 0; padding: 0; background: none; }
#${LAUNCHER_ID}.is-floating { position: fixed; right: 18px; bottom: 18px; z-index: 2147483645; }
#${LAUNCHER_ID} button {
  all: unset; display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px;
  border-radius: 7px; color: #7d858f; cursor: pointer;
}
#${LAUNCHER_ID} button:hover, #${LAUNCHER_ID} button[aria-expanded="true"] { color: #0d9488; background: rgba(13,148,136,.12); }
#${LAUNCHER_ID} svg { width: 20px; height: 20px; }
#${BAR_ID} { --oa-bg: #fff; --oa-line: #dde3e9; --oa-dim: #4a5763; --oa-accent: #0d9488;
  position: sticky; top: 0; z-index: 50; box-sizing: border-box; width: 100%; margin: 0 0 8px;
  padding: 8px 10px; border: 1px solid var(--oa-line); border-radius: 10px; background: var(--oa-bg);
  color: #10161c; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
#${BAR_ID}.o-dark { --oa-bg: #171d24; --oa-line: #2c3742; --oa-dim: #b3c0cd; --oa-accent: #2dd4bf; color: #e7edf3; }
#${BAR_ID} .oa-line { display: flex; gap: 8px; align-items: baseline; margin-bottom: 6px; }
#${BAR_ID} .oa-brand { font-weight: 700; font-size: 11px; color: var(--oa-accent); }
#${BAR_ID} .oa-note { font-size: 12px; color: var(--oa-dim); flex: 1; }
#${BAR_ID} .oa-x { background: none; border: 0; color: var(--oa-dim); font-size: 18px; line-height: 1; cursor: pointer; }
#${BAR_ID} a.oa-go { display: flex; align-items: center; justify-content: center; box-sizing: border-box;
  width: 100%; min-height: 44px; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--oa-accent);
  background: var(--oa-accent); color: #fff; font-size: 15px; font-weight: 700; text-align: center;
  text-decoration: none; }`;

  // ---------- start ----------

  const style = document.createElement("style");
  style.textContent = CSS;
  (document.head || document.documentElement).appendChild(style);
  new MutationObserver(ensureLauncher).observe(document.documentElement, { childList: true, subtree: true });
  ensureLauncher();
  if (open) render();  // reopen the panel if it was open on the previous page
  setInterval(() => { poll(); paintBar(); }, TICK_MS);
  poll();
})();

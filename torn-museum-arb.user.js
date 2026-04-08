// ==UserScript==
// @name         Torn Museum Arbitrage Helper (API Truth + Tab Coordination)
// @namespace    https://torn.com/
// @version      0.4.0
// @description  Read-only plushie/flower set helper. API prices drive all math; page is only used for highlighting. One tab acts as leader and performs API calls for all tabs.
// @author       GPT-5.4 Thinking
// @match        https://www.torn.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// ==/UserScript==

(function () {
  'use strict';

  const STORE_KEYS = {
    settings: 'tmh_settings_v4',
    holdings: 'tmh_holdings_v4',
    alertState: 'tmh_alert_state_v4',
    hiddenPaths: 'tmh_hidden_paths_v4',
    watchlist: 'tmh_watchlist_v4',
    leader: 'tmh_leader_v4',
    sharedCache: 'tmh_shared_cache_v4',
  };

  const CHANNEL_NAME = 'tmh_channel_v4';

  const DEFAULTS = {
    apiKey: '',
    scanSeconds: 1,
    apiRefreshSeconds: 1,
    roiThresholdPct: 2,
    alertCooldownSeconds: 90,
    minMarketValuePct: 70,
    maxMarketValuePct: 99.5,
    fadeSeconds: 8,
    alertsEnabled: true,
    moveablePanel: true,
    useApiInventory: true,
  };

  const CATEGORY_URLS = {
    Flower: 'https://www.torn.com/page.php?sid=ItemMarket#/market/view=category&categoryName=Flower',
    Plushie: 'https://www.torn.com/page.php?sid=ItemMarket#/market/view=category&categoryName=Plushie',
  };

  const REQUIRED_SET_NAMES = {
    Plushie: new Set([
      'Sheep Plushie',
      'Kitten Plushie',
      'Teddy Bear Plushie',
      'Wolverine Plushie',
      'Stingray Plushie',
      'Chamois Plushie',
      'Jaguar Plushie',
      'Nessie Plushie',
      'Red Fox Plushie',
      'Monkey Plushie',
      'Panda Plushie',
      'Lion Plushie',
      'Camel Plushie',
    ]),
    Flower: new Set([
      'African Violet',
      'Banana Orchid',
      'Ceibo Flower',
      'Cherry Blossom',
      'Crocus',
      'Dahlia',
      'Edelweiss',
      'Heather',
      'Orchid',
      'Peony',
      'Tribulus Omanense',
    ]),
  };

  const state = {
    tabId: `tmh_${Math.random().toString(36).slice(2)}_${Date.now()}`,
    isLeader: false,
    bc: null,

    settings: { ...DEFAULTS },
    holdings: {},
    items: [],
    pointsPrice: null,
    marketValueById: new Map(),
    apiPricesById: new Map(),
    apiHoldings: {},
    metrics: null,
    lastApiRefresh: 0,
    lastLeaderSeenAt: 0,
    panel: null,
    body: null,
    lastInteraction: Date.now(),
    dragging: null,
    paused: false,
    watchlist: [],
  };

  function now() {
    return Date.now();
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function loadState() {
    state.settings = { ...DEFAULTS, ...(GM_getValue(STORE_KEYS.settings, {}) || {}) };
    state.settings.scanSeconds = clamp(Number(state.settings.scanSeconds) || 1, 1, 60);
    state.settings.apiRefreshSeconds = clamp(Number(state.settings.apiRefreshSeconds) || 1, 1, 600);
    state.settings.roiThresholdPct = clamp(Number(state.settings.roiThresholdPct) || 2, 0, 1000);
    state.settings.alertCooldownSeconds = clamp(Number(state.settings.alertCooldownSeconds) || 90, 5, 3600);
    state.settings.minMarketValuePct = clamp(Number(state.settings.minMarketValuePct) || 70, 1, 200);
    state.settings.maxMarketValuePct = clamp(Number(state.settings.maxMarketValuePct) || 99.5, 1, 200);
    state.holdings = GM_getValue(STORE_KEYS.holdings, {}) || {};
    state.watchlist = GM_getValue(STORE_KEYS.watchlist, []) || [];
  }

  function saveSettings() {
    GM_setValue(STORE_KEYS.settings, state.settings);
    broadcast({ type: 'settings-updated', settings: state.settings });
  }

  function saveHoldings() {
    GM_setValue(STORE_KEYS.holdings, state.holdings);
  }

  function saveWatchlist() {
    GM_setValue(STORE_KEYS.watchlist, state.watchlist);
  }

  function fmtMoney(v) {
    return '$' + Math.round(v || 0).toLocaleString();
  }

  function fmtPct(v, digits = 1) {
    return `${Number(v || 0).toFixed(digits)}%`;
  }

  function markInteraction() {
    state.lastInteraction = now();
    if (state.panel) state.panel.style.opacity = '1';
  }

  function applyFade() {
    if (!state.panel) return;
    const idleMs = now() - state.lastInteraction;
    const threshold = state.settings.fadeSeconds * 1000;
    state.panel.style.opacity = idleMs > threshold ? '0.45' : '1';
  }

  function mvBand() {
    return {
      min: Math.min(state.settings.minMarketValuePct, state.settings.maxMarketValuePct),
      max: Math.max(state.settings.minMarketValuePct, state.settings.maxMarketValuePct),
    };
  }

  function confidenceLabel(coverage, apiAgeMs) {
    if (coverage > 0.9 && apiAgeMs < 90_000) return 'High';
    if (coverage > 0.6 && apiAgeMs < 300_000) return 'Medium';
    return 'Low';
  }

  function marketValuePercent(price, refValue) {
    return refValue > 0 ? (price / refValue) * 100 : 999999;
  }

  function itemBandStatus(mvPct) {
    const band = mvBand();
    if (mvPct >= band.min && mvPct <= band.max) return 'in';
    if (mvPct < band.min) return 'too-cheap';
    return 'too-expensive';
  }

  function decisionLabel({ inBand, supportsProfitableSet }) {
    if (inBand && supportsProfitableSet) return 'BUY';
    if (inBand) return 'MAYBE';
    return 'IGNORE';
  }

  function reasonText(item, catBuyable) {
    if (!item) return 'No reason available';
    if (!item.inBand) {
      if (item.mvPct > mvBand().max) {
        return `${item.name} is ${fmtPct(item.mvPct)} of MV, above your max band of ${fmtPct(mvBand().max)}.`;
      }
      return `${item.name} is ${fmtPct(item.mvPct)} of MV, below your min band of ${fmtPct(mvBand().min)}.`;
    }
    if (catBuyable) {
      return `${item.name} is ${fmtPct(item.mvPct)} of MV and supports a set currently above your ROI threshold.`;
    }
    return `${item.name} is inside your MV band, but the set ROI is below your threshold right now.`;
  }

  function itemSortScore(item) {
    if (!item || !item.refValue || !item.price) return -Infinity;
    const discountValue = item.refValue - item.price;
    const setSupport = item.supportsProfitableSet ? 1_000_000_000 : 0;
    return setSupport + discountValue;
  }

  function broadcast(message) {
    try {
      if (state.bc) state.bc.postMessage({ ...message, sender: state.tabId, at: now() });
    } catch (_) {}
  }

  function initBroadcastChannel() {
    try {
      state.bc = new BroadcastChannel(CHANNEL_NAME);
      state.bc.onmessage = (event) => {
        const msg = event.data || {};
        if (msg.sender === state.tabId) return;

        if (msg.type === 'leader-heartbeat') {
          state.lastLeaderSeenAt = now();
          if (msg.leaderId && msg.leaderId !== state.tabId) {
            state.isLeader = false;
          }
          render();
          return;
        }

        if (msg.type === 'cache-updated') {
          applySharedCache(msg.cache);
          render();
          return;
        }

        if (msg.type === 'settings-updated' && msg.settings) {
          state.settings = { ...state.settings, ...msg.settings };
          render();
          return;
        }

        if (msg.type === 'leader-resigned') {
          state.lastLeaderSeenAt = 0;
          return;
        }
      };
    } catch (_) {
      state.bc = null;
    }
  }

  function readLeaderRecord() {
    return GM_getValue(STORE_KEYS.leader, null);
  }

  function writeLeaderRecord() {
    const record = {
      leaderId: state.tabId,
      heartbeatAt: now(),
    };
    GM_setValue(STORE_KEYS.leader, record);
  }

  function clearLeaderRecord() {
    const record = readLeaderRecord();
    if (record && record.leaderId === state.tabId) {
      GM_setValue(STORE_KEYS.leader, null);
    }
  }

  function heartbeatLeader() {
    if (!state.isLeader) return;
    writeLeaderRecord();
    broadcast({ type: 'leader-heartbeat', leaderId: state.tabId });
  }

  function maybeBecomeLeader() {
    const record = readLeaderRecord();
    const currentTime = now();
    const staleMs = 4000;

    if (!record || !record.leaderId || (currentTime - Number(record.heartbeatAt || 0)) > staleMs) {
      state.isLeader = true;
      writeLeaderRecord();
      state.lastLeaderSeenAt = currentTime;
      broadcast({ type: 'leader-heartbeat', leaderId: state.tabId });
      return;
    }

    state.isLeader = record.leaderId === state.tabId;
    if (!state.isLeader) {
      state.lastLeaderSeenAt = currentTime;
    }
  }

  function showReopenButton(pathKey) {
    let btn = document.querySelector('#tmh-reopen');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'tmh-reopen';
      btn.textContent = 'Open Museum Arb';
      document.body.appendChild(btn);
    }
    btn.style.display = 'block';
    btn.onclick = () => {
      const hidden = GM_getValue(STORE_KEYS.hiddenPaths, {});
      delete hidden[pathKey];
      GM_setValue(STORE_KEYS.hiddenPaths, hidden);
      if (state.panel) state.panel.style.display = 'block';
      btn.style.display = 'none';
      markInteraction();
    };
  }

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'tmh-panel';
    const pathKey = `${location.pathname}${location.hash || ''}`;

    panel.innerHTML = `
      <div id="tmh-head">
        <span>Museum Arb</span>
        <span id="tmh-head-right">
          <span id="tmh-status">idle</span>
          <button id="tmh-pause" title="Pause scanning">Pause</button>
          <button id="tmh-exit" title="Hide on this page">✕</button>
        </span>
      </div>

      <div id="tmh-toolbar">
        <button id="tmh-refresh-now">Refresh Now</button>
      </div>

      <div id="tmh-body"></div>

      <details id="tmh-settings-wrap">
        <summary>Settings</summary>
        <label>API Key <input id="tmh-api-key" type="password" placeholder="Torn API key" /></label>
        <label>Scan seconds <input id="tmh-scan" type="number" min="1" step="1" /></label>
        <label>API refresh seconds <input id="tmh-refresh" type="number" min="1" step="1" /></label>
        <label>ROI threshold % <input id="tmh-roi" type="number" min="0" step="0.1" /></label>
        <label>Alert cooldown sec <input id="tmh-cool" type="number" min="5" step="5" /></label>
        <label>Min market value % <input id="tmh-min-mv" type="number" min="1" step="0.1" /></label>
        <label>Max market value % <input id="tmh-max-mv" type="number" min="1" step="0.1" /></label>
        <button id="tmh-save">Save</button>
      </details>

      <details id="tmh-holdings-wrap">
        <summary>Holdings</summary>
        <div id="tmh-holdings"></div>
      </details>

      <details id="tmh-history-wrap" open>
        <summary>Recent opportunities</summary>
        <div id="tmh-history"></div>
      </details>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #tmh-panel {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 99999;
        width: 390px;
        max-height: 88vh;
        overflow: auto;
        background: rgba(17,17,17,.96);
        color: #f4f4f4;
        border: 1px solid #3b3b3b;
        border-radius: 12px;
        font: 12px/1.4 Arial, sans-serif;
        box-shadow: 0 8px 20px rgba(0,0,0,.35);
        transition: opacity .2s ease;
      }
      #tmh-head {
        padding: 8px 10px;
        cursor: move;
        font-weight: 700;
        border-bottom: 1px solid #2e2e2e;
        display:flex;
        justify-content:space-between;
        align-items:center;
      }
      #tmh-head-right {
        display:flex;
        gap:6px;
        align-items:center;
      }
      #tmh-head button, #tmh-toolbar button {
        border:0;
        background:#444;
        color:#fff;
        border-radius:6px;
        padding:4px 8px;
        cursor:pointer;
      }
      #tmh-exit {
        width:22px;
        height:22px;
        line-height:22px;
        padding:0;
        font-weight:700;
      }
      #tmh-toolbar {
        padding:8px 10px;
        border-bottom: 1px solid #2e2e2e;
      }
      #tmh-toolbar button {
        width:100%;
        background:#4f79ff;
      }
      #tmh-body {
        padding: 8px 10px;
      }
      #tmh-panel details {
        padding: 6px 10px;
        border-top:1px solid #2e2e2e;
      }
      #tmh-panel label {
        display:block;
        margin: 5px 0;
      }
      #tmh-panel input {
        width: 100%;
        box-sizing:border-box;
        background:#242424;
        color:#fff;
        border:1px solid #444;
        border-radius:6px;
        padding:4px 6px;
      }
      #tmh-panel details button {
        width:100%;
        margin-top: 6px;
        border:0;
        background:#4f79ff;
        color:#fff;
        border-radius:6px;
        padding:6px;
        cursor:pointer;
      }
      .tmh-section {
        margin-bottom:10px;
        padding:8px;
        background:#1a1a1a;
        border:1px solid #2c2c2c;
        border-radius:10px;
      }
      .tmh-title {
        font-weight:700;
        margin-bottom:6px;
      }
      .tmh-row {
        display:flex;
        justify-content:space-between;
        gap:8px;
        margin:3px 0;
      }
      .tmh-inline {
        display:flex;
        gap:6px;
        align-items:center;
        flex-wrap:wrap;
      }
      .tmh-badge {
        display:inline-block;
        padding:2px 6px;
        border-radius:999px;
        font-size:11px;
        font-weight:700;
      }
      .tmh-buy { background:#75f587; color:#111; }
      .tmh-maybe { background:#ffd76c; color:#111; }
      .tmh-ignore { background:#ff8e8e; color:#111; }
      .tmh-good { color:#75f587; font-weight:700; }
      .tmh-warn { color:#ffd76c; font-weight:700; }
      .tmh-bad { color:#ff8e8e; font-weight:700; }
      .tmh-small {
        font-size:11px;
        color:#cfcfcf;
      }
      .tmh-reason {
        margin-top:4px;
        color:#ddd;
      }
      .tmh-list-entry {
        padding:6px 0;
        border-bottom:1px solid #2b2b2b;
      }
      .tmh-list-entry:last-child {
        border-bottom:0;
      }
      .tmh-highlight {
        outline: 2px solid #75f587 !important;
        box-shadow: 0 0 0 2px rgba(117,245,135,.2) inset !important;
      }
      .tmh-page-badge {
        position: fixed;
        right: 16px;
        top: 0;
        transform: translateY(-100%);
        background:#75f587;
        color:#111;
        font-weight:700;
        padding: 4px 8px;
        border-radius: 0 0 8px 8px;
        z-index:99999;
      }
      #tmh-reopen {
        position: fixed;
        right: 16px;
        top: 16px;
        z-index: 99999;
        border: 1px solid #3b3b3b;
        background:#1b1b1b;
        color:#fff;
        padding: 6px 8px;
        border-radius: 8px;
        cursor:pointer;
      }
    `;

    document.head.appendChild(style);
    document.body.appendChild(panel);

    state.panel = panel;
    state.body = panel.querySelector('#tmh-body');

    panel.addEventListener('mouseenter', markInteraction);
    panel.addEventListener('mousemove', markInteraction);

    panel.querySelector('#tmh-save').addEventListener('click', () => {
      state.settings.apiKey = panel.querySelector('#tmh-api-key').value.trim();
      state.settings.scanSeconds = clamp(Number(panel.querySelector('#tmh-scan').value) || 1, 1, 60);
      state.settings.apiRefreshSeconds = clamp(Number(panel.querySelector('#tmh-refresh').value) || 1, 1, 600);
      state.settings.roiThresholdPct = clamp(Number(panel.querySelector('#tmh-roi').value) || 2, 0, 1000);
      state.settings.alertCooldownSeconds = clamp(Number(panel.querySelector('#tmh-cool').value) || 90, 5, 3600);
      state.settings.minMarketValuePct = clamp(Number(panel.querySelector('#tmh-min-mv').value) || 70, 1, 200);
      state.settings.maxMarketValuePct = clamp(Number(panel.querySelector('#tmh-max-mv').value) || 99.5, 1, 200);
      saveSettings();
      state.metrics = state.items.length ? getSetMetrics(state.items) : null;
      render();
      markInteraction();
    });

    panel.querySelector('#tmh-api-key').value = state.settings.apiKey;
    panel.querySelector('#tmh-scan').value = String(state.settings.scanSeconds);
    panel.querySelector('#tmh-refresh').value = String(state.settings.apiRefreshSeconds);
    panel.querySelector('#tmh-roi').value = String(state.settings.roiThresholdPct);
    panel.querySelector('#tmh-cool').value = String(state.settings.alertCooldownSeconds);
    panel.querySelector('#tmh-min-mv').value = String(state.settings.minMarketValuePct);
    panel.querySelector('#tmh-max-mv').value = String(state.settings.maxMarketValuePct);

    panel.querySelector('#tmh-refresh-now').addEventListener('click', async () => {
      if (!state.isLeader) {
        const status = panel.querySelector('#tmh-status');
        status.textContent = 'follower';
        return;
      }
      const status = panel.querySelector('#tmh-status');
      status.textContent = 'refreshing';
      markInteraction();
      await refreshDataIfNeeded(true);
      state.metrics = state.items.length ? getSetMetrics(state.items) : null;
      render();
    });

    panel.querySelector('#tmh-pause').addEventListener('click', () => {
      state.paused = !state.paused;
      panel.querySelector('#tmh-pause').textContent = state.paused ? 'Resume' : 'Pause';
      const status = panel.querySelector('#tmh-status');
      status.textContent = state.paused ? 'paused' : (state.isLeader ? 'leader' : 'follower');
      markInteraction();
    });

    panel.querySelector('#tmh-exit').addEventListener('click', (e) => {
      e.stopPropagation();
      const hidden = GM_getValue(STORE_KEYS.hiddenPaths, {});
      hidden[pathKey] = true;
      GM_setValue(STORE_KEYS.hiddenPaths, hidden);
      panel.style.display = 'none';
      showReopenButton(pathKey);
    });

    const head = panel.querySelector('#tmh-head');
    head.addEventListener('mousedown', (e) => {
      if (!state.settings.moveablePanel) return;
      state.dragging = {
        x: e.clientX,
        y: e.clientY,
        left: panel.offsetLeft,
        top: panel.offsetTop,
      };
      markInteraction();
    });

    window.addEventListener('mouseup', () => { state.dragging = null; });
    window.addEventListener('mousemove', (e) => {
      if (!state.dragging) return;
      const dx = e.clientX - state.dragging.x;
      const dy = e.clientY - state.dragging.y;
      panel.style.left = `${Math.max(0, state.dragging.left + dx)}px`;
      panel.style.top = `${Math.max(0, state.dragging.top + dy)}px`;
      panel.style.right = 'auto';
      markInteraction();
    });

    const hidden = GM_getValue(STORE_KEYS.hiddenPaths, {});
    if (hidden[pathKey]) {
      panel.style.display = 'none';
      showReopenButton(pathKey);
    }
  }

  async function fetchJson(url) {
    const res = await fetch(url, { method: 'GET', credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  function deepFindNumbersWithPriceHeuristic(obj, out = []) {
    if (!obj || typeof obj !== 'object') return out;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number' && /price|cost|amount|value/i.test(k)) out.push(v);
      else if (typeof v === 'object') deepFindNumbersWithPriceHeuristic(v, out);
    }
    return out;
  }

  function findLowestViablePriceFromApiPayload(js, reference) {
    const nums = deepFindNumbersWithPriceHeuristic(js, []);
    if (!nums.length) return null;

    const band = mvBand();
    const floor = reference > 0 ? reference * (band.min / 100) : 50;
    const ceiling = reference > 0 ? reference * (band.max / 100) : 10_000_000;

    const viable = nums
      .filter(n => Number.isFinite(n) && n >= floor && n <= ceiling)
      .sort((a, b) => a - b);

    return viable.length ? viable[0] : null;
  }

  async function getPointsPrice(apiKey) {
    const urls = [
      `https://api.torn.com/market/?selections=pointsmarket&key=${encodeURIComponent(apiKey)}`,
      `https://api.torn.com/v2/market/?selections=pointsmarket&key=${encodeURIComponent(apiKey)}`,
    ];
    for (const url of urls) {
      try {
        const js = await fetchJson(url);
        const nums = deepFindNumbersWithPriceHeuristic(js, []);
        const viable = nums.filter(n => n > 1000).sort((a, b) => a - b);
        if (viable.length) return viable[0];
      } catch (_) {}
    }
    return null;
  }

  async function getItemsMaster(apiKey) {
    const urls = [
      `https://api.torn.com/torn/?selections=items&key=${encodeURIComponent(apiKey)}`,
      `https://api.torn.com/v2/torn/?selections=items&key=${encodeURIComponent(apiKey)}`,
    ];

    for (const url of urls) {
      try {
        const js = await fetchJson(url);
        const itemsObj = js.items || js.item || js;
        const items = Object.entries(itemsObj || {}).map(([id, v]) => ({
          id: Number(id),
          name: v.name,
          type: String(v.type || '').trim(),
          market_value: Number(v.market_value || v.marketValue || 0),
        }));

        const filtered = items.filter((x) => {
          if (x.type !== 'Flower' && x.type !== 'Plushie') return false;
          const allowed = REQUIRED_SET_NAMES[x.type];
          return !!allowed && allowed.has(x.name);
        });

        if (filtered.length) return filtered;
      } catch (_) {}
    }
    return [];
  }

  async function getItemLivePrice(apiKey, itemId, reference) {
    const urls = [
      `https://api.torn.com/market/${itemId}?selections=itemmarket&key=${encodeURIComponent(apiKey)}`,
      `https://api.torn.com/v2/market/${itemId}/itemmarket?key=${encodeURIComponent(apiKey)}`,
    ];

    for (const url of urls) {
      try {
        const js = await fetchJson(url);
        const found = findLowestViablePriceFromApiPayload(js, reference);
        if (found != null) return found;
      } catch (_) {}
    }

    return null;
  }

  async function getInventoryHoldings(apiKey) {
    const urls = [
      `https://api.torn.com/user/?selections=inventory&key=${encodeURIComponent(apiKey)}`,
      `https://api.torn.com/v2/user/?selections=inventory&key=${encodeURIComponent(apiKey)}`,
    ];

    for (const url of urls) {
      try {
        const js = await fetchJson(url);
        const raw = js.inventory || js.items || [];
        const holdings = {};
        if (!Array.isArray(raw)) continue;

        for (const row of raw) {
          const id = Number(row.ID || row.id || row.itemID || row.item_id);
          const qty = Number(row.quantity || row.qty || 0);
          if (id > 0 && qty > 0) holdings[id] = (holdings[id] || 0) + qty;
        }
        return holdings;
      } catch (_) {}
    }

    return {};
  }

  function buildHoldingsEditor(items) {
    const host = state.panel.querySelector('#tmh-holdings');
    host.innerHTML = '';

    for (const item of items) {
      const row = document.createElement('label');
      const apiOwned = Number(state.apiHoldings[item.id] || 0);
      row.textContent = apiOwned > 0 ? `${item.name} (inv:${apiOwned})` : item.name;

      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.step = '1';
      input.value = String(Number(state.holdings[item.id] || 0));

      input.addEventListener('change', () => {
        state.holdings[item.id] = clamp(Number(input.value) || 0, 0, 9999);
        saveHoldings();
        state.metrics = getSetMetrics(state.items);
        render();
      });

      row.appendChild(input);
      host.appendChild(row);
    }
  }

  function recordOpportunity(entry) {
    if (!entry || !entry.itemName) return;

    const fingerprint = `${entry.itemName}|${entry.price}|${entry.category}`;
    if (state.watchlist[0]?.fingerprint === fingerprint) return;

    state.watchlist.unshift({
      ...entry,
      fingerprint,
      at: now(),
    });

    const unique = [];
    const seen = new Set();

    for (const row of state.watchlist) {
      if (seen.has(row.fingerprint)) continue;
      seen.add(row.fingerprint);
      unique.push(row);
      if (unique.length >= 5) break;
    }

    state.watchlist = unique;
    saveWatchlist();
  }

  function getSetMetrics(items) {
    const grouped = {
      Flower: items.filter((x) => x.type === 'Flower'),
      Plushie: items.filter((x) => x.type === 'Plushie'),
    };

    const pointsNet = (state.pointsPrice || 0) * 10;
    const out = {};
    const candidateItems = [];

    for (const [cat, arr] of Object.entries(grouped)) {
      const needed = arr.map((item) => {
        const localOwned = Number(state.holdings[item.id] || 0);
        const apiOwned = Number(state.apiHoldings[item.id] || 0);
        const owned = Math.max(localOwned, apiOwned);
        const missing = owned > 0 ? 0 : 1;

        const refValue = Number(state.marketValueById.get(item.id) || item.market_value || 0);
        const price = Number(state.apiPricesById.get(item.id) || refValue || 0);

        const mvPct = marketValuePercent(price, refValue);
        const inBand = itemBandStatus(mvPct) === 'in';
        const itemRoiPct = price > 0 ? ((refValue - price) / price) * 100 : 0;

        return {
          ...item,
          owned,
          missing,
          price,
          refValue,
          mvPct,
          inBand,
          itemRoiPct,
          setType: cat,
        };
      });

      const fullSetCost = needed.reduce((sum, i) => sum + i.price, 0);
      const missingItems = needed.filter(i => i.missing);
      const missingOnlyCost = missingItems.reduce((sum, i) => sum + i.price, 0);
      const netProfitFull = pointsNet - fullSetCost;
      const netProfitIncremental = pointsNet - missingOnlyCost;
      const roiPct = missingOnlyCost > 0 ? (netProfitIncremental / missingOnlyCost) * 100 : -100;
      const buyable = missingOnlyCost > 0 && roiPct >= state.settings.roiThresholdPct;

      const enrichedMissing = missingItems.map((item) => {
        const supportsProfitableSet = buyable;
        const decision = decisionLabel({
          inBand: item.inBand,
          supportsProfitableSet,
        });

        return {
          ...item,
          supportsProfitableSet,
          decision,
          reason: reasonText(item, buyable),
        };
      });

      const bestNext = enrichedMissing
        .filter(i => i.inBand)
        .sort((a, b) => itemSortScore(b) - itemSortScore(a))[0] || null;

      const bottleneck = missingItems.sort((a, b) => b.price - a.price)[0] || null;

      out[cat] = {
        cat,
        needed,
        missingItems: enrichedMissing,
        pointsNet,
        fullSetCost,
        missingOnlyCost,
        netProfitFull,
        netProfitIncremental,
        roiPct,
        bottleneck,
        bestNext,
        buyable,
      };

      candidateItems.push(...enrichedMissing);
    }

    const bestSet = Object.values(out)
      .sort((a, b) => {
        if (Number(b.buyable) !== Number(a.buyable)) return Number(b.buyable) - Number(a.buyable);
        if (b.netProfitIncremental !== a.netProfitIncremental) return b.netProfitIncremental - a.netProfitIncremental;
        return b.roiPct - a.roiPct;
      })[0] || null;

    const bestItem = candidateItems
      .sort((a, b) => itemSortScore(b) - itemSortScore(a))[0] || null;

    const pricedCount = items.filter(i => {
      const price = Number(state.apiPricesById.get(i.id) || 0);
      return price > 0;
    }).length;

    const coverage = items.length ? pricedCount / items.length : 0;

    return {
      byCategory: out,
      bestSet,
      bestItem,
      pointsNet,
      confidence: confidenceLabel(coverage, now() - state.lastApiRefresh),
      coverage,
    };
  }

  function renderHistory() {
    const host = state.panel.querySelector('#tmh-history');
    if (!host) return;

    if (!state.watchlist.length) {
      host.innerHTML = `<div class="tmh-small">No recent opportunities recorded yet.</div>`;
      return;
    }

    host.innerHTML = state.watchlist.map((row) => {
      const dt = new Date(row.at);
      const timeText = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}:${String(dt.getSeconds()).padStart(2, '0')}`;
      return `
        <div class="tmh-list-entry">
          <div class="tmh-inline">
            <span class="tmh-badge ${row.decision === 'BUY' ? 'tmh-buy' : (row.decision === 'MAYBE' ? 'tmh-maybe' : 'tmh-ignore')}">${row.decision}</span>
            <strong>${row.itemName}</strong>
          </div>
          <div class="tmh-small">${row.category} • ${fmtMoney(row.price)} • ${fmtPct(row.mvPct)} of MV • ${timeText}</div>
        </div>
      `;
    }).join('');
  }

  function renderPageBadge(bestSet) {
    document.querySelectorAll('.tmh-page-badge').forEach(x => x.remove());
    if (!bestSet || !bestSet.buyable) return;

    const badge = document.createElement('a');
    badge.className = 'tmh-page-badge';
    badge.href = CATEGORY_URLS[bestSet.cat];
    badge.textContent = `${bestSet.cat} profitable`;
    badge.title = 'Open profitable category';
    document.body.appendChild(badge);
  }

  function getInBandItems(metrics) {
    if (!metrics?.byCategory) return [];
    const categories = Object.values(metrics.byCategory);
    return categories
      .flatMap(cat => (cat.missingItems || []).filter(item => item.inBand))
      .sort((a, b) => itemSortScore(b) - itemSortScore(a));
  }

  function highlightInBandItems(items) {
    document.querySelectorAll('.tmh-highlight').forEach(el => el.classList.remove('tmh-highlight'));
    if (!items?.length) return;

    const names = new Set(items.map(i => i.name.toLowerCase()));
    const candidates = Array.from(document.querySelectorAll('[data-item-name], .itemRow, .market-item, .sellerRow, .item-market-list-item, li, tr, div'));

    let firstMatch = null;
    for (const el of candidates) {
      const text = (el.textContent || '').trim().toLowerCase();
      if (!text || text.length >= 600) continue;
      for (const name of names) {
        if (text.includes(name)) {
          el.classList.add('tmh-highlight');
          if (!firstMatch) firstMatch = el;
          break;
        }
      }
    }

    if (firstMatch) {
      firstMatch.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function maybeAlert(bestSet, bestItem) {
    if (!state.settings.alertsEnabled || !bestItem) return;

    const s = GM_getValue(STORE_KEYS.alertState, {
      at: 0,
      bestItemName: '',
      bestItemPrice: 0,
      bestSetCat: '',
      bestItemDecision: '',
    });

    const enoughTime = now() - (s.at || 0) > state.settings.alertCooldownSeconds * 1000;
    const itemChanged = s.bestItemName !== bestItem.name || s.bestItemPrice !== bestItem.price;
    const setChanged = s.bestSetCat !== (bestSet?.cat || '');
    const decisionChanged = s.bestItemDecision !== bestItem.decision;
    const shouldAlert = bestItem.decision === 'BUY' && (itemChanged || setChanged || decisionChanged);

    if (!shouldAlert || !enoughTime) {
      GM_setValue(STORE_KEYS.alertState, {
        ...s,
        bestItemName: bestItem.name,
        bestItemPrice: bestItem.price,
        bestSetCat: bestSet?.cat || '',
        bestItemDecision: bestItem.decision,
      });
      return;
    }

    const text = [
      `${bestItem.name} looks good.`,
      `${fmtMoney(bestItem.price)} (${fmtPct(bestItem.mvPct)} of MV).`,
      `Best set: ${bestSet?.cat || 'Unknown'} at ${fmtPct(bestSet?.roiPct || 0, 2)} ROI.`,
    ].join(' ');

    if (typeof GM_notification === 'function') {
      GM_notification({
        title: 'Torn Museum Arb',
        text,
        timeout: 5000,
        onclick: () => window.open(CATEGORY_URLS[bestItem.setType], '_blank'),
      });
    }

    GM_setValue(STORE_KEYS.alertState, {
      at: now(),
      bestItemName: bestItem.name,
      bestItemPrice: bestItem.price,
      bestSetCat: bestSet?.cat || '',
      bestItemDecision: bestItem.decision,
    });
  }

  function render() {
    if (!state.body) return;

    const m = state.metrics;
    const status = state.panel.querySelector('#tmh-status');

    if (state.paused) {
      status.textContent = 'paused';
    } else if (!m) {
      status.textContent = state.isLeader ? 'leader' : 'follower';
    } else {
      status.textContent = state.isLeader ? 'leader' : 'follower';
    }

    if (!m) {
      state.body.innerHTML = '<div class="tmh-section"><div class="tmh-small">Waiting for data...</div></div>';
      renderHistory();
      return;
    }

    const flower = m.byCategory.Flower;
    const plushie = m.byCategory.Plushie;
    const bestSet = m.bestSet;
    const bestItem = m.bestItem;
    const inBandItems = getInBandItems(m);

    const bestDecisionClass =
      bestItem?.decision === 'BUY' ? 'tmh-buy' :
      bestItem?.decision === 'MAYBE' ? 'tmh-maybe' : 'tmh-ignore';

    const confidenceClass =
      m.confidence === 'High' ? 'tmh-good' :
      m.confidence === 'Medium' ? 'tmh-warn' : 'tmh-bad';

    const apiAgeSeconds = Math.max(0, (now() - state.lastApiRefresh) / 1000).toFixed(1);

    state.body.innerHTML = `
      <div class="tmh-section">
        <div class="tmh-title">Overview</div>
        <div class="tmh-row"><span>Mode</span><strong>${state.isLeader ? 'Leader' : 'Follower'}</strong></div>
        <div class="tmh-row"><span>Points value (10x)</span><strong>${fmtMoney(m.pointsNet)}</strong></div>
        <div class="tmh-row"><span>Confidence</span><strong class="${confidenceClass}">${m.confidence}</strong></div>
        <div class="tmh-row"><span>MV band</span><strong>${fmtPct(mvBand().min)} to ${fmtPct(mvBand().max)}</strong></div>
        <div class="tmh-row"><span>Last API update</span><strong>${state.lastApiRefresh ? new Date(state.lastApiRefresh).toLocaleTimeString() : '-'}</strong></div>
        <div class="tmh-row"><span>API age</span><strong>${apiAgeSeconds}s</strong></div>
      </div>

      <div class="tmh-section">
        <div class="tmh-title">Best set right now</div>
        <div class="tmh-inline">
          <strong>${bestSet?.cat || '-'}</strong>
          <span class="tmh-badge ${bestSet?.buyable ? 'tmh-buy' : 'tmh-maybe'}">${bestSet?.buyable ? 'BUY' : 'MAYBE'}</span>
        </div>
        <div class="tmh-row"><span>ROI</span><strong class="${bestSet?.buyable ? 'tmh-good' : 'tmh-warn'}">${fmtPct(bestSet?.roiPct || 0, 2)}</strong></div>
        <div class="tmh-row"><span>Missing cost</span><strong>${fmtMoney(bestSet?.missingOnlyCost || 0)}</strong></div>
        <div class="tmh-row"><span>Net</span><strong>${fmtMoney(bestSet?.netProfitIncremental || 0)}</strong></div>
        <div class="tmh-row"><span>Best next</span><strong>${bestSet?.bestNext ? `${bestSet.bestNext.name} (${fmtMoney(bestSet.bestNext.price)})` : 'None in band'}</strong></div>
      </div>

      <div class="tmh-section">
        <div class="tmh-title">Best individual item</div>
        ${
          bestItem ? `
          <div class="tmh-inline">
            <strong>${bestItem.name}</strong>
            <span class="tmh-badge ${bestDecisionClass}">${bestItem.decision}</span>
          </div>
          <div class="tmh-row"><span>Category</span><strong>${bestItem.setType}</strong></div>
          <div class="tmh-row"><span>API price</span><strong>${fmtMoney(bestItem.price)}</strong></div>
          <div class="tmh-row"><span>Market value</span><strong>${fmtMoney(bestItem.refValue)}</strong></div>
          <div class="tmh-row"><span>MV %</span><strong>${fmtPct(bestItem.mvPct)}</strong></div>
          <div class="tmh-row"><span>Item ROI</span><strong>${fmtPct(bestItem.itemRoiPct, 2)}</strong></div>
          <div class="tmh-reason">${bestItem.reason}</div>
          ` : `
          <div class="tmh-small">No candidate item found yet.</div>
          `
        }
      </div>

      <div class="tmh-section">
        <div class="tmh-title">Category snapshot</div>
        <div class="tmh-row"><span>Flowers</span><strong>${fmtPct(flower.roiPct, 2)} • ${flower.bestNext ? flower.bestNext.name : 'No in-band item'}</strong></div>
        <div class="tmh-row"><span>Plushies</span><strong>${fmtPct(plushie.roiPct, 2)} • ${plushie.bestNext ? plushie.bestNext.name : 'No in-band item'}</strong></div>
      </div>

      <div class="tmh-section">
        <div class="tmh-title">Items currently in MV parameters</div>
        ${
          inBandItems.length ? inBandItems.map((item) => `
            <div class="tmh-list-entry">
              <div class="tmh-inline">
                <strong>${item.name}</strong>
                <span class="tmh-badge ${item.decision === 'BUY' ? 'tmh-buy' : 'tmh-maybe'}">${item.decision}</span>
              </div>
              <div class="tmh-small">${item.setType} • ${fmtMoney(item.price)} • ${fmtPct(item.mvPct)} of MV</div>
            </div>
          `).join('') : '<div class="tmh-small">No items are inside your MV band right now.</div>'
        }
      </div>
    `;

    renderHistory();
    renderPageBadge(bestSet);
    highlightInBandItems(inBandItems);

    if (bestItem) {
      recordOpportunity({
        itemName: bestItem.name,
        price: bestItem.price,
        mvPct: bestItem.mvPct,
        category: bestItem.setType,
        decision: bestItem.decision,
      });
      renderHistory();
    }

    maybeAlert(bestSet, bestItem);
  }

  function serializeSharedCache() {
    return {
      items: state.items.map(item => ({
        id: item.id,
        name: item.name,
        type: item.type,
        market_value: item.market_value,
      })),
      pointsPrice: state.pointsPrice,
      apiHoldings: state.apiHoldings,
      apiPricesById: Array.from(state.apiPricesById.entries()),
      marketValueById: Array.from(state.marketValueById.entries()),
      lastApiRefresh: state.lastApiRefresh,
    };
  }

  function persistSharedCache() {
    const cache = serializeSharedCache();
    GM_setValue(STORE_KEYS.sharedCache, cache);
    broadcast({ type: 'cache-updated', cache });
  }

  function applySharedCache(cache) {
    if (!cache || typeof cache !== 'object') return;
    if (Array.isArray(cache.items)) {
      state.items = cache.items.slice();
    }
    state.pointsPrice = Number(cache.pointsPrice || 0) || null;
    state.apiHoldings = cache.apiHoldings || {};
    state.apiPricesById = new Map(Array.isArray(cache.apiPricesById) ? cache.apiPricesById : []);
    state.marketValueById = new Map(Array.isArray(cache.marketValueById) ? cache.marketValueById : []);
    state.lastApiRefresh = Number(cache.lastApiRefresh || 0);

    if (state.panel && state.items.length) {
      buildHoldingsEditor(state.items);
    }
    if (state.items.length) {
      state.metrics = getSetMetrics(state.items);
    }
  }

  function loadSharedCacheFromStorage() {
    const cache = GM_getValue(STORE_KEYS.sharedCache, null);
    if (cache) {
      applySharedCache(cache);
    }
  }

  async function refreshDataIfNeeded(force = false) {
    if (!state.isLeader) return;
    if (!state.settings.apiKey) return;

    const ageMs = now() - state.lastApiRefresh;
    if (!force && ageMs < state.settings.apiRefreshSeconds * 1000) return;

    const items = await getItemsMaster(state.settings.apiKey);
    if (items.length) {
      state.items = items;
      state.marketValueById.clear();
      for (const item of items) {
        state.marketValueById.set(item.id, Number(item.market_value || 0));
      }
      buildHoldingsEditor(items);
    }

    if (state.settings.useApiInventory) {
      state.apiHoldings = await getInventoryHoldings(state.settings.apiKey);
    }

    const points = await getPointsPrice(state.settings.apiKey);
    if (points) state.pointsPrice = points;

    state.apiPricesById.clear();
    const jobs = state.items.map(async (item) => {
      const reference = Number(state.marketValueById.get(item.id) || item.market_value || 0);
      const live = await getItemLivePrice(state.settings.apiKey, item.id, reference);
      return { id: item.id, price: live, reference };
    });

    const results = await Promise.all(jobs);
    for (const row of results) {
      if (row.price != null && Number.isFinite(row.price) && row.price > 0) {
        state.apiPricesById.set(row.id, row.price);
      } else if (row.reference > 0) {
        state.apiPricesById.set(row.id, row.reference);
      }
    }

    state.lastApiRefresh = now();
    persistSharedCache();
  }

  async function tick() {
    if (state.paused) {
      applyFade();
      return;
    }

    try {
      maybeBecomeLeader();

      if (state.isLeader) {
        heartbeatLeader();
        await refreshDataIfNeeded(false);
      } else {
        loadSharedCacheFromStorage();
      }

      if (state.items.length) {
        state.metrics = getSetMetrics(state.items);
      }

      render();
      applyFade();
    } catch (err) {
      const status = state.panel?.querySelector('#tmh-status');
      if (status) status.textContent = `err: ${err.message}`;
    }
  }

  function installUnloadHandler() {
    window.addEventListener('beforeunload', () => {
      if (state.isLeader) {
        broadcast({ type: 'leader-resigned', leaderId: state.tabId });
        clearLeaderRecord();
      }
      try {
        if (state.bc) state.bc.close();
      } catch (_) {}
    });
  }

  async function init() {
    loadState();
    initBroadcastChannel();
    loadSharedCacheFromStorage();
    maybeBecomeLeader();
    createPanel();
    installUnloadHandler();

    if (state.isLeader) {
      await refreshDataIfNeeded(true);
    } else {
      loadSharedCacheFromStorage();
    }

    state.metrics = state.items.length ? getSetMetrics(state.items) : null;
    render();

    setInterval(tick, Math.max(1000, state.settings.scanSeconds * 1000));
    setInterval(applyFade, 1000);
    setInterval(() => {
      maybeBecomeLeader();
      if (state.isLeader) heartbeatLeader();
    }, 1500);
  }

  init();
})();

// ==UserScript==
// @name         Torn Museum Arbitrage Helper (Read-Only)
// @namespace    https://torn.com/
// @version      0.1.0
// @description  Read-only plushie/flower set profitability helper with alerts, ROI, bottleneck, confidence, and page highlighting.
// @author       GPT-5.3-Codex
// @match        https://www.torn.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// ==/UserScript==

(function () {
  'use strict';

  const STORE_KEYS = {
    settings: 'tmh_settings_v1',
    holdings: 'tmh_holdings_v1',
    alertState: 'tmh_alert_state_v1',
    hiddenPaths: 'tmh_hidden_paths_v1',
  };

  const DEFAULTS = {
    apiKey: '',
    scanSeconds: 3,
    roiThresholdPct: 2,
    muggerBufferPct: 1,
    minProfitDollars: 0,
    apiRefreshSeconds: 60,
    fadeSeconds: 8,
    moveablePanel: true,
    alertsEnabled: true,
    alertCooldownSeconds: 90,
    strictReadOnly: true,
    useApiInventory: true,
    minAlertRoiDeltaPct: 0.5,
    minAlertProfitDelta: 50000,
    alertStabilityTicks: 2,
    minItemDiscountPct: 30,
    minItemStableScans: 3,
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
    settings: { ...DEFAULTS },
    holdings: {},
    items: [],
    pointsPrice: null,
    pricesById: new Map(),
    apiHoldings: {},
    metrics: null,
    lastApiRefresh: 0,
    panel: null,
    body: null,
    lastInteraction: Date.now(),
    dragging: null,
    cheapestTracking: new Map(),
  };

  function now() {
    return Date.now();
  }

  function loadState() {
    state.settings = { ...DEFAULTS, ...(GM_getValue(STORE_KEYS.settings, {}) || {}) };
    state.settings.minItemDiscountPct = clamp(Number(state.settings.minItemDiscountPct) || 30, 30, 100);
    state.settings.minItemStableScans = clamp(Number(state.settings.minItemStableScans) || 3, 1, 20);
    state.holdings = GM_getValue(STORE_KEYS.holdings, {}) || {};
  }

  function saveSettings() {
    GM_setValue(STORE_KEYS.settings, state.settings);
  }

  function saveHoldings() {
    GM_setValue(STORE_KEYS.holdings, state.holdings);
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
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

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'tmh-panel';
    const pathKey = `${location.pathname}${location.hash || ''}`;
    panel.innerHTML = `
      <div id="tmh-head">
        <span>Museum Arb</span>
        <span id="tmh-head-right">
          <span id="tmh-status">idle</span>
          <button id="tmh-exit" title="Hide on this page">✕</button>
        </span>
      </div>
      <div id="tmh-body"></div>
      <details id="tmh-settings-wrap">
        <summary>Settings</summary>
        <label>API Key <input id="tmh-api-key" type="password" placeholder="Torn API key" /></label>
        <label>Scan seconds <input id="tmh-scan" type="number" min="3" step="1" /></label>
        <label>API refresh seconds <input id="tmh-refresh" type="number" min="20" step="5" /></label>
        <label>ROI threshold % <input id="tmh-roi" type="number" min="0" step="0.1" /></label>
        <label>Mugger buffer % <input id="tmh-mug" type="number" min="0" step="0.1" /></label>
        <label>Min profit $ <input id="tmh-minp" type="number" min="0" step="1000" /></label>
        <label>Alert cooldown sec <input id="tmh-cool" type="number" min="10" step="5" /></label>
        <label>Min alert ROI delta % <input id="tmh-alert-roi-delta" type="number" min="0" step="0.1" /></label>
        <label>Min alert profit delta $ <input id="tmh-alert-profit-delta" type="number" min="0" step="1000" /></label>
        <label>Alert stability ticks <input id="tmh-alert-stability" type="number" min="1" step="1" /></label>
        <label>Min item discount % <input id="tmh-min-discount" type="number" min="30" step="0.1" /></label>
        <label>Min stable scans/item <input id="tmh-min-stable" type="number" min="1" step="1" /></label>
        <button id="tmh-save">Save</button>
      </details>
      <details id="tmh-holdings-wrap">
        <summary>Holdings</summary>
        <div id="tmh-holdings"></div>
      </details>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #tmh-panel { position: fixed; top: 16px; right: 16px; z-index: 99999; width: 320px; max-height: 85vh; overflow: auto; background: rgba(17,17,17,.95); color: #f4f4f4; border: 1px solid #3b3b3b; border-radius: 10px; font: 12px/1.4 Arial, sans-serif; box-shadow: 0 8px 20px rgba(0,0,0,.35); transition: opacity .2s ease; }
      #tmh-head { padding: 8px 10px; cursor: move; font-weight: 700; border-bottom: 1px solid #2e2e2e; display:flex; justify-content:space-between; }
      #tmh-head-right { display:flex; gap:8px; align-items:center; }
      #tmh-exit { border:0; background:#444; color:#fff; border-radius:4px; width:20px; height:20px; line-height:20px; padding:0; cursor:pointer; font-weight:700; }
      #tmh-body { padding: 8px 10px; }
      #tmh-body .row { display:flex; justify-content:space-between; margin: 3px 0; gap:8px; }
      #tmh-body .section-title { margin: 8px 0 4px; font-weight: 700; color: #dcdcdc; }
      #tmh-body .item-list { margin-top: 4px; max-height: 180px; overflow: auto; border: 1px solid #2f2f2f; border-radius: 8px; padding: 6px; background: rgba(0,0,0,0.18); }
      #tmh-body .item-entry { margin: 0; padding: 4px 0; border-bottom: 1px solid #2d2d2d; }
      #tmh-body .item-entry:last-child { border-bottom: 0; }
      #tmh-body .item-meta { color: #cfcfcf; font-size: 11px; }
      #tmh-body .good { color: #75f587; font-weight: 700; }
      #tmh-body .warn { color: #ffd76c; font-weight: 700; }
      #tmh-body .bad { color: #ff8e8e; font-weight: 700; }
      #tmh-panel details { padding: 6px 10px; border-top:1px solid #2e2e2e; }
      #tmh-panel label { display:block; margin: 5px 0; }
      #tmh-panel input { width: 100%; box-sizing:border-box; background:#242424; color:#fff; border:1px solid #444; border-radius:6px; padding:4px 6px; }
      #tmh-panel button { width:100%; margin-top: 6px; border:0; background:#4f79ff; color:#fff; border-radius:6px; padding:6px; cursor:pointer; }
      .tmh-highlight { outline: 2px solid #75f587 !important; box-shadow: 0 0 0 2px rgba(117,245,135,.2) inset !important; }
      .tmh-page-badge { position: fixed; right: 16px; top: 0; transform: translateY(-100%); background:#75f587; color:#111; font-weight:700; padding: 4px 8px; border-radius: 0 0 8px 8px; z-index:99999; }
      #tmh-reopen { position: fixed; right: 16px; top: 16px; z-index: 99999; border: 1px solid #3b3b3b; background:#1b1b1b; color:#fff; padding: 6px 8px; border-radius: 8px; cursor:pointer; }
    `;

    document.head.appendChild(style);
    document.body.appendChild(panel);
    state.panel = panel;
    state.body = panel.querySelector('#tmh-body');

    panel.addEventListener('mouseenter', markInteraction);
    panel.addEventListener('mousemove', markInteraction);

    const saveBtn = panel.querySelector('#tmh-save');
    saveBtn.addEventListener('click', () => {
      state.settings.apiKey = panel.querySelector('#tmh-api-key').value.trim();
      state.settings.scanSeconds = clamp(Number(panel.querySelector('#tmh-scan').value) || 3, 3, 60);
      state.settings.apiRefreshSeconds = clamp(Number(panel.querySelector('#tmh-refresh').value) || 60, 20, 600);
      state.settings.roiThresholdPct = clamp(Number(panel.querySelector('#tmh-roi').value) || 2, 0, 100);
      state.settings.muggerBufferPct = clamp(Number(panel.querySelector('#tmh-mug').value) || 1, 0, 25);
      state.settings.minProfitDollars = clamp(Number(panel.querySelector('#tmh-minp').value) || 0, 0, 1e9);
      state.settings.alertCooldownSeconds = clamp(Number(panel.querySelector('#tmh-cool').value) || 90, 10, 3600);
      state.settings.minAlertRoiDeltaPct = clamp(Number(panel.querySelector('#tmh-alert-roi-delta').value) || 0.5, 0, 100);
      state.settings.minAlertProfitDelta = clamp(Number(panel.querySelector('#tmh-alert-profit-delta').value) || 50000, 0, 1e9);
      state.settings.alertStabilityTicks = clamp(Number(panel.querySelector('#tmh-alert-stability').value) || 2, 1, 20);
      state.settings.minItemDiscountPct = clamp(Number(panel.querySelector('#tmh-min-discount').value) || 30, 30, 100);
      state.settings.minItemStableScans = clamp(Number(panel.querySelector('#tmh-min-stable').value) || 3, 1, 20);
      saveSettings();
      render();
      markInteraction();
    });

    panel.querySelector('#tmh-api-key').value = state.settings.apiKey;
    panel.querySelector('#tmh-scan').value = String(state.settings.scanSeconds);
    panel.querySelector('#tmh-refresh').value = String(state.settings.apiRefreshSeconds);
    panel.querySelector('#tmh-roi').value = String(state.settings.roiThresholdPct);
    panel.querySelector('#tmh-mug').value = String(state.settings.muggerBufferPct);
    panel.querySelector('#tmh-minp').value = String(state.settings.minProfitDollars);
    panel.querySelector('#tmh-cool').value = String(state.settings.alertCooldownSeconds);
    panel.querySelector('#tmh-alert-roi-delta').value = String(state.settings.minAlertRoiDeltaPct);
    panel.querySelector('#tmh-alert-profit-delta').value = String(state.settings.minAlertProfitDelta);
    panel.querySelector('#tmh-alert-stability').value = String(state.settings.alertStabilityTicks);
    panel.querySelector('#tmh-min-discount').value = String(state.settings.minItemDiscountPct);
    panel.querySelector('#tmh-min-stable').value = String(state.settings.minItemStableScans);
    const exitBtn = panel.querySelector('#tmh-exit');
    exitBtn.addEventListener('click', (e) => {
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

  async function fetchJson(url) {
    const res = await fetch(url, { method: 'GET', credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  function confidenceLabel(coverage, apiAgeMs) {
    if (coverage > 0.9 && apiAgeMs < 90_000) return 'High';
    if (coverage > 0.6 && apiAgeMs < 300_000) return 'Medium';
    return 'Low';
  }

  function getSetMetrics(items) {
    const grouped = {
      Flower: items.filter((x) => x.type === 'Flower'),
      Plushie: items.filter((x) => x.type === 'Plushie'),
    };

    const pointsGross = (state.pointsPrice || 0) * 10;
    const pointsNet = pointsGross * (1 - state.settings.muggerBufferPct / 100);

    const out = {};
    const inParameterItems = [];
    for (const [cat, arr] of Object.entries(grouped)) {
      const needed = arr.map((item) => {
        const localOwned = Number(state.holdings[item.id] || 0);
        const apiOwned = Number(state.apiHoldings[item.id] || 0);
        const owned = Math.max(localOwned, apiOwned);
        const missing = owned > 0 ? 0 : 1;
        const price = state.pricesById.get(item.id) || item.market_value || 0;
        const refValue = Number(item.market_value || 0);
        const ratioToMarket = refValue > 0 ? price / refValue : 1;
        const discountPct = refValue > 0 ? (1 - ratioToMarket) * 100 : 0;
        const itemRoiPct = price > 0 ? ((refValue - price) / price) * 100 : 0;
        const stableScans = Number(state.cheapestTracking.get(item.id)?.stable || 0);
        const actionable = refValue > 0
          && discountPct >= state.settings.minItemDiscountPct
          && stableScans >= state.settings.minItemStableScans;
        return { ...item, owned, missing, price, refValue, ratioToMarket, discountPct, itemRoiPct, stableScans, actionable };
      });
      const fullSetCost = needed.reduce((sum, i) => sum + i.price, 0);
      const missingOnlyCost = needed.reduce((sum, i) => sum + (i.missing ? i.price : 0), 0);
      const netProfitFull = pointsNet - fullSetCost;
      const netProfitIncremental = pointsNet - missingOnlyCost;
      const roiPct = missingOnlyCost > 0 ? (netProfitIncremental / missingOnlyCost) * 100 : -100;
      const missingItems = needed.filter(i => i.missing);
      const bottleneck = missingItems.sort((a, b) => b.price - a.price)[0] || null;
      const discounted = missingItems
        .filter((i) => i.refValue > 0 && i.actionable)
        .sort((a, b) => {
          if (a.ratioToMarket !== b.ratioToMarket) return a.ratioToMarket - b.ratioToMarket;
          return b.refValue - a.refValue;
        });
      const bestNext = discounted[0] || null;
      out[cat] = {
        cat,
        needed,
        pointsNet,
        fullSetCost,
        missingOnlyCost,
        netProfitFull,
        netProfitIncremental,
        roiPct,
        bottleneck,
        bestNext,
        buyable: missingOnlyCost > 0 && discounted.length > 0 && roiPct >= state.settings.roiThresholdPct && netProfitIncremental >= state.settings.minProfitDollars,
      };

      inParameterItems.push(...discounted.map(item => ({ ...item, cat })));
    }

    const buyable = Object.values(out).filter(x => x.buyable).sort((a, b) => b.netProfitIncremental - a.netProfitIncremental);
    const winner = buyable[0] || Object.values(out).sort((a, b) => b.roiPct - a.roiPct)[0];
    const pricedCount = items.filter(i => (state.pricesById.get(i.id) || i.market_value || 0) > 0).length;
    const coverage = items.length ? pricedCount / items.length : 0;

    return {
      byCategory: out,
      winner,
      inParameterItems: inParameterItems.sort((a, b) => {
        if (a.ratioToMarket !== b.ratioToMarket) return a.ratioToMarket - b.ratioToMarket;
        return b.refValue - a.refValue;
      }),
      pointsNet,
      confidence: confidenceLabel(coverage, now() - state.lastApiRefresh),
      coverage,
    };
  }

  function fmtMoney(v) {
    return '$' + Math.round(v || 0).toLocaleString();
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

  function render() {
    if (!state.body) return;
    const m = state.metrics;
    const status = state.panel.querySelector('#tmh-status');
    if (!m) {
      status.textContent = 'waiting';
      state.body.innerHTML = '<div class="row"><span>Waiting for data...</span></div>';
      return;
    }
    status.textContent = 'live';
    const flower = m.byCategory.Flower;
    const plushie = m.byCategory.Plushie;
    const winner = m.winner;
    const inParameterItems = m.inParameterItems || [];

    state.body.innerHTML = `
      <div class="row"><span>Points net (10x)</span><strong>${fmtMoney(m.pointsNet)}</strong></div>
      <div class="row"><span>Confidence</span><strong class="${m.confidence === 'High' ? 'good' : (m.confidence === 'Medium' ? 'warn' : 'bad')}">${m.confidence}</strong></div>
      <hr />
      <div class="row"><span>Flowers ROI</span><strong class="${flower.buyable ? 'good' : 'bad'}">${flower.roiPct.toFixed(2)}%</strong></div>
      <div class="row"><span>Flowers net</span><strong>${fmtMoney(flower.netProfitIncremental)}</strong></div>
      <div class="row"><span>Flowers bottleneck</span><strong>${flower.bottleneck ? `${flower.bottleneck.name} (${fmtMoney(flower.bottleneck.price)})` : '-'}</strong></div>
      <div class="row"><span>Plushies ROI</span><strong class="${plushie.buyable ? 'good' : 'bad'}">${plushie.roiPct.toFixed(2)}%</strong></div>
      <div class="row"><span>Plushies net</span><strong>${fmtMoney(plushie.netProfitIncremental)}</strong></div>
      <div class="row"><span>Plushies bottleneck</span><strong>${plushie.bottleneck ? `${plushie.bottleneck.name} (${fmtMoney(plushie.bottleneck.price)})` : '-'}</strong></div>
      <hr />
      <div class="row"><span>Best now</span><strong>${winner?.cat || '-'} ${winner?.buyable ? '✅' : '⚠️'}</strong></div>
      <div class="row"><span>Best next item</span><strong>${winner?.bestNext ? `${winner.bestNext.name} (${fmtMoney(winner.bestNext.price)}, ${winner.bestNext.discountPct.toFixed(1)}% off, ROI ${winner.bestNext.itemRoiPct.toFixed(1)}%, stbl ${winner.bestNext.stableScans})` : 'No stable below-market listing'}</strong></div>
      <hr />
      <div class="section-title">Items in parameters (${inParameterItems.length})</div>
      ${inParameterItems.length ? `
        <div class="item-list">
          ${inParameterItems.map((item) => `
            <div class="item-entry">
              <div><strong>${item.name}</strong></div>
              <div class="item-meta">${item.cat} • ${fmtMoney(item.price)} • ${(item.ratioToMarket * 100).toFixed(1)}% MV • ${item.discountPct.toFixed(1)}% off • ROI ${item.itemRoiPct.toFixed(1)}%</div>
            </div>
          `).join('')}
        </div>
      ` : '<div class="item-meta">No missing items currently meet your discount/stability parameters.</div>'}
    `;

    renderPageBadge(winner);
    highlightItemsInParameter(inParameterItems);
    maybeAlert(winner);
  }

  function renderPageBadge(winner) {
    document.querySelectorAll('.tmh-page-badge').forEach(x => x.remove());
    if (!winner || !winner.buyable) return;
    const badge = document.createElement('a');
    badge.className = 'tmh-page-badge';
    badge.href = CATEGORY_URLS[winner.cat];
    badge.textContent = `${winner.cat} opportunity`; 
    badge.title = 'Open profitable category';
    document.body.appendChild(badge);
  }

  function highlightItemsInParameter(items) {
    document.querySelectorAll('.tmh-highlight').forEach(el => el.classList.remove('tmh-highlight'));
    if (!Array.isArray(items) || !items.length) return;
    const names = new Set(items.map(item => (item.name || '').toLowerCase()).filter(Boolean));
    if (!names.size) return;
    const candidates = Array.from(document.querySelectorAll('li,div,tr,a,span'));
    let firstMatch = null;
    for (const el of candidates) {
      const t = (el.textContent || '').trim().toLowerCase();
      if (!t || t.length >= 200) continue;
      for (const name of names) {
        if (!t.includes(name)) continue;
        el.classList.add('tmh-highlight');
        if (!firstMatch) firstMatch = el;
        break;
      }
    }
    if (firstMatch) {
      firstMatch.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function maybeAlert(winner) {
    if (!state.settings.alertsEnabled || !winner || !winner.buyable) return;
    const s = GM_getValue(STORE_KEYS.alertState, { at: 0, cat: '', roi: 0, profit: 0, stable: 0 });
    const enoughTime = now() - (s.at || 0) > state.settings.alertCooldownSeconds * 1000;
    const changed = s.cat !== winner.cat;
    const roiDelta = Math.abs((winner.roiPct || 0) - (s.roi || 0));
    const profitDelta = Math.abs((winner.netProfitIncremental || 0) - (s.profit || 0));
    const meaningfulMove = changed || roiDelta >= state.settings.minAlertRoiDeltaPct || profitDelta >= state.settings.minAlertProfitDelta;
    const stable = changed ? 1 : (s.stable || 0) + 1;
    if (!meaningfulMove || stable < state.settings.alertStabilityTicks || (!enoughTime && !changed)) {
      GM_setValue(STORE_KEYS.alertState, {
        ...s,
        cat: winner.cat,
        roi: winner.roiPct,
        profit: winner.netProfitIncremental,
        stable,
      });
      return;
    }

    const discountText = winner.bestNext ? `${winner.bestNext.discountPct.toFixed(1)}% vs MV` : 'n/a';
    const text = `${winner.cat} opportunity: ${winner.roiPct.toFixed(2)}% ROI. Next: ${winner.bestNext?.name || 'n/a'} (${discountText})`;
    if (typeof GM_notification === 'function') {
      GM_notification({
        title: 'Torn Museum Arb',
        text,
        timeout: 5000,
        onclick: () => window.open(CATEGORY_URLS[winner.cat], '_blank'),
      });
    }

    GM_setValue(STORE_KEYS.alertState, {
      at: now(),
      cat: winner.cat,
      roi: winner.roiPct,
      profit: winner.netProfitIncremental,
      stable: 0,
    });
  }

  function deepFindNumbersWithPriceHeuristic(obj, out = []) {
    if (!obj || typeof obj !== 'object') return out;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number' && /price|cost|amount|value/i.test(k)) out.push(v);
      else if (typeof v === 'object') deepFindNumbersWithPriceHeuristic(v, out);
    }
    return out;
  }

  function parsePriceFromText(text) {
    if (!text) return null;
    const matches = text.match(/\$\s*[\d,]+/g);
    if (!matches || !matches.length) return null;
    const nums = matches
      .map((x) => Number(x.replace(/[^\d]/g, '')))
      .filter((n) => Number.isFinite(n) && n >= 50);
    if (!nums.length) return null;
    return Math.min(...nums);
  }

  function getItemByName(name) {
    const target = (name || '').trim().toLowerCase();
    if (!target) return null;
    return state.items.find((i) => i.name.toLowerCase() === target) || null;
  }

  function findTextInElement(el, selectorList) {
    for (const sel of selectorList) {
      const candidate = el.querySelector(sel);
      if (candidate && candidate.textContent) return candidate.textContent.trim();
    }
    return '';
  }

  function refreshCheapestFromCurrentPage() {
    if (!state.items.length) return;

    // Heuristic parser for Torn market cards/rows. It extracts item name + listing price
    // and keeps the cheapest seen listing per item from the currently opened page.
    const rows = Array.from(document.querySelectorAll('li, tr, .itemRow, .market-item, .sellerRow, .item-market-list-item'));
    const cheapestById = new Map();

    for (const row of rows) {
      const nameText = findTextInElement(row, [
        '[class*=\"name\"]',
        '[class*=\"title\"]',
        '[data-item-name]',
        'a',
        'span',
      ]);
      const item = getItemByName(nameText);
      if (!item) continue;
      const rowText = row.textContent || '';
      if (!rowText.toLowerCase().includes(item.name.toLowerCase())) continue;

      const priceText = findTextInElement(row, [
        '[class*=\"price\"]',
        '[class*=\"cost\"]',
        '[data-price]',
        'span',
        'div',
      ]) || rowText;
      const price = parsePriceFromText(priceText);
      if (!price) continue;
      const reference = Number(item.market_value || 0);
      if (reference <= 0) continue;
      const saneFloor = reference * 0.35;
      const saneCeiling = reference * 0.999;
      if (price < saneFloor || price > saneCeiling) continue;

      const prev = cheapestById.get(item.id);
      if (!prev || price < prev.price) {
        cheapestById.set(item.id, { price, at: now() });
      }
    }

    // Update working prices with freshest DOM-cheapest data.
    for (const [itemId, info] of cheapestById.entries()) {
      const previous = state.cheapestTracking.get(itemId);
      state.pricesById.set(itemId, info.price);
      const nearSame = previous && previous.price > 0 && Math.abs(info.price - previous.price) / previous.price <= 0.02;
      const stable = nearSame ? Number(previous.stable || 1) + 1 : 1;
      state.cheapestTracking.set(itemId, { ...info, stable });

      // If cheapest increased, likely the previous cheapest listing was bought.
      if (previous && info.price > previous.price) {
        const item = state.items.find((x) => x.id === itemId);
        const status = state.panel?.querySelector('#tmh-status');
        if (status && item) {
          status.textContent = `cheapest moved: ${item.name}`;
        }
      }
    }
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
      } catch (_) {
        // try fallback URL
      }
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
      } catch (_) {
        // try fallback URL
      }
    }
    return [];
  }

  async function getItemLivePrice(apiKey, itemId, fallbackValue) {
    const urls = [
      `https://api.torn.com/market/${itemId}?selections=itemmarket&key=${encodeURIComponent(apiKey)}`,
      `https://api.torn.com/v2/market/${itemId}/itemmarket?key=${encodeURIComponent(apiKey)}`,
    ];
    for (const url of urls) {
      try {
        const js = await fetchJson(url);
        const nums = deepFindNumbersWithPriceHeuristic(js, []);
        const reference = Number(fallbackValue || 0);
        const floor = reference > 0 ? reference * 0.35 : 50;
        const ceiling = reference > 0 ? reference * 0.999 : 10_000_000;
        const viable = nums.filter(n => n >= floor && n <= ceiling).sort((a, b) => a - b);
        if (viable.length) return viable[0];
      } catch (_) {
        // fallback next endpoint
      }
    }
    return fallbackValue || 0;
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
      } catch (_) {
        // fallback next endpoint
      }
    }
    return {};
  }

  async function refreshDataIfNeeded(force = false) {
    if (!state.settings.apiKey) return;
    const ageMs = now() - state.lastApiRefresh;
    if (!force && ageMs < state.settings.apiRefreshSeconds * 1000) return;

    const items = await getItemsMaster(state.settings.apiKey);
    if (items.length) {
      state.items = items;
      buildHoldingsEditor(items);
    }

    if (state.settings.useApiInventory) {
      state.apiHoldings = await getInventoryHoldings(state.settings.apiKey);
    }

    const points = await getPointsPrice(state.settings.apiKey);
    if (points) state.pointsPrice = points;

    const jobs = state.items.map(item => getItemLivePrice(state.settings.apiKey, item.id, item.market_value));
    const prices = await Promise.all(jobs);
    prices.forEach((p, idx) => state.pricesById.set(state.items[idx].id, p));

    state.lastApiRefresh = now();
  }

  async function tick() {
    try {
      await refreshDataIfNeeded(false);
      refreshCheapestFromCurrentPage();
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

  async function init() {
    loadState();
    createPanel();
    await refreshDataIfNeeded(true);
    state.metrics = state.items.length ? getSetMetrics(state.items) : null;
    render();
    setInterval(tick, Math.max(3000, state.settings.scanSeconds * 1000));
    setInterval(applyFade, 1000);
  }

  init();
})();

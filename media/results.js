// AuroraLens results grid (runs inside a VS Code webview; no external dependencies).
(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  const ICON = {
    copy: 'M3 4h8v10H3V4zm1 1v8h6V5H4zM5 1h8v10h-1V2H5V1z',
    download: 'M7.5 1h1v8.3l2.6-2.6.7.7L8 11.2 4.2 7.4l.7-.7 2.6 2.6V1zM2 13h12v1H2v-1z',
    code: 'M5.3 4 1.3 8l4 4 .7-.7L2.7 8 6 4.7 5.3 4zm5.4 0-.7.7L13.3 8 10 11.3l.7.7 4-4-4-4z',
    panel: 'M2 2h12v12H2V2zm1 1v10h7V3H3zm8 0v10h2V3h-2z',
    x: 'M3.7 3 8 7.3 12.3 3l.7.7L8.7 8l4.3 4.3-.7.7L8 8.7 3.7 13l-.7-.7L7.3 8 3 3.7l.7-.7z',
    chevron: 'M4.7 5.3 8 8.6l3.3-3.3.7.7L8 10 4 6l.7-.7z',
  };
  const NUMERIC = /^(int2|int4|int8|smallint|integer|bigint|float4|float8|real|double|numeric|decimal|money|oid|serial|bigserial|smallserial)/;
  const TEMPORAL = /^(date|time|timestamp|timestamptz|timetz|interval)/;
  const JSONISH = /^(json|jsonb|_)/; // _int4 etc. are arrays
  const ROW_H = { compact: 22, comfortable: 28, large: 34, xl: 42 };
  const DENSITIES = [
    ['compact', 'S', 'Compact rows'],
    ['comfortable', 'M', 'Comfortable rows'],
    ['large', 'L', 'Large rows'],
    ['xl', 'XL', 'Extra-large rows'],
  ];
  const OVERSCAN = 10;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  const saved = vscode.getState() || {};
  let prefs = Object.assign({ density: 'comfortable', fontSize: 12 }, saved.prefs);
  let data = null; // { columns, types, rows, meta }
  let order = [];
  let rowText = null;
  let sort = { col: -1, dir: 0 };
  let filter = '';
  let widths = [];
  let sel = null; // { r: view index, c: column index }
  let detailOpen = false;
  let showSql = false;
  let menu = null;
  let resizing = false;

  // ---------- helpers ----------
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  function icon(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', ICON[name]);
    p.setAttribute('fill-rule', 'evenodd');
    svg.appendChild(p);
    return svg;
  }
  function btn(label, opts) {
    const b = el('button', `al-btn ${opts.cls || 'ghost'}${label ? '' : ' icon'}`);
    if (opts.icon) b.appendChild(icon(opts.icon));
    if (label) b.appendChild(document.createTextNode(label));
    if (opts.caret) b.appendChild(icon('chevron'));
    b.title = opts.title || label;
    b.setAttribute('aria-label', opts.title || label);
    b.addEventListener('click', opts.onClick);
    return b;
  }
  const fmt = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const kindOf = (t) => (NUMERIC.test(t || '') ? 'num' : TEMPORAL.test(t || '') ? 'time' : t === 'bool' ? 'bool' : JSONISH.test(t || '') ? 'json' : 'text');
  const rowH = () => ROW_H[prefs.density] || 28;
  function toast(text) {
    const t = el('div', 'al-toast', text);
    t.setAttribute('role', 'status');
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1600);
  }
  function savePrefs() {
    vscode.setState({ prefs });
    vscode.postMessage({ type: 'prefs', prefs });
  }

  // ---------- shell ----------
  const toolbar = el('div', 'al-toolbar');
  const sqlbar = el('div', 'sqlbar hidden');
  const notice = el('div', 'notice hidden');
  const main = el('div', 'main');
  const grid = el('div', 'grid');
  const detail = el('aside', 'detail hidden');
  const status = el('div', 'status');
  grid.tabIndex = 0;
  grid.setAttribute('role', 'grid');
  main.append(grid, detail);
  app.append(toolbar, sqlbar, notice, main, status);

  function applyPrefs() {
    app.dataset.density = prefs.density;
    app.style.setProperty('--fs', `${prefs.fontSize}px`);
  }

  function renderToolbar() {
    toolbar.replaceChildren();
    if (!data) return;
    const m = data.meta;
    const chip = el('span', `al-chip env-${m.env.toLowerCase()}`, m.env);
    chip.title = m.readOnly ? 'Read-only connection' : 'Read-write connection';
    toolbar.append(chip, el('span', 'al-title', m.connection));
    if (m.readOnly) toolbar.append(el('span', 'al-chip plain muted', 'read-only'));
    const count = el('span', 'muted', '');
    count.id = 'count';
    toolbar.append(count, el('span', 'grow'));

    const search = el('input', 'al-input al-search');
    search.placeholder = 'Filter rows…';
    search.setAttribute('aria-label', 'Filter rows');
    search.value = filter;
    let timer;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        filter = search.value;
        recompute();
        renderBody(true);
      }, 120);
    });
    toolbar.append(search);

    const seg = el('div', 'al-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Row density');
    for (const [key, label, title] of DENSITIES) {
      const b = el('button', '', label);
      b.title = title;
      b.setAttribute('aria-pressed', String(prefs.density === key));
      b.addEventListener('click', () => {
        prefs.density = key;
        savePrefs();
        applyPrefs();
        renderToolbar();
        renderBody(false);
      });
      seg.appendChild(b);
    }
    toolbar.append(seg);

    const fsLabel = el('span', 'fs-label', `${prefs.fontSize}px`);
    const zoom = (d) => {
      prefs.fontSize = Math.min(20, Math.max(10, prefs.fontSize + d));
      savePrefs();
      applyPrefs();
      fsLabel.textContent = `${prefs.fontSize}px`;
      renderBody(false);
    };
    toolbar.append(
      btn('A−', { title: 'Smaller text', onClick: () => zoom(-1) }),
      fsLabel,
      btn('A+', { title: 'Larger text', onClick: () => zoom(1) }),
      el('span', 'sep'),
      btn('', { icon: 'code', title: 'Show the executed SQL', onClick: () => { showSql = !showSql; renderSqlbar(); } }),
      btn('', { icon: 'panel', title: 'Value details (Enter)', onClick: () => toggleDetail() }),
      btn('Copy', { icon: 'copy', caret: true, title: 'Copy rows', onClick: (e) => openMenu(e.currentTarget, copyMenu('copy')) }),
      btn('Export', { icon: 'download', caret: true, title: 'Save rows to a file', onClick: (e) => openMenu(e.currentTarget, copyMenu('export')) }),
    );
    updateCount();
  }

  function copyMenu(kind) {
    const formats = kind === 'copy' ? [['csv', 'CSV'], ['json', 'JSON'], ['markdown', 'Markdown table']] : [['csv', 'CSV file…'], ['json', 'JSON file…']];
    return formats.map(([format, label]) => ({
      label: `${label}`,
      hint: filter ? `${order.length} rows` : '',
      run: () => {
        vscode.postMessage({ type: kind, format, indices: order });
        if (kind === 'copy') toast(`Copied ${order.length} rows as ${label}`);
      },
    }));
  }

  function updateCount() {
    const c = document.getElementById('count');
    if (!c || !data) return;
    const total = data.rows.length;
    const shown = order.length;
    c.textContent = `${shown === total ? total.toLocaleString() : `${shown.toLocaleString()} of ${total.toLocaleString()}`} rows · ${data.meta.elapsedMs.toLocaleString()} ms`;
  }

  function renderSqlbar() {
    sqlbar.classList.toggle('hidden', !showSql || !data);
    if (data) sqlbar.textContent = data.meta.sql;
  }

  function renderNotice() {
    const m = data && data.meta;
    const show = !!(m && m.truncated);
    notice.classList.toggle('hidden', !show);
    if (show) notice.textContent = `Showing the first ${m.maxRows.toLocaleString()} rows (auroralens.maxRows). Add your own LIMIT to change this.`;
  }

  // ---------- states ----------
  function showEmpty() {
    data = null;
    toolbar.replaceChildren(el('span', 'al-title', 'Results'));
    sqlbar.classList.add('hidden');
    notice.classList.add('hidden');
    detail.classList.add('hidden');
    const e = el('div', 'al-empty');
    e.append(el('h3', '', 'No results yet'));
    const p = el('div');
    p.append('Open a .sql file, put the cursor in a statement and press ');
    p.append(el('kbd', '', navigator.platform.includes('Mac') ? '⌘ Enter' : 'Ctrl+Enter'));
    e.append(p, el('div', '', 'or right-click a table → Select Top 1000.'));
    grid.replaceChildren(e);
    status.textContent = '';
  }

  function showRunning(meta) {
    toolbar.replaceChildren(el('span', `al-chip env-${meta.env.toLowerCase()}`, meta.env), el('span', 'al-title', meta.connection));
    const e = el('div', 'al-empty');
    const row = el('div');
    row.append(el('span', 'al-spinner'));
    e.append(row, el('div', '', `Running on ${meta.env} · ${meta.connection}…`));
    grid.replaceChildren(e);
    notice.classList.add('hidden');
    status.textContent = '';
  }

  function showError(msg) {
    data = null;
    toolbar.replaceChildren(el('span', `al-chip env-${msg.meta.env.toLowerCase()}`, msg.meta.env), el('span', 'al-title', msg.meta.connection));
    notice.classList.add('hidden');
    detail.classList.add('hidden');
    const box = el('div', 'al-error');
    box.setAttribute('role', 'alert');
    box.append(el('h3', '', msg.title), el('p', 'fix', msg.fix), el('pre', '', msg.message));
    grid.replaceChildren(box);
    status.textContent = '';
  }

  function showResult(msg) {
    data = { columns: msg.columns, types: msg.types, rows: msg.rows, meta: msg.meta };
    if (msg.prefs) prefs = Object.assign(prefs, msg.prefs);
    applyPrefs();
    rowText = null;
    sort = { col: -1, dir: 0 };
    filter = '';
    sel = data.rows.length ? { r: 0, c: 0 } : null;
    widths = data.columns.map((_, i) => estimateWidth(i, 120));
    app.style.setProperty('--rn-w', `${String(data.rows.length).length * 8 + 22}px`);
    recompute();
    renderToolbar();
    renderSqlbar();
    renderNotice();
    if (!data.columns.length) {
      const e = el('div', 'al-empty');
      e.append(el('h3', '', 'Statement executed'), el('div', '', 'It returned no result set.'));
      grid.replaceChildren(e);
      return;
    }
    buildGrid();
    if (!data.rows.length) {
      const e = el('div', 'al-empty');
      e.append(el('h3', '', 'No rows'), el('div', '', 'The query ran successfully and returned no rows.'));
      grid.appendChild(e);
    }
    renderDetail();
    updateStatus();
  }

  // ---------- data ----------
  function estimateWidth(i, sample) {
    const charW = prefs.fontSize * 0.62;
    let max = 0;
    const n = Math.min(sample, data.rows.length);
    for (let r = 0; r < n; r++) max = Math.max(max, Math.min(80, fmt(data.rows[r][i]).length));
    const head = Math.max(data.columns[i].length * charW * 1.08 + 34, (data.types[i] || '').length * 6 + 24);
    return Math.round(Math.min(sample > 200 ? 800 : 420, Math.max(64, head, max * charW + 24)));
  }

  function compare(x, y, kind) {
    if (kind === 'num') {
      const a = Number(x), b = Number(y);
      if (!Number.isNaN(a) && !Number.isNaN(b)) return a - b;
    }
    if (kind === 'bool') return x === y ? 0 : x ? 1 : -1;
    if (kind === 'time') return String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
    return collator.compare(fmt(x), fmt(y));
  }

  function recompute() {
    const rows = data.rows;
    let idx = rows.map((_, i) => i);
    const q = filter.trim().toLowerCase();
    if (q) {
      if (!rowText) rowText = rows.map((r) => r.map(fmt).join('\u0001').toLowerCase());
      idx = idx.filter((i) => rowText[i].includes(q));
    }
    if (sort.dir && sort.col >= 0) {
      const c = sort.col;
      const kind = kindOf(data.types[c]);
      idx.sort((a, b) => {
        const x = rows[a][c], y = rows[b][c];
        const xn = x === null || x === undefined, yn = y === null || y === undefined;
        if (xn || yn) return xn && yn ? a - b : xn ? 1 : -1; // NULLs last in both directions
        return compare(x, y, kind) * sort.dir || a - b;
      });
    }
    order = idx;
    if (sel) sel.r = Math.min(sel.r, Math.max(0, order.length - 1));
    updateCount();
  }

  // ---------- grid ----------
  let head, body;
  function applyCols() {
    app.style.setProperty('--cols', `var(--rn-w) ${widths.map((w) => `${w}px`).join(' ')}`);
  }

  function buildGrid() {
    head = el('div', 'ghead');
    head.setAttribute('role', 'row');
    const rn = el('div', 'hcell rn', '#');
    head.appendChild(rn);
    data.columns.forEach((name, i) => {
      const h = el('div', 'hcell');
      h.setAttribute('role', 'columnheader');
      h.dataset.c = String(i);
      const n = el('div', 'name');
      n.append(el('span', '', name), el('span', 'arrow', ''));
      const t = el('div', 'type', data.types[i] || '');
      const rz = el('div', 'resize');
      rz.title = 'Drag to resize · double-click to fit';
      h.append(n, t, rz);
      h.title = `${name}${data.types[i] ? ` (${data.types[i]})` : ''}\nClick to sort`;
      h.addEventListener('click', (e) => {
        if (resizing || e.target === rz) return;
        sort = sort.col !== i ? { col: i, dir: 1 } : { col: i, dir: sort.dir === 1 ? -1 : sort.dir === -1 ? 0 : 1 };
        recompute();
        renderHeadArrows();
        renderBody(false);
      });
      setupResize(rz, i);
      head.appendChild(h);
    });
    body = el('div', 'gbody');
    grid.replaceChildren(head, body);
    grid.setAttribute('aria-colcount', String(data.columns.length));
    applyCols();
    renderHeadArrows();
    grid.scrollTop = 0;
    grid.scrollLeft = 0;
    renderBody(false);
  }

  function renderHeadArrows() {
    head.querySelectorAll('.hcell[data-c]').forEach((h) => {
      const c = Number(h.dataset.c);
      h.querySelector('.arrow').textContent = sort.col === c && sort.dir ? (sort.dir > 0 ? '▲' : '▼') : '';
      h.setAttribute('aria-sort', sort.col === c && sort.dir ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none');
    });
  }

  function setupResize(handle, i) {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      resizing = true;
      handle.classList.add('active');
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX, startW = widths[i];
      const move = (ev) => {
        widths[i] = Math.max(40, Math.round(startW + ev.clientX - startX));
        applyCols();
      };
      const up = () => {
        handle.classList.remove('active');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        setTimeout(() => (resizing = false), 0);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    handle.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      widths[i] = estimateWidth(i, 2000);
      applyCols();
    });
  }

  let rafPending = false;
  grid.addEventListener('scroll', () => {
    closeMenu();
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      renderBody(false);
    });
  });

  function cellEl(v, type, r, c) {
    const kind = kindOf(type);
    let cls = 'cell';
    if (v === null || v === undefined) cls += ' null';
    else if (kind === 'num' || typeof v === 'number') cls += ' num';
    else if (typeof v === 'boolean') cls += v ? ' bool-true' : ' bool-false';
    else if (kind === 'json' || typeof v === 'object') cls += ' json';
    if (sel && sel.r === r && sel.c === c) cls += ' sel';
    const d = el('div', cls, fmt(v));
    d.setAttribute('role', 'gridcell');
    d.dataset.r = String(r);
    d.dataset.c = String(c);
    return d;
  }

  function renderBody(resetScroll) {
    if (!data || !body) return;
    if (resetScroll) grid.scrollTop = 0;
    const h = rowH();
    body.style.height = `${order.length * h}px`;
    grid.setAttribute('aria-rowcount', String(order.length));
    const headH = head.offsetHeight;
    const top = Math.max(0, grid.scrollTop - headH);
    const first = Math.max(0, Math.floor(top / h) - OVERSCAN);
    const last = Math.min(order.length, Math.ceil((top + grid.clientHeight) / h) + OVERSCAN);
    const frag = document.createDocumentFragment();
    for (let r = first; r < last; r++) {
      const src = data.rows[order[r]];
      const row = el('div', `grow-r${r % 2 ? ' odd' : ''}`);
      row.setAttribute('role', 'row');
      row.setAttribute('aria-rowindex', String(r + 1));
      row.style.top = `${r * h}px`;
      const rn = el('div', 'cell rn', String(order[r] + 1));
      row.appendChild(rn);
      for (let c = 0; c < data.columns.length; c++) row.appendChild(cellEl(src[c], data.types[c], r, c));
      frag.appendChild(row);
    }
    body.replaceChildren(frag);
  }

  // ---------- selection, keyboard, detail ----------
  function cellAt(target) {
    const c = target.closest && target.closest('.cell[data-c]');
    return c ? { r: Number(c.dataset.r), c: Number(c.dataset.c) } : null;
  }
  function select(pos, reveal) {
    sel = pos;
    body.querySelectorAll('.cell.sel').forEach((x) => x.classList.remove('sel'));
    const node = body.querySelector(`.cell[data-r="${pos.r}"][data-c="${pos.c}"]`);
    if (node) node.classList.add('sel');
    if (reveal) {
      const h = rowH();
      const headH = head.offsetHeight;
      const y = pos.r * h;
      if (y < grid.scrollTop) grid.scrollTop = y;
      else if (y + h > grid.scrollTop + grid.clientHeight - headH) grid.scrollTop = y + h - grid.clientHeight + headH;
      renderBody(false);
      const again = body.querySelector(`.cell[data-r="${pos.r}"][data-c="${pos.c}"]`);
      if (again) again.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    renderDetail();
    updateStatus();
  }
  const valueAt = (pos) => data.rows[order[pos.r]][pos.c];

  grid.addEventListener('click', (e) => {
    const pos = data && cellAt(e.target);
    if (pos) select(pos, false);
  });
  grid.addEventListener('dblclick', (e) => {
    const pos = data && cellAt(e.target);
    if (pos) {
      select(pos, false);
      toggleDetail(true);
    }
  });
  grid.addEventListener('contextmenu', (e) => {
    const pos = data && cellAt(e.target);
    if (!pos) return;
    e.preventDefault();
    select(pos, false);
    const v = valueAt(pos);
    const name = data.columns[pos.c];
    openMenuAt(e.clientX, e.clientY, [
      { label: 'Copy value', hint: 'Ctrl+C', run: () => copyText(fmt(v)) },
      { label: 'Copy row as JSON', run: () => copyText(JSON.stringify(Object.fromEntries(data.columns.map((c, i) => [c, data.rows[order[pos.r]][i] ?? null])), null, 2)) },
      { label: 'Copy column name', run: () => copyText(name) },
      null,
      { label: 'Filter to this value', run: () => { filter = fmt(v); recompute(); renderToolbar(); renderBody(true); } },
      { label: 'Show value details', hint: 'Enter', run: () => toggleDetail(true) },
    ]);
  });

  grid.addEventListener('keydown', (e) => {
    if (!data || !sel || !order.length) return;
    const mod = e.metaKey || e.ctrlKey;
    const move = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageUp: [-20, 0], PageDown: [20, 0] }[e.key];
    if (move) {
      e.preventDefault();
      select({ r: clamp(sel.r + move[0], 0, order.length - 1), c: clamp(sel.c + move[1], 0, data.columns.length - 1) }, true);
    } else if (e.key === 'Home' && mod) {
      e.preventDefault();
      select({ r: 0, c: 0 }, true);
    } else if (e.key === 'End' && mod) {
      e.preventDefault();
      select({ r: order.length - 1, c: data.columns.length - 1 }, true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      toggleDetail(true);
    } else if (e.key === 'Escape') {
      if (detailOpen) toggleDetail(false);
    } else if (mod && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      copyText(fmt(valueAt(sel)));
    }
  });
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function copyText(text) {
    vscode.postMessage({ type: 'copyText', text });
    toast('Copied');
  }

  function toggleDetail(force) {
    detailOpen = typeof force === 'boolean' ? force : !detailOpen;
    renderDetail();
  }

  function pretty(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'object') return JSON.stringify(v, null, 2);
    const s = String(v);
    if (/^\s*[[{]/.test(s)) {
      try {
        return JSON.stringify(JSON.parse(s), null, 2);
      } catch {
        /* not JSON */
      }
    }
    return s;
  }

  function renderDetail() {
    detail.classList.toggle('hidden', !detailOpen || !data || !sel || !order.length);
    if (detail.classList.contains('hidden')) return;
    const v = valueAt(sel);
    const name = data.columns[sel.c];
    const header = el('header');
    const title = el('span', 'title', name);
    header.append(
      title,
      el('span', 'muted', data.types[sel.c] || ''),
      el('span', 'grow'),
      btn('', { icon: 'copy', title: 'Copy value', onClick: () => copyText(pretty(v)) }),
      btn('', { icon: 'x', title: 'Close (Esc)', onClick: () => toggleDetail(false) }),
    );
    detail.replaceChildren(header, el('pre', '', pretty(v)));
  }

  function updateStatus() {
    if (!data || !sel || !order.length) {
      status.textContent = '';
      return;
    }
    status.replaceChildren(
      el('span', '', `Row ${(order[sel.r] + 1).toLocaleString()}`),
      el('span', '', `${data.columns[sel.c]}${data.types[sel.c] ? ` · ${data.types[sel.c]}` : ''}`),
      el('span', 'grow'),
      el('span', '', 'Arrows to move · Enter for details · Ctrl/⌘+C to copy · right-click for more'),
    );
  }

  // ---------- menus ----------
  function closeMenu() {
    if (menu) {
      menu.remove();
      menu = null;
    }
  }
  function openMenu(anchor, items) {
    const r = anchor.getBoundingClientRect();
    openMenuAt(r.left, r.bottom + 2, items);
  }
  function openMenuAt(x, y, items) {
    closeMenu();
    menu = el('div', 'al-menu');
    menu.setAttribute('role', 'menu');
    for (const it of items) {
      if (!it) {
        menu.appendChild(el('hr'));
        continue;
      }
      const b = el('button');
      b.setAttribute('role', 'menuitem');
      b.append(el('span', '', it.label));
      if (it.hint) b.append(el('span', 'key', it.hint));
      b.addEventListener('click', () => {
        closeMenu();
        it.run();
      });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = `${Math.min(x, window.innerWidth - mw - 4)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - mh - 4)}px`;
    menu.querySelector('button')?.focus();
    menu.addEventListener('keydown', (e) => {
      const buttons = [...menu.querySelectorAll('button')];
      const i = buttons.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length].focus(); }
      if (e.key === 'Escape') { closeMenu(); grid.focus(); }
    });
  }
  document.addEventListener('mousedown', (e) => {
    if (menu && !menu.contains(e.target)) closeMenu();
  });
  window.addEventListener('resize', () => {
    closeMenu();
    renderBody(false);
  });

  // ---------- messages ----------
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'result') showResult(msg);
    else if (msg.type === 'running') showRunning(msg.meta);
    else if (msg.type === 'error') showError(msg);
    else if (msg.type === 'empty') showEmpty();
  });

  applyPrefs();
  showEmpty();
  vscode.postMessage({ type: 'ready' });
})();

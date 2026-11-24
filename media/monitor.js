// AuroraLens cluster monitor (VS Code webview).
(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  };
  const svgEl = (tag, attrs) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, String(v));
    return e;
  };

  let info = null;
  let autoTimer = null;
  const sections = {};
  const SECTION_IDS = ['cluster', 'metrics', 'instances', 'overview', 'sessions', 'running', 'largest', 'statements'];

  // ---------- formatting ----------
  const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  function bytes(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    n = Number(n);
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${i ? n.toFixed(1) : n} ${u[i]}`;
  }
  function value(n, unit) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    if (unit === 'percent') return `${nf.format(n)}%`;
    if (unit === 'bytes') return bytes(n);
    if (unit === 'ms') return `${nf.format(n)} ms`;
    if (unit === 'acu') return `${nf.format(n)} ACU`;
    return nf.format(n);
  }
  function duration(s) {
    s = Number(s) || 0;
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }
  const count = (n) => (n === null || n === undefined ? '—' : Number(n) >= 1e6 ? `${(Number(n) / 1e6).toFixed(1)}M` : Number(n) >= 1e3 ? `${(Number(n) / 1e3).toFixed(1)}K` : String(n));
  const time = (t, range) => new Date(t).toLocaleString(undefined, range === '7d' ? { month: 'short', day: 'numeric', hour: '2-digit' } : { hour: '2-digit', minute: '2-digit' });

  function copy(text) {
    vscode.postMessage({ type: 'copyText', text });
    const t = el('div', 'al-toast', 'Copied');
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1200);
  }

  // ---------- layout ----------
  function shell() {
    const tb = el('div', 'al-toolbar');
    const chip = el('span', `al-chip env-${info.env.toLowerCase()}`, info.env);
    tb.append(chip, el('span', 'al-title', info.connection), el('span', 'muted mono', info.cluster), el('span', 'grow'));

    const seg = el('div', 'al-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Time range');
    for (const r of ['1h', '6h', '24h', '7d']) {
      const b = el('button', '', r);
      b.title = `Show the last ${r}`;
      b.setAttribute('aria-pressed', String(info.range === r));
      b.addEventListener('click', () => vscode.postMessage({ type: 'refresh', range: r }));
      seg.appendChild(b);
    }
    const auto = el('button', 'al-btn ghost', autoTimer ? 'Auto-refresh: on' : 'Auto-refresh: off');
    auto.title = 'Refresh every 60 seconds';
    auto.addEventListener('click', () => {
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
      else autoTimer = setInterval(() => vscode.postMessage({ type: 'refresh', range: info.range }), 60000);
      auto.textContent = autoTimer ? 'Auto-refresh: on' : 'Auto-refresh: off';
    });
    const refresh = el('button', 'al-btn', 'Refresh');
    refresh.addEventListener('click', () => vscode.postMessage({ type: 'refresh', range: info.range }));
    const consoleBtn = el('button', 'al-btn ghost', 'Open in AWS Console ↗');
    consoleBtn.addEventListener('click', () => vscode.postMessage({ type: 'console' }));
    tb.append(seg, auto, refresh, consoleBtn);

    const content = el('div', 'content');
    const block = (title, id) => {
      content.append(el('div', 'al-section-title', title));
      const box = el('div');
      box.id = `sec-${id}`;
      const l = el('div', 'loading');
      l.append(el('span', 'al-spinner'), el('span', '', 'Loading…'));
      box.appendChild(l);
      content.append(box);
    };
    block('Cluster', 'cluster');
    block(`Metrics · last ${info.range}`, 'metrics');
    block('Instances', 'instances');
    block('Database health', 'overview');
    const two = el('div', 'two');
    for (const [title, id] of [['Sessions by state', 'sessions'], ['Running now', 'running']]) {
      const c = el('div');
      c.append(el('div', 'al-section-title', title));
      const box = el('div');
      box.id = `sec-${id}`;
      box.appendChild(el('div', 'loading', 'Loading…'));
      c.append(box);
      two.append(c);
    }
    content.append(two);
    block('Largest tables', 'largest');
    block('Top statements (pg_stat_statements)', 'statements');
    const note = el('p', 'muted', 'Cluster, instance and metric sections use your AWS role (rds:Describe*, cloudwatch:GetMetricData). Database sections use the connection’s own database access. Everything is read-only.');
    note.classList.add('privacy');
    content.append(note);
    app.replaceChildren(tb, content);
  }

  function sectionError(box, err) {
    const e = el('div', 'sec-error');
    e.append(el('b', '', err.title), el('div', 'fix', err.fix));
    e.title = err.message;
    box.replaceChildren(e);
  }

  function table(headers, rows, opts = {}) {
    const t = el('table', 'al-table');
    const thead = el('thead');
    const tr = el('tr');
    headers.forEach(([label, cls]) => tr.appendChild(el('th', cls || '', label)));
    thead.appendChild(tr);
    const tb = el('tbody');
    for (const r of rows) {
      const row = el('tr');
      r.forEach((cell, i) => {
        const td = el('td', headers[i][1] || '', cell);
        if (headers[i][1] === 'sql') {
          td.title = `${cell}\n\nClick to copy`;
          td.classList.add('copyable');
          td.addEventListener('click', () => copy(cell));
        }
        row.appendChild(td);
      });
      tb.appendChild(row);
    }
    if (!rows.length) {
      const row = el('tr');
      const td = el('td', 'muted', opts.empty || 'Nothing to show');
      td.colSpan = headers.length;
      row.appendChild(td);
      tb.appendChild(row);
    }
    t.append(thead, tb);
    return t;
  }

  // ---------- section renderers ----------
  const render = {
    cluster(d, box) {
      const status = d.status || 'unknown';
      const facts = [
        ['Status', status, false, status === 'available' ? 'ok' : 'warn'],
        ['Engine', `${d.engine} ${d.engineVersion}`],
        ['Capacity', d.capacity || `${d.members} instance${d.members === 1 ? '' : 's'}`],
        ['RDS Data API', d.dataApi ? 'Enabled' : 'Disabled', false, d.dataApi ? 'ok' : 'bad'],
        ['Storage encryption', d.encrypted ? 'Encrypted' : 'Not encrypted', false, d.encrypted ? 'ok' : 'bad'],
        ['Deletion protection', d.deletionProtection ? 'On' : 'Off', false, d.deletionProtection ? 'ok' : 'warn'],
        ['Backup retention', `${d.backupDays} day${d.backupDays === 1 ? '' : 's'}`],
        ['IAM database auth', d.iamAuth ? 'On' : 'Off'],
        ['Writer endpoint', d.endpoint, true],
        ['Reader endpoint', d.readerEndpoint, true],
      ];
      const grid = el('div', 'facts');
      for (const [k, v, mono, state] of facts) {
        const f = el('div', `fact${mono ? ' click' : ''}`);
        const val = el('div', `v${mono ? ' mono' : ''}`);
        if (state) val.append(el('span', `al-chip ${state}`, v));
        else val.textContent = v ?? '—';
        f.append(el('div', 'k', k), val);
        f.title = v ? String(v) : '';
        if (mono && v) {
          f.title = `${v}\nClick to copy`;
          f.addEventListener('click', () => copy(v));
        }
        grid.appendChild(f);
      }
      box.replaceChildren(grid);
    },

    metrics(d, box) {
      const grid = el('div', 'charts');
      for (const s of d.series) grid.appendChild(chart(s, d));
      box.replaceChildren(grid);
    },

    instances(rows, box) {
      box.replaceChildren(
        table(
          [['Instance'], ['Role'], ['Class'], ['Status'], ['Availability zone'], ['Performance Insights']],
          rows.map((i) => [i.id, i.role, i.class, i.status, i.az, i.performanceInsights ? 'On' : 'Off']),
          { empty: 'No provisioned instances (Serverless)' },
        ),
      );
    },

    overview(d, box) {
      const k = el('div', 'kpis');
      const sessions = sections.sessions && Array.isArray(sections.sessions) ? sections.sessions.reduce((a, r) => a + Number(r.sessions), 0) : null;
      const tiles = [
        ['Database size', bytes(d.size_bytes), d.version],
        ['Cache hit ratio', d.cache_hit_pct === null || d.cache_hit_pct === undefined ? '—' : `${d.cache_hit_pct}%`, Number(d.cache_hit_pct) < 95 ? 'Below 95%: working set may not fit in memory' : 'Healthy (≥ 95%)'],
        ['Sessions', sessions === null ? '—' : String(sessions), `of ${d.max_connections} max_connections`],
        ['Transactions', count(d.transactions), 'since statistics reset'],
        ['Deadlocks', count(d.deadlocks), 'since statistics reset'],
      ];
      for (const [label, v, sub] of tiles) {
        const t = el('div', 'kpi');
        t.append(el('div', 'k', label), el('div', 'v', v), el('div', 's', sub || ''));
        k.appendChild(t);
      }
      box.replaceChildren(k);
    },

    sessions(rows, box) {
      const max = Math.max(1, ...rows.map((r) => Number(r.sessions)));
      const bars = el('div', 'bars');
      for (const r of rows) {
        const row = el('div', 'bar-row');
        const track = el('div', 'bar-track');
        const fill = el('div', 'bar-fill');
        fill.style.width = `${(Number(r.sessions) / max) * 100}%`;
        track.appendChild(fill);
        row.append(el('span', '', r.state), track, el('span', 'n', String(r.sessions)));
        bars.appendChild(row);
      }
      box.replaceChildren(rows.length ? bars : el('div', 'muted', 'No sessions'));
      if (sections.overview && !sections.overview.error) render.overview(sections.overview, document.getElementById('sec-overview'));
    },

    running(rows, box) {
      box.replaceChildren(
        table(
          [['PID', 'num'], ['User'], ['State'], ['Running', 'num'], ['Waiting on'], ['Query', 'sql']],
          rows.map((r) => [String(r.pid), r.db_user, r.state, duration(r.seconds), r.waiting_on || '—', r.query]),
          { empty: 'No other active queries' },
        ),
      );
    },

    largest(rows, box) {
      box.replaceChildren(
        table(
          [['Table'], ['Total size', 'num'], ['Rows (est.)', 'num']],
          rows.map((r) => [`${r.schema}.${r.name}`, bytes(r.bytes), count(r.estimate)]),
        ),
      );
    },

    statements(d, box) {
      if (d && d.unavailable) {
        const e = el('div', 'sec-error');
        e.append(el('b', '', 'pg_stat_statements is not enabled'), el('div', 'fix', 'Ask a DBA to add pg_stat_statements to shared_preload_libraries and run CREATE EXTENSION pg_stat_statements; to see the most expensive statements here.'));
        box.replaceChildren(e);
        return;
      }
      box.replaceChildren(
        table(
          [['Statement', 'sql'], ['Calls', 'num'], ['Total ms', 'num'], ['Mean ms', 'num'], ['Rows', 'num']],
          d.map((r) => [r.query, count(r.calls), nf.format(r.total_ms), nf.format(r.mean_ms), count(r.rows)]),
        ),
      );
    },
  };

  // ---------- line chart (single series, hover crosshair) ----------
  function chart(s, d) {
    const card = el('div', 'chart');
    const pts = s.points;
    const last = pts.length ? pts[pts.length - 1].v : null;
    const vals = pts.map((p) => p.v);
    const lo = vals.length ? Math.min(...vals) : 0;
    const hi = vals.length ? Math.max(...vals) : 0;
    card.append(el('div', 't', s.title), el('div', 'big', value(last, s.unit)), el('div', 'range', pts.length ? `min ${value(lo, s.unit)} · max ${value(hi, s.unit)}` : ''));
    if (pts.length < 2) {
      card.append(el('div', 'nodata', 'No data points in this range'));
      return card;
    }
    const W = 300, H = 96, padL = 0, padB = 14, padT = 4;
    const top = s.unit === 'percent' ? Math.max(100 * (hi > 60 ? 1 : 0.6), hi) : hi * 1.1 || 1;
    const x = (t) => padL + ((t - d.start) / (d.end - d.start)) * (W - padL);
    const y = (v) => padT + (1 - v / top) * (H - padT - padB);
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `${s.title}: latest ${value(last, s.unit)}, min ${value(lo, s.unit)}, max ${value(hi, s.unit)}` });
    svg.append(svgEl('line', { class: 'grid', x1: 0, x2: W, y1: y(0), y2: y(0), 'vector-effect': 'non-scaling-stroke' }));
    svg.append(svgEl('line', { class: 'grid', x1: 0, x2: W, y1: y(top / 2), y2: y(top / 2), 'vector-effect': 'non-scaling-stroke', 'stroke-dasharray': '2 4' }));
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
    svg.append(svgEl('path', { class: 'area', d: `${line}L${x(pts[pts.length - 1].t).toFixed(1)},${y(0)}L${x(pts[0].t).toFixed(1)},${y(0)}Z` }));
    svg.append(svgEl('path', { class: 'line', d: line, 'vector-effect': 'non-scaling-stroke' }));
    const cross = svgEl('line', { class: 'cross hidden', y1: padT, y2: H - padB, 'vector-effect': 'non-scaling-stroke' });
    svg.append(cross);
    card.append(svg);
    const axis = el('div', 'range');
    axis.textContent = `${time(d.start, d.range)} → ${time(d.end, d.range)}`;
    card.append(axis);

    const dot = el('div', 'hdot hidden');
    const tip = el('div', 'tip hidden');
    card.append(dot, tip);
    svg.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      const t = d.start + ((e.clientX - r.left) / r.width) * (d.end - d.start);
      let best = pts[0];
      for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
      const px = x(best.t);
      cross.setAttribute('x1', px);
      cross.setAttribute('x2', px);
      cross.classList.remove('hidden');
      tip.replaceChildren(el('b', '', value(best.v, s.unit)), document.createTextNode(` · ${new Date(best.t).toLocaleString()}`));
      tip.classList.remove('hidden');
      const cr = card.getBoundingClientRect();
      const left = r.left - cr.left + (px / W) * r.width;
      tip.style.left = `${Math.min(Math.max(4, left - tip.offsetWidth / 2), cr.width - tip.offsetWidth - 4)}px`;
      const py = r.top - cr.top + (y(best.v) / H) * r.height;
      tip.style.top = `${py - 34}px`;
      dot.style.left = `${left - 5}px`;
      dot.style.top = `${py - 5}px`;
      dot.classList.remove('hidden');
    });
    svg.addEventListener('mouseleave', () => {
      cross.classList.add('hidden');
      tip.classList.add('hidden');
      dot.classList.add('hidden');
    });
    return card;
  }

  // ---------- messages ----------
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'init') {
      info = m;
      SECTION_IDS.forEach((id) => delete sections[id]);
      shell();
    } else if (m.type === 'section') {
      const box = document.getElementById(`sec-${m.name}`);
      if (!box) return;
      sections[m.name] = m.error ? { error: m.error } : m.data;
      if (m.error) sectionError(box, m.error);
      else render[m.name](m.data, box);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();

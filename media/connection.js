// AuroraLens connection form (VS Code webview).
(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  const ENV_NOTES = {
    dev: 'Development. Read-only by default; you can allow writes in settings.',
    qa: 'QA / test. Writes need confirmation each time when read-only mode is off.',
    staging: 'Staging. Writes need confirmation each time when read-only mode is off.',
    prod: 'Production. Always read-only — enforced by the database, cannot be turned off.',
  };
  const CLUSTER_ARN = /^arn:aws(?:-cn|-us-gov|-iso|-iso-b)?:rds:([a-z]{2}(?:-[a-z]+)+-\d{1,2}):(\d{12}):cluster:/;

  let values = {};
  let errors = {};
  const touched = new Set();
  let submitted = false;
  const inputs = {};
  const errEls = {};
  let envButtons = [];
  let envNote;
  let testBtn, saveBtn, stepsBox;

  function field(key, label, opts) {
    const f = el('div', `field${opts.wide ? ' wide' : ''}`);
    const id = `f-${key}`;
    const l = el('label', '', label);
    l.htmlFor = id;
    const input = el('input', `al-input${opts.mono ? ' mono' : ''}`);
    input.id = id;
    input.placeholder = opts.placeholder || '';
    input.spellcheck = false;
    input.autocomplete = 'off';
    if (opts.list) input.setAttribute('list', opts.list);
    input.value = values[key] || '';
    input.addEventListener('input', () => {
      values[key] = input.value.trim();
      if (key === 'clusterArn') autofillRegion();
      validate();
    });
    input.addEventListener('blur', () => {
      touched.add(key);
      showErrors();
    });
    const err = el('div', 'err');
    err.id = `${id}-err`;
    input.setAttribute('aria-describedby', `${id}-help ${id}-err`);
    const help = el('div', 'help', opts.help || '');
    help.id = `${id}-help`;
    f.append(l, input, help, err);
    inputs[key] = input;
    errEls[key] = err;
    return f;
  }

  function autofillRegion() {
    const m = CLUSTER_ARN.exec(values.clusterArn || '');
    if (m && !values.region) {
      values.region = m[1];
      inputs.region.value = m[1];
    }
  }

  let vTimer;
  function validate() {
    clearTimeout(vTimer);
    vTimer = setTimeout(() => vscode.postMessage({ type: 'validate', values }), 150);
  }

  function showErrors(focus) {
    let first;
    for (const key of Object.keys(inputs)) {
      const msg = (submitted || touched.has(key)) && errors[key] ? errors[key] : '';
      errEls[key].textContent = msg;
      inputs[key].classList.toggle('invalid', !!msg);
      inputs[key].setAttribute('aria-invalid', String(!!msg));
      if (msg && !first) first = inputs[key];
    }
    if (focus && first) first.focus();
  }

  function setEnv(env) {
    values.environment = env;
    envButtons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.env === env)));
    envNote.textContent = ENV_NOTES[env] || '';
    envNote.classList.toggle('prod', env === 'prod');
    validate();
  }

  function render(init) {
    values = init.values || {};
    const hero = el('div', 'hero');
    const h = el('div');
    h.append(
      el('h1', '', init.mode === 'edit' ? `Edit connection` : 'New connection'),
      el('p', '', 'Connect to an Amazon Aurora PostgreSQL cluster through the RDS Data API. You need the cluster ARN, the ARN of a Secrets Manager secret for a database user, and the database name.'),
    );
    hero.append(h);

    const form = el('div', 'form');
    form.append(
      field('name', 'Display name', { placeholder: 'orders-dev', help: 'Shown in the sidebar and status bar.' }),
    );

    const envField = el('div', 'field');
    envField.append(el('label', '', 'Environment'));
    const envs = el('div', 'envs');
    envs.setAttribute('role', 'radiogroup');
    envs.setAttribute('aria-label', 'Environment');
    envButtons = init.environments.map((env) => {
      const b = el('button', 'env', env === 'qa' ? 'QA' : env[0].toUpperCase() + env.slice(1));
      b.type = 'button';
      b.dataset.env = env;
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => setEnv(env));
      envs.appendChild(b);
      return b;
    });
    envNote = el('div', 'env-note');
    envField.append(envs, envNote);
    form.append(envField);

    const dl = el('datalist');
    dl.id = 'profiles';
    for (const p of init.profiles) {
      const o = el('option');
      o.value = p;
      dl.appendChild(o);
    }
    form.append(
      field('profile', 'AWS profile', {
        placeholder: 'my-sso-profile',
        list: 'profiles',
        help: init.profiles.length ? `${init.profiles.length} profiles found in ~/.aws/config. Start typing to pick one.` : 'A profile from ~/.aws/config.',
      }),
      field('region', 'Region', { placeholder: 'us-east-1', help: 'Filled in from the cluster ARN.' }),
      field('clusterArn', 'Cluster ARN', {
        wide: true,
        mono: true,
        placeholder: 'arn:aws:rds:us-east-1:111122223333:cluster:orders-dev',
        help: 'RDS console → Databases → your cluster → Configuration → Amazon Resource Name.',
      }),
      field('secretArn', 'Database secret ARN', {
        wide: true,
        mono: true,
        placeholder: 'arn:aws:secretsmanager:us-east-1:111122223333:secret:orders-dev-reader-AbCdEf',
        help: 'Secrets Manager → your secret → Secret ARN. Prefer a secret for a read-only database user.',
      }),
      field('database', 'Database name', { placeholder: 'orders', help: 'Case-sensitive.' }),
      dl,
    );

    const actions = el('div', 'actions');
    testBtn = el('button', 'al-btn', 'Test connection');
    testBtn.type = 'button';
    testBtn.addEventListener('click', () => {
      submitted = true;
      showErrors();
      testBtn.disabled = true;
      testBtn.textContent = 'Testing…';
      vscode.postMessage({ type: 'test', values });
    });
    saveBtn = el('button', 'al-btn primary', init.mode === 'edit' ? 'Save changes' : 'Save connection');
    saveBtn.type = 'button';
    saveBtn.addEventListener('click', () => {
      submitted = true;
      vscode.postMessage({ type: 'save', values });
    });
    const cancel = el('button', 'al-btn ghost', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
    actions.append(saveBtn, testBtn, el('span', 'grow'), cancel);

    stepsBox = el('div', 'steps');
    stepsBox.setAttribute('aria-live', 'polite');

    const privacy = el(
      'p',
      'privacy',
      'Saved in your VS Code user settings (never in the workspace). Only names and ARNs are stored. AuroraLens never stores AWS keys, tokens or database passwords: the RDS Data API reads the secret inside AWS.',
    );

    app.replaceChildren(hero, form, actions, stepsBox, privacy);
    setEnv(values.environment || 'dev');
    inputs.name.focus();
    validate();
  }

  function renderSteps(steps) {
    const marks = { ok: '✓', fail: '✕', running: '', pending: '○', skip: '–' };
    stepsBox.replaceChildren(el('div', 'al-section-title', 'Connection test'));
    for (const s of steps) {
      const row = el('div', `step ${s.status}`);
      const mark = el('div', 'mark', marks[s.status]);
      if (s.status === 'running') mark.appendChild(el('span', 'al-spinner'));
      row.append(mark, el('div', 'label', s.label));
      if (s.detail) row.append(el('div', 'detail', s.detail));
      if (s.fix) row.append(el('div', 'fix', s.fix));
      stepsBox.appendChild(row);
    }
    const done = steps.every((s) => s.status !== 'running' && s.status !== 'pending');
    if (done) {
      const ok = steps.every((s) => s.status === 'ok');
      stepsBox.appendChild(el('div', `result-banner ${ok ? 'ok' : 'fail'}`, ok ? '✓ Everything works. Save the connection to start querying.' : 'Fix the first failing step above, then test again.'));
    }
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'init') render(m);
    else if (m.type === 'errors') {
      errors = m.errors || {};
      showErrors(!!m.focus);
    } else if (m.type === 'steps') renderSteps(m.steps);
    else if (m.type === 'testDone') {
      testBtn.disabled = false;
      testBtn.textContent = 'Test connection';
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') saveBtn && saveBtn.click();
  });

  vscode.postMessage({ type: 'ready' });
})();

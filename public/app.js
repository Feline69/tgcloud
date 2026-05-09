(function () {
  'use strict';

  let BASE         = '/cloud';
  let TUS_ENDPOINT = '/cloud/files';
  let currentPath  = '';
  let currentUser  = null; // { username, is_admin, id }

  // ── Helpers ──────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }
  function fmtSize(n) {
    if (!Number.isFinite(n) || n < 0) return '—';
    const u = ['B','KB','MB','GB','TB'];
    let i = 0, x = n;
    while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
    return (x < 10 && i > 0 ? x.toFixed(1) : Math.round(x)) + ' ' + u[i];
  }
  function fmtDate(epoch) {
    if (!epoch) return '';
    return new Date(epoch * 1000).toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function fileIcon(mimeType, name) {
    if (!mimeType) mimeType = '';
    if (mimeType.startsWith('image/'))  return '🖼️';
    if (mimeType.startsWith('video/'))  return '🎬';
    if (mimeType.startsWith('audio/'))  return '🎵';
    if (mimeType.includes('pdf'))       return '📕';
    if (mimeType.includes('zip') || mimeType.includes('tar') || mimeType.includes('compress')) return '🗜️';
    if (mimeType.includes('text') || /\.(txt|md|log)$/i.test(name)) return '📄';
    if (/\.(js|ts|py|go|rs|java|c|cpp|sh|json|yaml|yml|toml)$/i.test(name)) return '💻';
    return '📦';
  }
  function isMedia(mt)      { return mt.startsWith('image/') || mt.startsWith('video/') || mt.startsWith('audio/'); }
  function canTranscode(mt) { return mt.startsWith('image/') || mt.startsWith('video/') || mt.startsWith('audio/'); }
  function isText(mt, name) {
    if (!mt) mt = '';
    if (mt.startsWith('text/')) return true;
    if (/^application\/(json|xml|javascript|x-yaml|x-toml|sql|x-sh)/.test(mt)) return true;
    return /\.(txt|md|log|json|yaml|yml|toml|csv|ini|conf|cfg|xml|html|htm|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cc|cs|sh|bash|zsh|sql|env|gitignore|dockerfile|makefile|tf|hcl|nix)$/i.test(name || '');
  }
  function isPdf(mt, name)   { return mt === 'application/pdf' || /\.pdf$/i.test(name || ''); }
  function isOffice(mt, name) {
    return /^application\/(msword|vnd\.openxmlformats|vnd\.ms-|vnd\.oasis)/.test(mt || '') ||
           /\.(doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|rtf)$/i.test(name || '');
  }
  function isPreviewable(mt, name) { return isMedia(mt) || isText(mt, name) || isPdf(mt, name) || isOffice(mt, name); }

  // Forzar descarga sin cambiar la URL (evita que "Atrás" re-dispare la descarga)
  function triggerDownload(url) {
    const a = document.createElement('a');
    a.href = url; a.download = ''; a.style.display = 'none';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  // Path desde el hash de la URL (#foo/bar)
  function getPathFromHash() {
    const h = location.hash.slice(1);
    if (!h) return '';
    return h.split('/').map(s => { try { return decodeURIComponent(s); } catch { return s; } }).join('/');
  }
  function pathToHash(p) {
    if (!p) return '';
    return '#' + p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  }

  function setBrowserStatus(msg, kind) {
    const el = document.getElementById('browser-status');
    el.textContent = msg || '';
    el.style.color = kind === 'ok' ? 'var(--ok)' : kind === 'err' ? 'var(--err)' : 'var(--muted)';
  }

  async function api(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(url, opts);
    if (r.status === 401) { showLogin(); throw new Error('no autenticado'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `http ${r.status}`);
    return j;
  }

  // ── Auth state ─────────────────────────────────────────────────────────
  function showLogin() {
    document.getElementById('firstrun-screen').hidden = true;
    document.getElementById('login-screen').hidden    = false;
    document.getElementById('app-shell').hidden       = true;
    currentUser = null;
  }

  function showFirstRun() {
    document.getElementById('firstrun-screen').hidden = false;
    document.getElementById('login-screen').hidden    = true;
    document.getElementById('app-shell').hidden       = true;
    currentUser = null;
  }

  function showApp(user) {
    currentUser = user;
    document.getElementById('firstrun-screen').hidden = true;
    document.getElementById('login-screen').hidden    = true;
    document.getElementById('app-shell').hidden       = false;

    const label      = document.getElementById('user-name-label');
    const avatar     = document.getElementById('user-avatar');
    const adminBtn   = document.getElementById('admin-btn');
    const settingsBtn = document.getElementById('settings-btn');
    label.textContent  = user.username;
    avatar.textContent = user.username.charAt(0).toUpperCase();
    adminBtn.hidden    = !user.is_admin;
    settingsBtn.hidden = !user.is_admin;
  }

  async function checkAuth() {
    try {
      const cfg = await fetch(`${BASE}/api/config`).then(r => r.json()).catch(() => ({}));
      BASE         = cfg.basePath    || BASE;
      TUS_ENDPOINT = cfg.tusEndpoint || TUS_ENDPOINT;

      const status = await fetch(`${BASE}/api/setup-status`).then(r => r.json()).catch(() => ({}));
      if (status.needs_first_user) { showFirstRun(); return; }

      const me = await fetch(`${BASE}/api/auth/me`).then(r => r.ok ? r.json() : null);
      if (me) { showApp(me); loadBrowse(getPathFromHash(), true); }
      else    { showLogin(); }
    } catch { showLogin(); }
  }

  // ── Primera ejecución ──────────────────────────────────────────────────
  document.getElementById('firstrun-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const username = document.getElementById('fr-user').value.trim();
    const password = document.getElementById('fr-pass').value;
    const errEl    = document.getElementById('firstrun-error');
    const btn      = ev.target.querySelector('button[type=submit]');
    errEl.hidden   = true;
    btn.disabled   = true;
    btn.textContent = 'Creando…';
    try {
      await api('POST', `${BASE}/api/auth/first-setup`, { username, password });
      const me = await api('POST', `${BASE}/api/auth/login`, { username, password });
      showApp(me);
      loadBrowse('', true);
      openSettingsModal();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Crear y entrar';
    }
  });

  // ── Login form ─────────────────────────────────────────────────────────
  document.getElementById('login-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const username = document.getElementById('login-user').value.trim();
    const password = document.getElementById('login-pass').value;
    const errEl    = document.getElementById('login-error');
    const btn      = ev.target.querySelector('button[type=submit]');
    errEl.hidden   = true;
    btn.disabled   = true;
    btn.textContent = 'Entrando…';

    try {
      const r = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Error desconocido');
      showApp(j);
      loadBrowse(getPathFromHash(), true);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Entrar';
    }
  });

  // ── Logout ────────────────────────────────────────────────────────────
  document.getElementById('logout-btn').addEventListener('click', async () => {
    closeDropdown();
    await fetch(`${BASE}/api/auth/logout`, { method: 'POST' });
    document.getElementById('login-pass').value = '';
    showLogin();
  });

  // ── User dropdown ─────────────────────────────────────────────────────
  const userMenuBtn  = document.getElementById('user-menu-btn');
  const userDropdown = document.getElementById('user-dropdown');

  function closeDropdown() { userDropdown.hidden = true; }

  userMenuBtn.addEventListener('click', ev => {
    ev.stopPropagation();
    userDropdown.hidden = !userDropdown.hidden;
  });
  document.addEventListener('click', closeDropdown);
  userDropdown.addEventListener('click', ev => ev.stopPropagation());

  // ── Cambiar contraseña propia ─────────────────────────────────────────
  document.getElementById('change-pass-btn').addEventListener('click', () => {
    closeDropdown();
    openModal('chpass-modal');
  });

  document.getElementById('chpass-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const np   = document.getElementById('chpass-new').value;
    const rp   = document.getElementById('chpass-repeat').value;
    const errEl = document.getElementById('chpass-error');
    errEl.hidden = true;

    if (np !== rp) {
      errEl.textContent = 'Las contraseñas no coinciden.';
      errEl.hidden = false;
      return;
    }
    try {
      await api('POST', `${BASE}/api/users/${currentUser.id}/password`, { password: np });
      closeModal('chpass-modal');
      document.getElementById('chpass-new').value    = '';
      document.getElementById('chpass-repeat').value = '';
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  // ── Settings modal ────────────────────────────────────────────────────
  document.getElementById('settings-btn').addEventListener('click', openSettingsModal);

  async function openSettingsModal() {
    openModal('settings-modal');
    await loadSettings();
  }

  async function loadSettings() {
    try {
      const s = await api('GET', `${BASE}/api/settings`);
      document.getElementById('s-api-id').value      = s.tg_api_id || '';
      document.getElementById('s-api-hash').value    = s.tg_api_hash || '';
      document.getElementById('s-chat').value         = s.tg_chat || '';
      document.getElementById('s-session-ttl').value  = s.session_ttl_days || 30;

      const sessEl = document.getElementById('session-status-text');
      sessEl.textContent = s.tg_session_set ? '✓ Configurada' : 'No configurada';
      sessEl.className   = 'session-status-label ' + (s.tg_session_set ? 'ok' : 'warn');

      updateTgStatusUI(s.tg_status, s.tg_error);

      // Si ya está conectado, cargar la lista de canales automáticamente
      if (s.tg_status === 'connected') {
        try {
          const dialogs = await api('GET', `${BASE}/api/tg/dialogs`);
          if (dialogs?.length) renderChannelPicker(dialogs);
        } catch (_) {}
      }
    } catch (_) {}
  }

  function updateTgStatusUI(status, error) {
    const dot   = document.getElementById('tg-status-dot');
    const text  = document.getElementById('tg-status-text');
    const errEl = document.getElementById('tg-status-error');
    const map = {
      connected:      { cls: 'dot-ok',   label: 'Conectado' },
      connecting:     { cls: 'dot-warn', label: 'Conectando…' },
      not_configured: { cls: 'dot-off',  label: 'No configurado' },
      error:          { cls: 'dot-err',  label: 'Error de conexión' },
    };
    const info = map[status] || { cls: 'dot-off', label: status || '—' };
    dot.className    = 'status-dot ' + info.cls;
    text.textContent = info.label;
    if (error) { errEl.textContent = error; errEl.hidden = false; }
    else        { errEl.hidden = true; }
  }

  document.getElementById('tg-reconnect-btn').addEventListener('click', async () => {
    const btn = document.getElementById('tg-reconnect-btn');
    btn.disabled = true; btn.textContent = 'Reconectando…';
    try {
      const r = await api('POST', `${BASE}/api/tg/reconnect`);
      updateTgStatusUI(r.tg_status, r.tg_error);
    } catch (err) {
      updateTgStatusUI('error', err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Reconectar';
    }
  });

  document.getElementById('settings-save-btn').addEventListener('click', async () => {
    const btn   = document.getElementById('settings-save-btn');
    const msgEl = document.getElementById('settings-save-msg');
    btn.disabled = true;
    msgEl.textContent = 'Guardando…'; msgEl.style.color = 'var(--muted)';
    try {
      const body = {
        tg_api_id:        document.getElementById('s-api-id').value.trim(),
        tg_api_hash:      document.getElementById('s-api-hash').value.trim(),
        tg_chat:          document.getElementById('s-chat').value.trim(),
        session_ttl_days: Number(document.getElementById('s-session-ttl').value) || 30,
      };
      await api('POST', `${BASE}/api/settings`, body);
      msgEl.textContent = '✓ Guardado. Conectando y sincronizando canal…';
      msgEl.style.color = 'var(--ok)';
      // Recargar la vista para reflejar el cambio (los archivos del canal anterior
      // se ocultan por el filtro y los del nuevo canal aparecerán tras la auto-sync).
      setTimeout(() => loadBrowse(''), 1500);
      // Poll status a los 3s para ver si conectó
      setTimeout(async () => {
        try {
          const s = await api('GET', `${BASE}/api/settings`);
          updateTgStatusUI(s.tg_status, s.tg_error);
          if (s.tg_status === 'connected') {
            msgEl.textContent = '✓ Guardado y conectado.';
            setTimeout(() => { msgEl.textContent = ''; }, 3000);
          } else {
            msgEl.textContent = '';
          }
        } catch (_) { msgEl.textContent = ''; }
      }, 3500);
    } catch (err) {
      msgEl.textContent = 'Error: ' + err.message; msgEl.style.color = 'var(--err)';
    } finally {
      btn.disabled = false;
    }
  });

  // ── OTP Wizard ────────────────────────────────────────────────────────
  let otpTempId = null;

  function showOtpStep(n) {
    ['1','2','3','ok'].forEach(s => {
      const el = document.getElementById('otp-step-' + s);
      if (el) el.hidden = (s !== String(n));
    });
    ['otp-step1-err','otp-step2-err','otp-step3-err'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.hidden = true; el.textContent = ''; }
    });
  }

  document.getElementById('tg-auth-btn').addEventListener('click', () => {
    document.getElementById('otp-wizard').hidden = false;
    showOtpStep(1);
  });

  document.getElementById('otp-cancel-btn').addEventListener('click', () => {
    document.getElementById('otp-wizard').hidden = true;
    otpTempId = null;
  });

  document.getElementById('otp-send-btn').addEventListener('click', async () => {
    const phone   = document.getElementById('otp-phone').value.trim();
    const apiId   = document.getElementById('s-api-id').value.trim();
    const apiHash = document.getElementById('s-api-hash').value.trim();
    const errEl   = document.getElementById('otp-step1-err');
    const btn     = document.getElementById('otp-send-btn');
    if (!phone)            { errEl.textContent = 'Ingresa un número de teléfono.'; errEl.hidden = false; return; }
    if (!apiId || !apiHash){ errEl.textContent = 'Rellena API ID y API Hash primero.'; errEl.hidden = false; return; }
    btn.disabled = true; btn.textContent = 'Enviando…';
    try {
      const r = await api('POST', `${BASE}/api/tg/send-code`, { phone, apiId, apiHash });
      otpTempId = r.tempId;
      showOtpStep(2);
    } catch (err) { errEl.textContent = err.message; errEl.hidden = false; }
    finally { btn.disabled = false; btn.textContent = 'Enviar código'; }
  });

  document.getElementById('otp-back-btn').addEventListener('click', () => showOtpStep(1));

  document.getElementById('otp-verify-btn').addEventListener('click', async () => {
    const code  = document.getElementById('otp-code').value.trim();
    const errEl = document.getElementById('otp-step2-err');
    const btn   = document.getElementById('otp-verify-btn');
    if (!code) { errEl.textContent = 'Ingresa el código.'; errEl.hidden = false; return; }
    btn.disabled = true; btn.textContent = 'Verificando…';
    try {
      const r = await api('POST', `${BASE}/api/tg/verify-code`, { tempId: otpTempId, code });
      if (r.needs2fa) { showOtpStep(3); return; }
      showOtpStep('ok');
      otpTempId = null;
      if (r.dialogs?.length) renderChannelPicker(r.dialogs);
      await loadSettings();
    } catch (err) { errEl.textContent = err.message; errEl.hidden = false; }
    finally { btn.disabled = false; btn.textContent = 'Verificar'; }
  });

  document.getElementById('otp-back2-btn').addEventListener('click', () => showOtpStep(2));

  document.getElementById('otp-2fa-btn').addEventListener('click', async () => {
    const pass  = document.getElementById('otp-2fa').value;
    const errEl = document.getElementById('otp-step3-err');
    const btn   = document.getElementById('otp-2fa-btn');
    if (!pass) { errEl.textContent = 'Ingresa la contraseña.'; errEl.hidden = false; return; }
    btn.disabled = true; btn.textContent = 'Verificando…';
    try {
      const r = await api('POST', `${BASE}/api/tg/verify-2fa`, { tempId: otpTempId, password: pass });
      showOtpStep('ok');
      otpTempId = null;
      if (r.dialogs?.length) renderChannelPicker(r.dialogs);
      await loadSettings();
    } catch (err) { errEl.textContent = err.message; errEl.hidden = false; }
    finally { btn.disabled = false; btn.textContent = 'Verificar 2FA'; }
  });

  // ── Channel picker ────────────────────────────────────────────────────
  function renderChannelPicker(dialogs) {
    const picker = document.getElementById('channel-picker');
    const ul     = document.getElementById('channel-list');
    const current = document.getElementById('s-chat').value.trim();

    ul.innerHTML = dialogs.map(d => `
      <li class="channel-item${d.id === current ? ' selected' : ''}" data-id="${esc(d.id)}">
        <span class="channel-badge channel-badge-${d.type}">${d.type}</span>
        <span class="channel-name">${esc(d.name)}</span>
        ${d.username ? `<span class="channel-username">${esc(d.username)}</span>` : ''}
        <code class="channel-id">${esc(d.id)}</code>
      </li>`).join('');

    ul.querySelectorAll('.channel-item').forEach(li => {
      li.addEventListener('click', () => {
        ul.querySelectorAll('.channel-item').forEach(x => x.classList.remove('selected'));
        li.classList.add('selected');
        document.getElementById('s-chat').value = li.dataset.id;
      });
    });
    picker.hidden = false;
  }

  document.getElementById('sync-channel-btn').addEventListener('click', async () => {
    const btn = document.getElementById('sync-channel-btn');
    const msg = document.getElementById('sync-channel-msg');
    btn.disabled = true; btn.textContent = '⟳ Importando…';
    msg.textContent = ''; msg.style.color = 'var(--muted)';
    try {
      const r = await api('POST', `${BASE}/api/tg/sync-channel`, { limit: 2000 });
      msg.textContent = `✓ Importados: ${r.imported} · Ya existían: ${r.skipped}` + (r.errors ? ` · Errores: ${r.errors}` : '');
      msg.style.color = 'var(--ok)';
      loadBrowse(currentPath);
    } catch (err) {
      msg.textContent = 'Error: ' + err.message; msg.style.color = 'var(--err)';
    } finally {
      btn.disabled = false; btn.textContent = '⟳ Importar archivos existentes del canal';
    }
  });

  document.getElementById('refresh-dialogs-btn').addEventListener('click', async () => {
    const btn = document.getElementById('refresh-dialogs-btn');
    btn.disabled = true; btn.textContent = 'Cargando…';
    try {
      const dialogs = await api('GET', `${BASE}/api/tg/dialogs`);
      renderChannelPicker(dialogs);
    } catch (err) {
      alert('No se pudo obtener la lista: ' + err.message);
    } finally {
      btn.disabled = false; btn.textContent = '↻ Actualizar';
    }
  });

  // ── Admin modal ────────────────────────────────────────────────────────
  document.getElementById('admin-btn').addEventListener('click', async () => {
    openModal('admin-modal');
    await loadUserList();
  });

  async function loadUserList() {
    const ul = document.getElementById('user-list');
    ul.innerHTML = '<li class="user-row muted">Cargando…</li>';
    try {
      const users = await api('GET', `${BASE}/api/users`);
      if (!users.length) { ul.innerHTML = '<li class="user-row muted">Sin usuarios.</li>'; return; }
      ul.innerHTML = users.map(u => `
        <li class="user-row">
          <span class="user-row-avatar">${esc(u.username.charAt(0).toUpperCase())}</span>
          <span class="user-row-name">${esc(u.username)}</span>
          ${u.is_admin ? '<span class="badge-admin">admin</span>' : ''}
          ${u.id !== currentUser?.id
            ? `<button class="iconbtn user-delete-btn" data-id="${u.id}" data-name="${esc(u.username)}" title="Eliminar">🗑</button>`
            : '<span class="badge-you">tú</span>'}
        </li>`).join('');
      ul.querySelectorAll('.user-delete-btn').forEach(btn => btn.addEventListener('click', async () => {
        if (!confirm(`¿Eliminar usuario "${btn.dataset.name}"?`)) return;
        try {
          await api('DELETE', `${BASE}/api/users/${btn.dataset.id}`);
          await loadUserList();
        } catch (err) { alert(err.message); }
      }));
    } catch (err) {
      ul.innerHTML = `<li class="user-row err">${esc(err.message)}</li>`;
    }
  }

  document.getElementById('new-user-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const username = document.getElementById('nu-username').value.trim();
    const password = document.getElementById('nu-password').value;
    const is_admin = document.getElementById('nu-admin').checked;
    const errEl    = document.getElementById('nu-error');
    errEl.hidden   = true;
    try {
      await api('POST', `${BASE}/api/users`, { username, password, is_admin });
      ev.target.reset();
      await loadUserList();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  // ── Modal helpers ─────────────────────────────────────────────────────
  function openModal(id) {
    const m = document.getElementById(id);
    m.hidden = false;
    m.setAttribute('aria-hidden', 'false');
  }
  function closeModal(id) {
    const m = document.getElementById(id);
    m.hidden = true;
    m.setAttribute('aria-hidden', 'true');
  }
  document.querySelectorAll('[data-close]').forEach(el => {
    el.addEventListener('click', () => {
      const m = el.closest('.modal');
      if (m) { m.hidden = true; m.setAttribute('aria-hidden', 'true'); }
    });
  });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') {
      document.querySelectorAll('.modal:not([hidden])').forEach(m => {
        m.hidden = true; m.setAttribute('aria-hidden', 'true');
        if (m.id === 'preview-modal') document.getElementById('preview-body').innerHTML = '';
      });
    }
  });

  // ── Selección múltiple ─────────────────────────────────────────────────
  const selected = new Set();
  let currentEntries = [];

  function renderBulkBar() {
    const bar    = document.getElementById('bulk-bar');
    const count  = document.getElementById('bulk-count');
    const allCb  = document.getElementById('select-all');
    const lbl    = document.getElementById('select-all-label');
    const delBtn = document.getElementById('bulk-delete');
    const zipBtn = document.getElementById('bulk-zip');
    const total  = currentEntries.length;
    const sel    = selected.size;
    bar.hidden = total === 0;
    count.textContent  = sel === 0 ? '0 seleccionados' : sel === 1 ? '1 seleccionado' : `${sel} seleccionados`;
    allCb.checked      = total > 0 && sel === total;
    allCb.indeterminate = sel > 0 && sel < total;
    lbl.textContent    = (sel === total && total > 0) ? 'Deseleccionar todo' : 'Seleccionar todo';
    delBtn.disabled    = sel === 0;
    zipBtn.disabled    = sel === 0;
  }

  document.getElementById('select-all').addEventListener('change', () => {
    const cb = document.getElementById('select-all');
    document.querySelectorAll('.row-check').forEach(c => {
      c.checked = cb.checked;
      const li  = c.closest('li');
      const key = li.dataset.key;
      if (cb.checked) selected.add(key); else selected.delete(key);
      li.classList.toggle('is-selected', cb.checked);
    });
    renderBulkBar();
  });

  // ── Breadcrumb ─────────────────────────────────────────────────────────
  function renderCrumbs(p, crumbs) {
    const parts = p ? p.split('/').filter(Boolean) : [];
    const el    = document.getElementById('crumbs');
    const html  = ['<button class="crumb" data-go="" data-fid="">/ raíz</button>'];
    let acc = '';
    parts.forEach((part, i) => {
      acc = acc ? acc + '/' + part : part;
      const fid = crumbs?.[i]?.id ?? '';
      html.push('<span class="sep">›</span>');
      if (i === parts.length - 1) html.push(`<span class="current">${esc(part)}</span>`);
      else html.push(`<button class="crumb" data-go="${esc(acc)}" data-fid="${fid}">${esc(part)}</button>`);
    });
    el.innerHTML = html.join('');
    el.querySelectorAll('.crumb').forEach(b => {
      b.addEventListener('click', () => loadBrowse(b.dataset.go));
      // Aceptar drops para mover al padre
      b.addEventListener('dragenter', ev => {
        if (ev.dataTransfer.types.includes('application/x-cloud-item')) {
          ev.preventDefault(); b.classList.add('drop-target');
        }
      });
      b.addEventListener('dragover', ev => {
        if (ev.dataTransfer.types.includes('application/x-cloud-item')) {
          ev.preventDefault(); ev.dataTransfer.dropEffect = 'move';
        }
      });
      b.addEventListener('dragleave', () => b.classList.remove('drop-target'));
      b.addEventListener('drop', async ev => {
        if (!ev.dataTransfer.types.includes('application/x-cloud-item')) return;
        ev.preventDefault();
        b.classList.remove('drop-target');
        let item;
        try { item = JSON.parse(ev.dataTransfer.getData('application/x-cloud-item')); } catch { return; }
        const targetFid = b.dataset.fid === '' ? null : Number(b.dataset.fid);
        if (item.type === 'dir' && item.id === targetFid) return;
        await moveItem(item, targetFid);
      });
    });
  }

  // ── Lista de archivos ──────────────────────────────────────────────────
  async function loadBrowse(p, fromHistory = false) {
    currentPath = p || '';
    if (!fromHistory) {
      const newHash = pathToHash(currentPath);
      if (location.hash !== newHash) {
        history.pushState({ path: currentPath }, '', location.pathname + (newHash || ''));
      }
    }
    selected.clear();
    renderBulkBar();
    setBrowserStatus('Cargando…');
    document.getElementById('file-list').innerHTML = '<li class="empty muted">Cargando…</li>';

    let data;
    try {
      data = await api('GET', `${BASE}/api/browse?path=${encodeURIComponent(currentPath)}`);
    } catch (err) {
      document.getElementById('file-list').innerHTML = `<li class="empty">Error: ${esc(err.message)}</li>`;
      setBrowserStatus(''); currentEntries = []; renderBulkBar();
      renderCrumbs(currentPath, []); return;
    }
    renderCrumbs(currentPath, data.crumbs || []);
    window.__currentFolderId = data.folder_id ?? null;

    currentEntries = [
      ...data.dirs.map(d => ({ type: 'dir',  ...d })),
      ...data.files.map(f => ({ type: 'file', ...f })),
    ];

    if (!currentEntries.length) {
      document.getElementById('file-list').innerHTML = '<li class="empty muted">Carpeta vacía — sube algo o crea una subcarpeta.</li>';
    } else {
      document.getElementById('file-list').innerHTML = currentEntries.map(renderRow).join('');
      bindRowEvents();
    }
    setBrowserStatus(`${data.dirs.length} carpeta(s) · ${data.files.length} archivo(s)`);
    renderBulkBar();
  }

  function renderRow(e) {
    const key = `${e.type[0]}:${e.id}`;
    if (e.type === 'dir') {
      return `<li class="row" data-type="dir" data-id="${e.id}" data-key="${key}" data-name="${esc(e.name)}">
        <input type="checkbox" class="row-check" />
        <span class="row-icon">📁</span>
        <div class="row-main">
          <div class="row-name">${esc(e.name)}</div>
          <div class="row-sub">${fmtDate(e.created_at)}</div>
        </div>
        <span class="row-meta">carpeta</span>
        <span class="row-actions">
          <button class="iconbtn" data-act="zip"    title="Descargar ZIP">🗜️</button>
          <button class="iconbtn" data-act="rename" title="Renombrar">✎</button>
          <button class="iconbtn" data-act="delete" title="Eliminar">🗑</button>
        </span>
      </li>`;
    }
    const fallback = esc(fileIcon(e.mime_type, e.name));
    const thumbHtml = `<img class="row-thumb" src="${BASE}/api/thumb?id=${e.id}" alt="" loading="lazy"
        onerror="this.onerror=null;this.outerHTML='<span class=\\'row-icon\\'>${fallback}</span>'" />`;
    return `<li class="row" data-type="file" data-id="${e.id}" data-key="${key}"
               data-name="${esc(e.name)}" data-mime="${esc(e.mime_type)}" data-size="${e.size}">
      <input type="checkbox" class="row-check" />
      ${thumbHtml}
      <div class="row-main">
        <div class="row-name">${esc(e.name)}</div>
        <div class="row-sub">${fmtDate(e.created_at)}${e.chunk_count > 1 ? ` · ${e.chunk_count} partes` : ''}</div>
      </div>
      <span class="row-meta">${fmtSize(e.size)}</span>
      <span class="row-actions">
        <button class="iconbtn" data-act="download"      title="Descargar original">⬇</button>
        ${canTranscode(e.mime_type) ? `<button class="iconbtn" data-act="download-lite" title="Versión ligera">⬇↓</button>` : ''}
        <button class="iconbtn" data-act="rename"        title="Renombrar">✎</button>
        <button class="iconbtn" data-act="delete"        title="Eliminar">🗑</button>
      </span>
    </li>`;
  }

  function bindRowEvents() {
    document.querySelectorAll('#file-list .row').forEach(li => {
      const type  = li.dataset.type;
      const id    = Number(li.dataset.id);
      const name  = li.dataset.name;
      const mime_t = li.dataset.mime || '';
      const key   = li.dataset.key;
      const cb    = li.querySelector('.row-check');

      cb?.addEventListener('click', ev => ev.stopPropagation());
      cb?.addEventListener('change', () => {
        if (cb.checked) selected.add(key); else selected.delete(key);
        li.classList.toggle('is-selected', cb.checked);
        renderBulkBar();
      });

      li.addEventListener('click', ev => {
        if (ev.target.closest('.row-actions, .row-check')) return;
        if (type === 'dir') loadBrowse(currentPath ? `${currentPath}/${name}` : name);
        else                openPreview(id, name, mime_t, Number(li.dataset.size));
      });

      // Drag-and-drop: arrastrar para mover
      li.draggable = true;
      li.addEventListener('dragstart', ev => {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('application/x-cloud-item', JSON.stringify({ type, id, name }));
        ev.dataTransfer.setData('text/plain', name);
        li.classList.add('dragging');
      });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));

      // Solo carpetas aceptan drops
      if (type === 'dir') {
        li.addEventListener('dragenter', ev => {
          if (ev.dataTransfer.types.includes('application/x-cloud-item')) {
            ev.preventDefault(); li.classList.add('drop-target');
          }
        });
        li.addEventListener('dragover', ev => {
          if (ev.dataTransfer.types.includes('application/x-cloud-item')) {
            ev.preventDefault(); ev.dataTransfer.dropEffect = 'move';
          }
        });
        li.addEventListener('dragleave', ev => {
          if (!li.contains(ev.relatedTarget)) li.classList.remove('drop-target');
        });
        li.addEventListener('drop', async ev => {
          if (!ev.dataTransfer.types.includes('application/x-cloud-item')) return;
          ev.preventDefault(); ev.stopPropagation();
          li.classList.remove('drop-target');
          let item;
          try { item = JSON.parse(ev.dataTransfer.getData('application/x-cloud-item')); } catch { return; }
          if (item.type === 'dir' && item.id === id) return;
          await moveItem(item, id);
        });
      }

      li.querySelectorAll('.iconbtn').forEach(btn => btn.addEventListener('click', ev => {
        ev.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'preview')            openPreview(id, name, mime_t, Number(li.dataset.size));
        else if (act === 'download')      triggerDownload(`${BASE}/api/stream?id=${id}&inline=0`);
        else if (act === 'download-lite') triggerDownload(`${BASE}/api/transcode?id=${id}`);
        else if (act === 'zip')           triggerDownload(`${BASE}/api/zip?id=${id}`);
        else if (act === 'rename')        promptRename(type, id, name);
        else if (act === 'delete')        confirmDelete([{ type, id, name }]);
      }));
    });
  }

  async function moveItem(item, targetFolderId) {
    setBrowserStatus(`Moviendo "${item.name}"…`);
    try {
      await api('POST', `${BASE}/api/move`, { type: item.type, id: item.id, targetFolderId });
      setBrowserStatus('✓ Movido.', 'ok');
      loadBrowse(currentPath);
    } catch (err) { setBrowserStatus('Error: ' + err.message, 'err'); }
  }

  // ── Preview ───────────────────────────────────────────────────────────
  let currentPreview = null;

  function openPreview(id, name, mimeType, size) {
    currentPreview = { id, name, mimeType, size };
    const body = document.getElementById('preview-body');
    document.getElementById('preview-name').textContent = name;
    document.getElementById('preview-meta').textContent = fmtSize(size);
    document.getElementById('preview-download').onclick      = () => triggerDownload(`${BASE}/api/stream?id=${id}&inline=0`);
    document.getElementById('preview-download-lite').hidden  = !canTranscode(mimeType);
    document.getElementById('preview-download-lite').onclick = () => triggerDownload(`${BASE}/api/transcode?id=${id}`);

    const src = `${BASE}/api/stream?id=${id}&inline=1`;
    if (mimeType.startsWith('image/')) {
      body.innerHTML = `<img src="${esc(src)}" alt="${esc(name)}" />`;
    } else if (mimeType.startsWith('video/')) {
      body.innerHTML = `<video controls autoplay src="${esc(src)}"></video>`;
    } else if (mimeType.startsWith('audio/')) {
      body.innerHTML = `<div class="preview-file-info">
        <div class="preview-file-icon">🎵</div>
        <div class="preview-file-name">${esc(name)}</div>
        <div class="preview-file-size">${fmtSize(size)}</div>
        <audio controls autoplay src="${esc(src)}" style="margin-top:16px;width:100%"></audio>
      </div>`;
    } else if (isPdf(mimeType, name)) {
      body.innerHTML = `<embed src="${esc(src)}" type="application/pdf" />`;
    } else if (isText(mimeType, name)) {
      body.innerHTML = `<pre class="preview-text muted">Cargando…</pre>`;
      const MAX = 500_000;
      fetch(src, { headers: { Range: `bytes=0-${MAX - 1}` } })
        .then(r => r.text())
        .then(text => {
          const truncated = size > MAX;
          body.innerHTML = `<pre class="preview-text">${esc(text)}</pre>` +
            (truncated ? `<div class="preview-truncated muted small">Mostrando los primeros ${fmtSize(MAX)} de ${fmtSize(size)}</div>` : '');
        })
        .catch(err => { body.innerHTML = `<pre class="preview-text">Error: ${esc(err.message)}</pre>`; });
    } else if (isOffice(mimeType, name)) {
      body.innerHTML = `<div class="preview-file-info">
        <div class="preview-file-icon">${fileIcon(mimeType, name)}</div>
        <div class="preview-file-name">${esc(name)}</div>
        <div class="preview-file-size">${fmtSize(size)}</div>
        <p class="muted small" style="margin-top:14px;max-width:380px;line-height:1.5">
          El navegador no puede mostrar este formato directamente. Descarga el archivo para abrirlo en tu editor.
        </p>
      </div>`;
    } else {
      body.innerHTML = `<div class="preview-file-info">
        <div class="preview-file-icon">${fileIcon(mimeType, name)}</div>
        <div class="preview-file-name">${esc(name)}</div>
        <div class="preview-file-size">${fmtSize(size)}</div>
      </div>`;
    }
    openModal('preview-modal');
  }

  // Acciones admin desde el preview
  document.getElementById('preview-rename').addEventListener('click', async () => {
    if (!currentPreview) return;
    const newName = prompt(`Nuevo nombre para "${currentPreview.name}":`, currentPreview.name);
    if (!newName || newName === currentPreview.name) return;
    try {
      await api('POST', `${BASE}/api/rename`, { type: 'file', id: currentPreview.id, newName });
      closeModal('preview-modal');
      loadBrowse(currentPath);
    } catch (err) { alert('Error: ' + err.message); }
  });

  document.getElementById('preview-delete').addEventListener('click', async () => {
    if (!currentPreview) return;
    if (!confirm(`¿Eliminar "${currentPreview.name}"? NO se puede deshacer.`)) return;
    try {
      await api('POST', `${BASE}/api/delete`, { items: [{ type: 'file', id: currentPreview.id, name: currentPreview.name }] });
      closeModal('preview-modal');
      loadBrowse(currentPath);
    } catch (err) { alert('Error: ' + err.message); }
  });

  // ── Nueva carpeta ──────────────────────────────────────────────────────
  document.getElementById('mkdir-btn').addEventListener('click', async () => {
    const name = prompt('Nombre de la nueva carpeta:');
    if (!name?.trim()) return;
    setBrowserStatus('Creando…');
    try {
      await api('POST', `${BASE}/api/mkdir`, { parent: currentPath, name: name.trim() });
      setBrowserStatus('✓ Carpeta creada.', 'ok');
      loadBrowse(currentPath);
    } catch (err) { setBrowserStatus('Error: ' + err.message, 'err'); }
  });

  // ── Renombrar ──────────────────────────────────────────────────────────
  async function promptRename(type, id, oldName) {
    const newName = prompt(`Nuevo nombre para "${oldName}":`, oldName);
    if (!newName || newName === oldName) return;
    setBrowserStatus('Renombrando…');
    try {
      await api('POST', `${BASE}/api/rename`, { type, id, newName });
      setBrowserStatus('✓ Renombrado.', 'ok'); loadBrowse(currentPath);
    } catch (err) { setBrowserStatus('Error: ' + err.message, 'err'); }
  }

  // ── Eliminar ───────────────────────────────────────────────────────────
  async function confirmDelete(items) {
    const names = items.map(i => '· ' + i.name).join('\n');
    if (!confirm(`¿Eliminar ${items.length} elemento(s)? NO se puede deshacer.\n\n${names}`)) return;
    setBrowserStatus(`Eliminando ${items.length}…`);
    try {
      const r = await api('POST', `${BASE}/api/delete`, { items });
      const fails = (r.results || []).filter(x => !x.ok);
      setBrowserStatus(fails.length === 0 ? `✓ ${items.length} eliminado(s).` : `Fallidos: ${fails.length}`, fails.length ? 'err' : 'ok');
      selected.clear(); loadBrowse(currentPath);
    } catch (err) { setBrowserStatus('Error: ' + err.message, 'err'); }
  }

  // ── Bulk ───────────────────────────────────────────────────────────────
  document.getElementById('bulk-delete').addEventListener('click', () => {
    if (!selected.size) return;
    const items = Array.from(selected).map(key => {
      const [type, id] = key.split(':');
      return { type, id: Number(id), name: document.querySelector(`[data-key="${key}"]`)?.dataset.name || key };
    });
    confirmDelete(items);
  });
  document.getElementById('bulk-zip').addEventListener('click', () => {
    if (selected.size !== 1) { setBrowserStatus('Selecciona una sola carpeta.', 'err'); return; }
    const key = Array.from(selected)[0];
    if (!key.startsWith('d:')) { setBrowserStatus('ZIP solo disponible para carpetas.', 'err'); return; }
    triggerDownload(`${BASE}/api/zip?id=${key.split(':')[1]}`);
  });

  // ── Botones de navegación ─────────────────────────────────────────────
  document.getElementById('nav-back').addEventListener('click', () => history.back());
  document.getElementById('nav-fwd').addEventListener('click',  () => history.forward());
  document.getElementById('nav-home').addEventListener('click', () => loadBrowse(''));

  // ── Historial del navegador ───────────────────────────────────────────
  window.addEventListener('popstate', ev => {
    if (document.getElementById('app-shell').hidden) return;
    const path = ev.state?.path ?? getPathFromHash();
    loadBrowse(path, true);
  });

  // ── Drag & drop en el browser ─────────────────────────────────────────
  const browser    = document.getElementById('browser');
  const dropOverlay = document.getElementById('drop-overlay');
  let hideTimer = null;
  const hideDrop = () => { dropOverlay.hidden = true; clearTimeout(hideTimer); };
  const showDrop = () => { dropOverlay.hidden = false; clearTimeout(hideTimer); hideTimer = setTimeout(hideDrop, 1500); };

  browser.addEventListener('dragenter', ev => { if (hasDragFiles(ev)) { ev.preventDefault(); showDrop(); } });
  browser.addEventListener('dragover',  ev => { if (hasDragFiles(ev)) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; clearTimeout(hideTimer); hideTimer = setTimeout(hideDrop, 1500); } });
  browser.addEventListener('drop', async ev => {
    if (!hasDragFiles(ev)) return;
    ev.preventDefault(); hideDrop();
    const files = await collectDropFiles(ev);
    if (files.length) openUploadModal(files);
  });
  window.addEventListener('dragend', hideDrop);
  window.addEventListener('blur', hideDrop);
  function hasDragFiles(ev) { return Array.from(ev.dataTransfer?.types || []).includes('Files'); }

  async function collectDropFiles(ev) {
    const out = [], promises = [];
    for (const item of Array.from(ev.dataTransfer.items || [])) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry) promises.push(readEntry(entry, out, ''));
      else { const f = item.getAsFile(); if (f) out.push({ file: f, rel: f.name }); }
    }
    await Promise.all(promises);
    return out;
  }
  function readEntry(entry, out, prefix) {
    return new Promise(resolve => {
      if (entry.isFile) {
        entry.file(f => { out.push({ file: f, rel: prefix + entry.name }); resolve(); }, resolve);
      } else if (entry.isDirectory) {
        const reader = entry.createReader(), all = [];
        const readBatch = () => {
          reader.readEntries(async entries => {
            if (!entries.length) { await Promise.all(all.map(e => readEntry(e, out, prefix + entry.name + '/'))); resolve(); return; }
            all.push(...entries); readBatch();
          }, resolve);
        };
        readBatch();
      } else resolve();
    });
  }

  // ── Upload modal ───────────────────────────────────────────────────────
  let uploadQueue = [];

  document.getElementById('upload-btn').addEventListener('click', () => openUploadModal([]));
  document.getElementById('pick-files-btn').addEventListener('click',  () => { const i = document.getElementById('file-input');   i.value = ''; i.click(); });
  document.getElementById('pick-folder-btn').addEventListener('click', () => { const i = document.getElementById('folder-input'); i.value = ''; i.click(); });
  document.getElementById('file-input').addEventListener('change',   ev => addToQueue(Array.from(ev.target.files || []).map(f => ({ file: f, rel: f.name }))));
  document.getElementById('folder-input').addEventListener('change', ev => addToQueue(Array.from(ev.target.files || []).map(f => ({ file: f, rel: f.webkitRelativePath || f.name }))));

  const dropZone = document.getElementById('drop-zone');
  dropZone.addEventListener('dragover',  ev => { ev.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', async ev => {
    ev.preventDefault(); dropZone.classList.remove('drag-over');
    addToQueue(await collectDropFiles(ev));
  });
  dropZone.addEventListener('click', () => document.getElementById('file-input').click());

  function openUploadModal(files) {
    openModal('upload-modal');
    document.getElementById('upload-status').textContent = '';
    if (files.length) addToQueue(files);
  }

  function closeUploadModal() {
    closeModal('upload-modal');
    uploadQueue = [];
    renderQueue();
  }
  // El [data-close] del modal de upload ya está manejado por el listener genérico

  function addToQueue(files) {
    for (const { file, rel } of files) uploadQueue.push({ file, rel, status: 'pending', progress: 0 });
    renderQueue();
  }

  function renderQueue() {
    const ul       = document.getElementById('upload-queue');
    const startBtn = document.getElementById('start-upload-btn');
    startBtn.disabled = !uploadQueue.some(i => i.status === 'pending');
    if (!uploadQueue.length) { ul.innerHTML = ''; return; }
    ul.innerHTML = uploadQueue.map((item, idx) => {
      const statusIcon =
        item.status === 'ok'   ? '<span class="q-status ok">✓</span>'  :
        item.status === 'err'  ? '<span class="q-status err">✗</span>' :
        item.status === 'busy' ? '<span class="q-status busy">⟳</span>' : '';
      const progress = item.status === 'busy'
        ? `<div class="upload-progress"><div class="upload-progress-bar" id="pb-${idx}" style="width:${item.progress}%"></div></div>`
        : '';
      return `<li>${statusIcon}<div class="row-main"><div class="q-name" title="${esc(item.rel)}">${esc(item.file.name)}</div>${progress}</div><span class="q-size">${fmtSize(item.file.size)}</span></li>`;
    }).join('');
  }

  document.getElementById('start-upload-btn').addEventListener('click', startUploads);

  async function startUploads() {
    const pending = uploadQueue.filter(i => i.status === 'pending');
    if (!pending.length) return;
    document.getElementById('start-upload-btn').disabled = true;
    const statusEl = document.getElementById('upload-status');
    statusEl.style.color = 'var(--muted)';
    statusEl.textContent = `Subiendo ${pending.length} archivo(s)…`;

    let ok = 0, fail = 0;
    for (const item of pending) {
      item.status = 'busy'; renderQueue();
      try { await tusUpload(item); item.status = 'ok'; ok++; }
      catch (err) { item.status = 'err'; item.error = err.message; fail++; }
      renderQueue();
    }
    statusEl.textContent = fail === 0 ? `✓ ${ok} archivo(s) subido(s).` : `${ok} ok · ${fail} fallido(s).`;
    statusEl.style.color = fail === 0 ? 'var(--ok)' : 'var(--err)';
    document.getElementById('start-upload-btn').disabled = false;
    loadBrowse(currentPath);
  }

  function tusUpload(item) {
    return new Promise((resolve, reject) => {
      const fileSize  = item.file.size;
      const chunkSize = 8 * 1024 * 1024;
      let offset = 0, tusUrl = '';

      function createUpload() {
        const req = new XMLHttpRequest();
        req.open('POST', TUS_ENDPOINT);
        req.setRequestHeader('Tus-Resumable', '1.0.0');
        req.setRequestHeader('Upload-Length', String(fileSize));
        req.setRequestHeader('Upload-Metadata',
          `filename ${btoa(unescape(encodeURIComponent(item.file.name)))},type ${btoa(item.file.type || 'application/octet-stream')},folder ${btoa(unescape(encodeURIComponent(currentPath)))}`
        );
        req.onload = () => {
          if (req.status === 201) { tusUrl = req.getResponseHeader('Location'); uploadChunk(); }
          else reject(new Error(`TUS create: ${req.status}`));
        };
        req.onerror = () => reject(new Error('Error de red al crear upload'));
        req.send(null);
      }

      function uploadChunk() {
        if (offset >= fileSize) { resolve(); return; }
        const end   = Math.min(offset + chunkSize, fileSize);
        const slice = item.file.slice(offset, end);
        const req   = new XMLHttpRequest();
        req.open('PATCH', tusUrl);
        req.setRequestHeader('Tus-Resumable', '1.0.0');
        req.setRequestHeader('Content-Type', 'application/offset+octet-stream');
        req.setRequestHeader('Upload-Offset', String(offset));
        req.upload.onprogress = ev => {
          if (ev.lengthComputable) {
            item.progress = Math.round(((offset + ev.loaded) / fileSize) * 100);
            const bar = document.getElementById(`pb-${uploadQueue.indexOf(item)}`);
            if (bar) bar.style.width = item.progress + '%';
          }
        };
        req.onload = () => {
          if (req.status === 204 || req.status === 200) { offset = end; uploadChunk(); }
          else reject(new Error(`TUS patch: ${req.status}`));
        };
        req.onerror = () => reject(new Error('Error de red al subir chunk'));
        req.send(slice);
      }
      createUpload();
    });
  }

  // ── Inicio ────────────────────────────────────────────────────────────
  checkAuth();
})();

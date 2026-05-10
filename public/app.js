(function () {
  'use strict';

  let BASE         = '/cloud';
  let TUS_ENDPOINT = '/cloud/files';
  let currentPath  = '';
  let currentUser  = null; // { id, phone, has_chat, tg_chat, tg_status }

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
  function fileIcon(mt, name) {
    if (!mt) mt = '';
    if (mt.startsWith('image/')) return '🖼️';
    if (mt.startsWith('video/')) return '🎬';
    if (mt.startsWith('audio/')) return '🎵';
    if (mt.includes('pdf'))      return '📕';
    if (mt.includes('zip') || mt.includes('tar') || mt.includes('compress')) return '🗜️';
    if (mt.includes('text') || /\.(txt|md|log)$/i.test(name)) return '📄';
    if (/\.(js|ts|py|go|rs|java|c|cpp|sh|json|yaml|yml|toml)$/i.test(name)) return '💻';
    return '📦';
  }
  function isMedia(mt)      { return mt.startsWith('image/') || mt.startsWith('video/') || mt.startsWith('audio/'); }
  function canTranscode(mt) { return mt.startsWith('image/') || mt.startsWith('video/') || mt.startsWith('audio/'); }
  function isPdf(mt, name)  { return mt === 'application/pdf' || /\.pdf$/i.test(name || ''); }
  function isOffice(mt, name) {
    return /^application\/(msword|vnd\.openxmlformats|vnd\.ms-|vnd\.oasis)/.test(mt || '') ||
           /\.(doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|rtf)$/i.test(name || '');
  }
  function isText(mt, name) {
    if (!mt) mt = '';
    if (mt.startsWith('text/')) return true;
    if (/^application\/(json|xml|javascript|x-yaml|x-toml|sql|x-sh)/.test(mt)) return true;
    return /\.(txt|md|log|json|yaml|yml|toml|csv|ini|conf|cfg|xml|html|htm|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cc|cs|sh|bash|zsh|sql|env|gitignore|dockerfile|makefile|tf|hcl|nix)$/i.test(name || '');
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
    if (r.status === 401) { showWizard(); throw new Error('no autenticado'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `http ${r.status}`);
    return j;
  }

  function triggerDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url; a.style.display = 'none';
    if (filename) a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  function getPathFromHash() {
    const h = location.hash.slice(1);
    if (!h) return '';
    return h.split('/').map(s => { try { return decodeURIComponent(s); } catch { return s; } }).join('/');
  }
  function pathToHash(p) {
    if (!p) return '';
    return '#' + p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  }

  // ═════════════════════════════════════════════════════════════════════════
  // WIZARD
  // ═════════════════════════════════════════════════════════════════════════
  const WIZ = (() => {
    let phone = '', apiId = '', apiHash = '', tempId = '';
    let isNewUser = false; // determinado tras check-phone

    function showStep(name) {
      document.querySelectorAll('#wizard-screen .wiz-step').forEach(s => {
        s.hidden = s.dataset.step !== name;
      });
      const labels = { phone: '1 — teléfono', api: '2 — credenciales', code: 'código', '2fa': 'verificación 2FA', chat: 'canal', sync: 'sincronizando' };
      const el = document.getElementById('wiz-progress');
      if (el) el.textContent = name === 'sync' ? '' : `Paso ${labels[name] || ''}`;
    }

    function setErr(stepKey, msg) {
      const el = document.getElementById({ phone:'wp-err', api:'wa-err', code:'wc-err', '2fa':'wt-err', chat:'wch-err' }[stepKey]);
      if (!el) return;
      if (msg) { el.textContent = msg; el.hidden = false; }
      else     { el.hidden = true; }
    }

    // Paso 1: teléfono → check-phone → API (si nuevo) o send-code (si vuelve)
    document.getElementById('wp-next').addEventListener('click', async () => {
      setErr('phone', '');
      const v = document.getElementById('wp-phone').value.trim();
      if (!/^\+?\d{6,}$/.test(v)) { setErr('phone', 'Número inválido. Usa formato +34612345678'); return; }
      phone = v;
      const btn = document.getElementById('wp-next');
      btn.disabled = true; btn.textContent = 'Verificando…';
      try {
        const r = await fetch(`${BASE}/api/auth/check-phone`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ phone })
        }).then(x => x.json());
        if (r.exists && r.has_credentials) {
          // Usuario que vuelve — el server usa sus credenciales guardadas
          isNewUser = false;
          await sendCode();
        } else {
          // Nuevo o sin credenciales — pedirlas
          isNewUser = true;
          showStep('api');
        }
      } catch (err) {
        setErr('phone', err.message);
      } finally {
        btn.disabled = false; btn.textContent = 'Continuar →';
      }
    });

    // Paso 2 (solo nuevos): API ID + Hash → enviar código
    document.getElementById('wa-next').addEventListener('click', async () => {
      setErr('api', '');
      const id = document.getElementById('wa-id').value.trim();
      const h  = document.getElementById('wa-hash').value.trim();
      if (!id || isNaN(parseInt(id, 10))) { setErr('api', 'API ID inválido — debe ser un número'); return; }
      if (!/^[0-9a-f]{32}$/i.test(h))     { setErr('api', 'API Hash inválido — 32 caracteres hexadecimales'); return; }
      apiId = id; apiHash = h;
      try { await sendCode(); }
      catch { /* error ya mostrado */ }
    });

    async function sendCode() {
      const wpBtn = document.getElementById('wp-next');
      const waBtn = document.getElementById('wa-next');
      if (wpBtn) { wpBtn.disabled = true; }
      if (waBtn) { waBtn.disabled = true; waBtn.textContent = 'Enviando…'; }
      try {
        const body = { phone };
        if (isNewUser && apiId && apiHash) { body.apiId = apiId; body.apiHash = apiHash; }
        const r = await fetch(`${BASE}/api/auth/send-code`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify(body)
        }).then(x => x.json());
        if (!r.ok) throw new Error(r.error || 'Error');
        tempId = r.tempId;
        showStep('code');
      } catch (err) {
        setErr(isNewUser ? 'api' : 'phone', err.message);
        throw err;
      } finally {
        if (wpBtn) { wpBtn.disabled = false; }
        if (waBtn) { waBtn.disabled = false; waBtn.textContent = 'Enviar código →'; }
      }
    }

    // Paso código
    document.getElementById('wc-next').addEventListener('click', async () => {
      setErr('code', '');
      const code = document.getElementById('wc-code').value.replace(/\s/g, '');
      if (!code) { setErr('code', 'Falta código'); return; }
      const btn = document.getElementById('wc-next');
      btn.disabled = true; btn.textContent = 'Verificando…';
      try {
        const r = await fetch(`${BASE}/api/auth/verify-code`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ tempId, code })
        }).then(x => x.json());
        if (r.needs2fa) { showStep('2fa'); return; }
        if (!r.ok) throw new Error(r.error || 'Error');
        await afterAuth(r.has_chat);
      } catch (err) {
        setErr('code', err.message);
      } finally {
        btn.disabled = false; btn.textContent = 'Verificar →';
      }
    });

    // Paso 2FA
    document.getElementById('wt-next').addEventListener('click', async () => {
      setErr('2fa', '');
      const password = document.getElementById('wt-pass').value;
      if (!password) { setErr('2fa', 'Falta contraseña'); return; }
      const btn = document.getElementById('wt-next');
      btn.disabled = true; btn.textContent = 'Verificando…';
      try {
        const r = await fetch(`${BASE}/api/auth/verify-2fa`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ tempId, password })
        }).then(x => x.json());
        if (!r.ok) throw new Error(r.error || 'Error');
        await afterAuth(r.has_chat);
      } catch (err) {
        setErr('2fa', err.message);
      } finally {
        btn.disabled = false; btn.textContent = 'Verificar →';
      }
    });

    async function afterAuth(hasChat) {
      // Auth completado, sesión cookie creada
      currentUser = await fetch(`${BASE}/api/auth/me`).then(r => r.json());
      if (hasChat) {
        showStep('sync');
        startSyncMonitor(true);
      } else {
        showStep('chat');
        await loadDialogsForWizard();
      }
    }

    // Tabs select / create canal
    document.querySelectorAll('#wizard-screen .chat-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const wrap = tab.closest('.wiz-step');
        wrap.querySelectorAll('.chat-tab').forEach(t => t.classList.toggle('active', t === tab));
        wrap.querySelectorAll('.chat-pane').forEach(p => p.hidden = p.dataset.pane !== tab.dataset.tab);
      });
    });

    let selectedChatId = null;

    async function loadDialogsForWizard() {
      const ul = document.getElementById('wch-list');
      ul.innerHTML = '<li class="muted small">Cargando lista…</li>';
      try {
        const list = await fetch(`${BASE}/api/me/dialogs`).then(r => r.json());
        if (!Array.isArray(list)) throw new Error(list.error || 'Error');
        if (!list.length) { ul.innerHTML = '<li class="muted small">No tienes canales o grupos. Crea uno nuevo.</li>'; return; }
        ul.innerHTML = list.map(d => `
          <li class="chat-pick" data-id="${esc(d.id)}">
            <span class="chat-pick-badge chat-pick-${d.type}">${d.type}</span>
            <span class="chat-pick-name">${esc(d.name)}</span>
            ${d.username ? `<span class="chat-pick-username">${esc(d.username)}</span>` : ''}
            <code class="chat-pick-id">${esc(d.id)}</code>
          </li>`).join('');
        ul.querySelectorAll('.chat-pick').forEach(li => {
          li.addEventListener('click', () => {
            ul.querySelectorAll('.chat-pick').forEach(x => x.classList.remove('selected'));
            li.classList.add('selected');
            selectedChatId = li.dataset.id;
            document.getElementById('wch-next').disabled = false;
          });
        });
      } catch (err) {
        ul.innerHTML = `<li class="muted small">Error: ${esc(err.message)}</li>`;
      }
    }

    document.getElementById('wch-create').addEventListener('click', async () => {
      setErr('chat', '');
      const title = document.getElementById('wch-newname').value.trim();
      if (!title) { setErr('chat', 'Pon un nombre'); return; }
      const btn = document.getElementById('wch-create');
      btn.disabled = true; btn.textContent = 'Creando…';
      try {
        const r = await fetch(`${BASE}/api/me/create-channel`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ title })
        }).then(x => x.json());
        if (!r.ok) throw new Error(r.error || 'Error');
        selectedChatId = r.id;
        // Saltar directo a select-chat
        await selectChatAndSync();
      } catch (err) {
        setErr('chat', err.message);
        btn.disabled = false; btn.textContent = 'Crear canal';
      }
    });

    document.getElementById('wch-next').addEventListener('click', selectChatAndSync);

    async function selectChatAndSync() {
      if (!selectedChatId) return;
      setErr('chat', '');
      try {
        await fetch(`${BASE}/api/me/select-chat`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ tg_chat: selectedChatId })
        }).then(r => r.json());
        showStep('sync');
        startSyncMonitor(true);
      } catch (err) {
        setErr('chat', err.message);
      }
    }

    // Botones "atrás"
    document.querySelectorAll('#wizard-screen [data-back]').forEach(btn => {
      btn.addEventListener('click', () => showStep(btn.dataset.back));
    });

    // Polling de progreso de sync
    let syncTimer = null;
    function startSyncMonitor(autoFinish = false) {
      const bar = document.getElementById('ws-bar');
      const stats = document.getElementById('ws-stats');
      const finish = document.getElementById('ws-finish');
      finish.hidden = true;
      bar.style.width = '0%';
      stats.textContent = 'Conectando…';

      let started = false;
      if (syncTimer) clearInterval(syncTimer);
      syncTimer = setInterval(async () => {
        try {
          const s = await fetch(`${BASE}/api/me/sync-status`).then(r => r.json());
          if (s.running || started) {
            started = true;
            const pct = s.scanned ? Math.min(99, Math.round((s.scanned / 2000) * 100)) : 5;
            bar.style.width = pct + '%';
            stats.textContent = `Escaneados ${s.scanned} mensajes · Importados ${s.imported}`;
          }
          if (s.done) {
            clearInterval(syncTimer); syncTimer = null;
            bar.style.width = '100%';
            stats.textContent = `✓ ${s.imported} archivos importados de ${s.scanned} mensajes escaneados`;
            if (autoFinish) {
              finish.hidden = false;
            }
          }
          if (s.error) {
            clearInterval(syncTimer); syncTimer = null;
            stats.textContent = `Error: ${s.error}`;
            stats.style.color = 'var(--err)';
            finish.hidden = false;
          }
        } catch { /* keep trying */ }
      }, 1000);
    }

    document.getElementById('ws-finish').addEventListener('click', async () => {
      currentUser = await fetch(`${BASE}/api/auth/me`).then(r => r.json());
      showApp(currentUser);
      loadBrowse(getPathFromHash(), true);
    });

    return { showStep, startSyncMonitor };
  })();

  // ═════════════════════════════════════════════════════════════════════════
  // Auth state UI
  // ═════════════════════════════════════════════════════════════════════════
  function showWizard() {
    document.getElementById('wizard-screen').hidden = false;
    document.getElementById('app-shell').hidden    = true;
    currentUser = null;
    WIZ.showStep('phone');
  }

  function showApp(user) {
    currentUser = user;
    document.getElementById('wizard-screen').hidden = true;
    document.getElementById('app-shell').hidden    = false;

    const label  = document.getElementById('user-name-label');
    const avatar = document.getElementById('user-avatar');
    const phoneShort = (user.phone || '').slice(-4);
    label.textContent  = '••' + phoneShort;
    avatar.textContent = (user.phone || '?').slice(-1);
  }

  async function checkAuth() {
    try {
      const cfg = await fetch(`${BASE}/api/config`).then(r => r.json()).catch(() => ({}));
      BASE         = cfg.basePath    || BASE;
      TUS_ENDPOINT = cfg.tusEndpoint || TUS_ENDPOINT;

      const r = await fetch(`${BASE}/api/auth/me`);
      if (!r.ok) { showWizard(); return; }
      const me = await r.json();
      if (!me.has_chat) {
        // Logueado pero sin canal — al wizard a elegir canal
        currentUser = me;
        document.getElementById('wizard-screen').hidden = false;
        document.getElementById('app-shell').hidden    = true;
        WIZ.showStep('chat');
        try {
          const list = await fetch(`${BASE}/api/me/dialogs`).then(x => x.json());
          const ul = document.getElementById('wch-list');
          if (Array.isArray(list) && list.length) {
            ul.innerHTML = list.map(d => `
              <li class="chat-pick" data-id="${esc(d.id)}">
                <span class="chat-pick-badge chat-pick-${d.type}">${d.type}</span>
                <span class="chat-pick-name">${esc(d.name)}</span>
                ${d.username ? `<span class="chat-pick-username">${esc(d.username)}</span>` : ''}
                <code class="chat-pick-id">${esc(d.id)}</code>
              </li>`).join('');
            ul.querySelectorAll('.chat-pick').forEach(li => {
              li.addEventListener('click', () => {
                ul.querySelectorAll('.chat-pick').forEach(x => x.classList.remove('selected'));
                li.classList.add('selected');
                window.__selectedChatId = li.dataset.id;
                document.getElementById('wch-next').disabled = false;
              });
            });
          }
        } catch {}
        return;
      }
      showApp(me);
      loadBrowse(getPathFromHash(), true);
    } catch {
      showWizard();
    }
  }

  // Logout
  document.getElementById('logout-btn').addEventListener('click', async () => {
    closeDropdown();
    await fetch(`${BASE}/api/auth/logout`, { method: 'POST' });
    location.hash = '';
    showWizard();
  });

  const userMenuBtn  = document.getElementById('user-menu-btn');
  const userDropdown = document.getElementById('user-dropdown');
  function closeDropdown() { userDropdown.hidden = true; }
  userMenuBtn.addEventListener('click', ev => { ev.stopPropagation(); userDropdown.hidden = !userDropdown.hidden; });
  document.addEventListener('click', closeDropdown);
  userDropdown.addEventListener('click', ev => ev.stopPropagation());

  // ═════════════════════════════════════════════════════════════════════════
  // Settings modal
  // ═════════════════════════════════════════════════════════════════════════
  function openModal(id) { const m=document.getElementById(id); m.hidden=false; m.setAttribute('aria-hidden','false'); }
  function closeModal(id){ const m=document.getElementById(id); m.hidden=true;  m.setAttribute('aria-hidden','true'); }

  document.getElementById('settings-btn').addEventListener('click', async () => {
    openModal('settings-modal');
    await refreshSettings();
  });

  async function refreshSettings() {
    try {
      const me = await api('GET', `${BASE}/api/auth/me`);
      currentUser = me;
      document.getElementById('cur-chat-id').textContent = me.tg_chat || '—';
      document.getElementById('set-api-id').value   = me.tg_api_id || '';
      document.getElementById('set-api-hash').value = me.tg_api_hash || '';
      document.getElementById('set-ttl').value      = me.session_ttl_days || 30;
      updateTgStatusUI(me.tg_status || 'idle', '');
      loadSettingsDialogs();
    } catch (e) { /* nada */ }
  }

  document.getElementById('set-creds-save').addEventListener('click', async () => {
    const errEl = document.getElementById('set-creds-err');
    errEl.hidden = true;
    const apiId   = document.getElementById('set-api-id').value.trim();
    const apiHash = document.getElementById('set-api-hash').value.trim();
    if (!apiId || isNaN(parseInt(apiId, 10)))   { errEl.textContent = 'API ID inválido'; errEl.hidden = false; return; }
    if (!/^[0-9a-f]{32}$/i.test(apiHash))       { errEl.textContent = 'API Hash inválido (32 caracteres hex)'; errEl.hidden = false; return; }
    if (!confirm('Al cambiar las credenciales se cerrará tu sesión. ¿Continuar?')) return;
    const btn = document.getElementById('set-creds-save');
    btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      await api('POST', `${BASE}/api/me/update-credentials`, { apiId, apiHash });
      // Forzar logout
      location.hash = '';
      showWizard();
      closeModal('settings-modal');
    } catch (err) {
      errEl.textContent = err.message; errEl.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = 'Guardar y cerrar sesión';
    }
  });

  document.getElementById('set-ttl-save').addEventListener('click', async () => {
    const msg = document.getElementById('set-ttl-msg');
    let days = parseInt(document.getElementById('set-ttl').value, 10);
    if (!days || days < 1) days = 1;
    if (days > 60) days = 60;
    document.getElementById('set-ttl').value = days;
    try {
      await api('POST', `${BASE}/api/me/update-ttl`, { days });
      msg.textContent = `✓ Guardado: ${days} días (efectivo en el próximo login)`;
      msg.style.color = 'var(--ok)';
    } catch (err) {
      msg.textContent = 'Error: ' + err.message;
      msg.style.color = 'var(--err)';
    }
  });

  function updateTgStatusUI(status, error) {
    const dot = document.getElementById('tg-status-dot');
    const text = document.getElementById('tg-status-text');
    const errEl = document.getElementById('tg-status-error');
    const map = {
      connected:      { cls: 'dot-ok',   label: 'Conectado' },
      idle:           { cls: 'dot-warn', label: 'Idle (se conecta al actuar)' },
      no_chat:        { cls: 'dot-off',  label: 'Sin canal seleccionado' },
      no_session:     { cls: 'dot-err',  label: 'Sesión Telegram requerida' },
      session_expired:{ cls: 'dot-err',  label: 'Sesión expirada — vuelve a entrar' },
      disconnected:   { cls: 'dot-off',  label: 'Desconectado' },
      error:          { cls: 'dot-err',  label: 'Error' },
    };
    const info = map[status] || { cls: 'dot-off', label: status || '—' };
    dot.className = 'status-dot ' + info.cls;
    text.textContent = info.label;
    if (error) { errEl.textContent = error; errEl.hidden = false; }
    else        { errEl.hidden = true; }
  }

  document.getElementById('tg-reconnect-btn').addEventListener('click', async () => {
    const btn = document.getElementById('tg-reconnect-btn');
    btn.disabled = true; btn.textContent = 'Reconectando…';
    try {
      const r = await fetch(`${BASE}/api/me/reconnect`, { method: 'POST' }).then(x => x.json());
      updateTgStatusUI(r.tg_status || (r.ok ? 'connected' : 'error'), r.tg_error);
    } finally {
      btn.disabled = false; btn.textContent = 'Reconectar';
    }
  });

  async function loadSettingsDialogs() {
    const ul = document.getElementById('set-chat-list');
    ul.innerHTML = '<li class="muted small">Cargando…</li>';
    try {
      const list = await api('GET', `${BASE}/api/me/dialogs`);
      if (!list.length) { ul.innerHTML = '<li class="muted small">No hay canales o grupos.</li>'; return; }
      ul.innerHTML = list.map(d => `
        <li class="chat-pick${d.id === currentUser?.tg_chat ? ' selected' : ''}" data-id="${esc(d.id)}">
          <span class="chat-pick-badge chat-pick-${d.type}">${d.type}</span>
          <span class="chat-pick-name">${esc(d.name)}</span>
          ${d.username ? `<span class="chat-pick-username">${esc(d.username)}</span>` : ''}
          <code class="chat-pick-id">${esc(d.id)}</code>
        </li>`).join('');
      ul.querySelectorAll('.chat-pick').forEach(li => {
        li.addEventListener('click', async () => {
          if (li.dataset.id === currentUser?.tg_chat) return;
          if (!confirm(`Cambiar al canal "${li.querySelector('.chat-pick-name').textContent}"? Los archivos del canal anterior se ocultarán (siguen ahí, vuelven al re-seleccionar).`)) return;
          await selectChat(li.dataset.id);
        });
      });
    } catch (e) {
      ul.innerHTML = `<li class="muted small">Error: ${esc(e.message)}</li>`;
    }
  }

  document.getElementById('set-chat-refresh').addEventListener('click', loadSettingsDialogs);

  document.getElementById('set-create-chan').addEventListener('click', async () => {
    const title = document.getElementById('set-newchan').value.trim();
    if (!title) return;
    const btn = document.getElementById('set-create-chan');
    btn.disabled = true; btn.textContent = 'Creando…';
    document.getElementById('set-chat-err').hidden = true;
    try {
      const r = await api('POST', `${BASE}/api/me/create-channel`, { title });
      await selectChat(r.id);
    } catch (e) {
      const errEl = document.getElementById('set-chat-err');
      errEl.textContent = e.message; errEl.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = 'Crear canal';
    }
  });

  async function selectChat(chatId) {
    const msg = document.getElementById('set-chat-msg');
    msg.textContent = 'Cambiando canal…'; msg.style.color = 'var(--muted)';
    try {
      await api('POST', `${BASE}/api/me/select-chat`, { tg_chat: chatId });
      msg.textContent = '✓ Canal cambiado, sincronizando…'; msg.style.color = 'var(--ok)';
      await refreshSettings();
      monitorSyncInSettings();
      setTimeout(() => loadBrowse(''), 800);
    } catch (e) {
      msg.textContent = 'Error: ' + e.message; msg.style.color = 'var(--err)';
    }
  }

  document.getElementById('trigger-sync').addEventListener('click', async () => {
    await api('POST', `${BASE}/api/me/sync`);
    document.getElementById('sync-msg').textContent = 'Sincronizando…';
    monitorSyncInSettings();
  });

  let settingsSyncTimer = null;
  function monitorSyncInSettings() {
    const wrap = document.getElementById('sync-progress-wrap');
    const bar = document.getElementById('sync-progress-bar');
    const msg = document.getElementById('sync-msg');
    wrap.hidden = false; bar.style.width = '0%';
    if (settingsSyncTimer) clearInterval(settingsSyncTimer);
    settingsSyncTimer = setInterval(async () => {
      try {
        const s = await api('GET', `${BASE}/api/me/sync-status`);
        const pct = s.scanned ? Math.min(99, Math.round((s.scanned / 2000) * 100)) : 5;
        bar.style.width = pct + '%';
        msg.textContent = `Escaneados ${s.scanned} · Importados ${s.imported}`;
        if (s.done) {
          clearInterval(settingsSyncTimer); settingsSyncTimer = null;
          bar.style.width = '100%';
          msg.textContent = `✓ ${s.imported} importados de ${s.scanned} mensajes`;
          loadBrowse(currentPath);
        }
        if (s.error) {
          clearInterval(settingsSyncTimer); settingsSyncTimer = null;
          msg.textContent = 'Error: ' + s.error;
        }
      } catch { /* keep */ }
    }, 1000);
  }

  // Tabs select / create en settings
  document.querySelectorAll('#settings-modal .chat-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const wrap = tab.closest('.settings-section');
      wrap.querySelectorAll('.chat-tab').forEach(t => t.classList.toggle('active', t === tab));
      wrap.querySelectorAll('.chat-pane').forEach(p => p.hidden = p.dataset.pane !== tab.dataset.tab);
    });
  });

  // Modal close (X / backdrop) — limpia preview body
  document.querySelectorAll('[data-close]').forEach(el => {
    el.addEventListener('click', () => {
      const m = el.closest('.modal');
      if (m) {
        m.hidden = true; m.setAttribute('aria-hidden', 'true');
        if (m.id === 'preview-modal') {
          document.getElementById('preview-body').innerHTML = '';
          currentPreview = null;
        }
      }
    });
  });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') {
      document.querySelectorAll('.modal:not([hidden])').forEach(m => {
        m.hidden = true; m.setAttribute('aria-hidden', 'true');
        if (m.id === 'preview-modal') { document.getElementById('preview-body').innerHTML=''; currentPreview=null; }
      });
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Bulk selection
  // ═════════════════════════════════════════════════════════════════════════
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

  // ═════════════════════════════════════════════════════════════════════════
  // Browser / breadcrumbs / rows
  // ═════════════════════════════════════════════════════════════════════════
  function renderCrumbs(p, crumbs) {
    const parts = p ? p.split('/').filter(Boolean) : [];
    const el = document.getElementById('crumbs');
    const html = ['<button class="crumb" data-go="" data-fid="">/ raíz</button>'];
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
        let item; try { item = JSON.parse(ev.dataTransfer.getData('application/x-cloud-item')); } catch { return; }
        const targetFid = b.dataset.fid === '' ? null : Number(b.dataset.fid);
        if (item.type === 'dir' && item.id === targetFid) return;
        await moveItem(item, targetFid);
      });
    });
  }

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

      li.draggable = true;
      li.addEventListener('dragstart', ev => {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('application/x-cloud-item', JSON.stringify({ type, id, name }));
        ev.dataTransfer.setData('text/plain', name);
        li.classList.add('dragging');
      });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));

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
          let item; try { item = JSON.parse(ev.dataTransfer.getData('application/x-cloud-item')); } catch { return; }
          if (item.type === 'dir' && item.id === id) return;
          await moveItem(item, id);
        });
      }

      li.querySelectorAll('.iconbtn').forEach(btn => btn.addEventListener('click', ev => {
        ev.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'download')           triggerDownload(`${BASE}/api/stream?id=${id}&inline=0`, name);
        else if (act === 'download-lite') triggerDownload(`${BASE}/api/transcode?id=${id}`);
        else if (act === 'zip')           triggerDownload(`${BASE}/api/zip?id=${id}`, name + '.zip');
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

  // ═════════════════════════════════════════════════════════════════════════
  // Preview modal
  // ═════════════════════════════════════════════════════════════════════════
  let currentPreview = null;
  function openPreview(id, name, mimeType, size) {
    currentPreview = { id, name, mimeType, size };
    const body = document.getElementById('preview-body');
    document.getElementById('preview-name').textContent = name;
    document.getElementById('preview-meta').textContent = fmtSize(size);
    document.getElementById('preview-download').onclick      = () => triggerDownload(`${BASE}/api/stream?id=${id}&inline=0`, name);
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
          El navegador no puede mostrar este formato directamente. Descarga el archivo para abrirlo.
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

  // ═════════════════════════════════════════════════════════════════════════
  // Mkdir / rename / delete / bulk
  // ═════════════════════════════════════════════════════════════════════════
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

  async function promptRename(type, id, oldName) {
    const newName = prompt(`Nuevo nombre para "${oldName}":`, oldName);
    if (!newName || newName === oldName) return;
    setBrowserStatus('Renombrando…');
    try {
      await api('POST', `${BASE}/api/rename`, { type, id, newName });
      setBrowserStatus('✓ Renombrado.', 'ok'); loadBrowse(currentPath);
    } catch (err) { setBrowserStatus('Error: ' + err.message, 'err'); }
  }

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

  document.getElementById('bulk-delete').addEventListener('click', () => {
    if (!selected.size) return;
    const items = Array.from(selected).map(key => {
      const [t, id] = key.split(':');
      const type = t === 'f' ? 'file' : 'dir';
      return { type, id: Number(id), name: document.querySelector(`[data-key="${key}"]`)?.dataset.name || key };
    });
    confirmDelete(items);
  });
  document.getElementById('bulk-zip').addEventListener('click', () => {
    if (selected.size !== 1) { setBrowserStatus('Selecciona una sola carpeta.', 'err'); return; }
    const key = Array.from(selected)[0];
    if (!key.startsWith('d:')) { setBrowserStatus('ZIP solo disponible para carpetas.', 'err'); return; }
    const folderName = document.querySelector(`[data-key="${key}"]`)?.dataset.name || 'carpeta';
    triggerDownload(`${BASE}/api/zip?id=${key.split(':')[1]}`, folderName + '.zip');
  });

  // Nav buttons
  document.getElementById('nav-back').addEventListener('click', () => history.back());
  document.getElementById('nav-fwd').addEventListener('click',  () => history.forward());
  document.getElementById('nav-home').addEventListener('click', () => loadBrowse(''));

  window.addEventListener('popstate', ev => {
    if (document.getElementById('app-shell').hidden) return;
    const path = ev.state?.path ?? getPathFromHash();
    loadBrowse(path, true);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Drag & drop upload (from desktop)
  // ═════════════════════════════════════════════════════════════════════════
  const browser = document.getElementById('browser');
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

  // ═════════════════════════════════════════════════════════════════════════
  // Upload modal
  // ═════════════════════════════════════════════════════════════════════════
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
    const oWrap = document.getElementById('upload-overall-wrap');
    const oBar  = document.getElementById('upload-overall-bar');
    const oPct  = document.getElementById('upload-overall-pct');
    if (oWrap) oWrap.hidden = true;
    if (oBar)  oBar.style.width = '0%';
    if (oPct)  oPct.textContent = '0%';
    if (files.length) addToQueue(files);
  }
  function addToQueue(files) {
    for (const { file, rel } of files) uploadQueue.push({ file, rel, status: 'pending', progress: 0 });
    renderQueue();
  }
  function renderQueue() {
    const ul = document.getElementById('upload-queue');
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
      const displayName = (item.rel && item.rel !== item.file.name) ? esc(item.rel) : esc(item.file.name);
      return `<li>${statusIcon}<div class="row-main"><div class="q-name" title="${esc(item.rel || item.file.name)}">${displayName}</div>${progress}</div><span class="q-size">${fmtSize(item.file.size)}</span></li>`;
    }).join('');
  }

  document.getElementById('start-upload-btn').addEventListener('click', startUploads);

  async function startUploads() {
    const pending = uploadQueue.filter(i => i.status === 'pending');
    if (!pending.length) return;
    document.getElementById('start-upload-btn').disabled = true;

    const statusEl   = document.getElementById('upload-status');
    const oWrap      = document.getElementById('upload-overall-wrap');
    const oBar       = document.getElementById('upload-overall-bar');
    const oPct       = document.getElementById('upload-overall-pct');
    const totalBytes = pending.reduce((s, i) => s + i.file.size, 0);
    let doneBytes = 0;

    function updateOverall(curFileBytes) {
      const pct = totalBytes > 0 ? Math.min(100, Math.round(((doneBytes + curFileBytes) / totalBytes) * 100)) : 0;
      if (oBar) oBar.style.width = pct + '%';
      if (oPct) oPct.textContent = pct + '%';
    }
    if (oWrap) oWrap.hidden = false;
    updateOverall(0);
    statusEl.style.color = 'var(--muted)';
    statusEl.textContent = `Subiendo ${pending.length} archivo(s)…`;

    let ok = 0, fail = 0;
    for (const item of pending) {
      item.status = 'busy'; renderQueue();
      try {
        await tusUpload(item, curBytes => updateOverall(curBytes));
        doneBytes += item.file.size;
        item.status = 'ok'; ok++;
      } catch (err) {
        item.status = 'err'; item.error = err.message; fail++;
      }
      updateOverall(0);
      renderQueue();
    }
    if (oBar) oBar.style.width = '100%';
    if (oPct) oPct.textContent = fail === 0 ? '100%' : (totalBytes > 0 ? Math.round((doneBytes / totalBytes) * 100) + '%' : '—');
    statusEl.textContent = fail === 0 ? `✓ ${ok} archivo(s) subido(s).` : `${ok} ok · ${fail} fallido(s).`;
    statusEl.style.color = fail === 0 ? 'var(--ok)' : 'var(--err)';
    document.getElementById('start-upload-btn').disabled = false;
    loadBrowse(currentPath);
  }

  function tusUpload(item, onProgress) {
    return new Promise((resolve, reject) => {
      const fileSize  = item.file.size;
      const chunkSize = 8 * 1024 * 1024;
      let offset = 0, tusUrl = '';

      // Compute destination folder: currentPath + relative subdirectory from item.rel
      const relDir = (() => {
        const r = item.rel || item.file.name;
        const i = r.lastIndexOf('/');
        return i >= 0 ? r.substring(0, i) : '';
      })();
      const itemFolder = relDir ? (currentPath ? currentPath + '/' + relDir : relDir) : currentPath;

      function createUpload() {
        const req = new XMLHttpRequest();
        req.open('POST', TUS_ENDPOINT);
        req.setRequestHeader('Tus-Resumable', '1.0.0');
        req.setRequestHeader('Upload-Length', String(fileSize));
        req.setRequestHeader('Upload-Metadata',
          `filename ${btoa(unescape(encodeURIComponent(item.file.name)))},type ${btoa(item.file.type || 'application/octet-stream')},folder ${btoa(unescape(encodeURIComponent(itemFolder)))}`
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
        const end = Math.min(offset + chunkSize, fileSize);
        const slice = item.file.slice(offset, end);
        const req = new XMLHttpRequest();
        req.open('PATCH', tusUrl);
        req.setRequestHeader('Tus-Resumable', '1.0.0');
        req.setRequestHeader('Content-Type', 'application/offset+octet-stream');
        req.setRequestHeader('Upload-Offset', String(offset));
        req.upload.onprogress = ev => {
          if (ev.lengthComputable) {
            const loaded = offset + ev.loaded;
            item.progress = Math.round((loaded / fileSize) * 100);
            const bar = document.getElementById(`pb-${uploadQueue.indexOf(item)}`);
            if (bar) bar.style.width = item.progress + '%';
            if (onProgress) onProgress(loaded);
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

  // Inicio
  checkAuth();
})();

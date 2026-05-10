(function () {
  'use strict';

  let BASE         = '/cloud';
  let TUS_ENDPOINT = '/cloud/files';
  let currentPath     = '';
  let currentFolderId = null;
  let currentUser     = null; // { id, phone, has_chat, tg_chat, tg_status }

  // ── i18n: apply translations to DOM ──────────────────────────────────────
  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
    document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    updateLangBtns();
  }
  function updateLangBtns() {
    const cur = getLang();
    document.querySelectorAll('.lang-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.lang === cur));
  }
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => setLang(btn.dataset.lang));
  });
  document.addEventListener('langchange', () => {
    applyI18n();
    if (!document.getElementById('app-shell').hidden) loadBrowse(currentPath, true);
  });
  applyI18n();

  // ── In-app navigation stack (keeps back/fwd inside the folder browser) ────
  let _navStack = [];
  let _navIdx   = -1;
  function _navPush(path) {
    _navStack = _navStack.slice(0, _navIdx + 1);
    if (_navStack.length && _navStack[_navIdx] === path) return;
    _navStack.push(path);
    _navIdx = _navStack.length - 1;
    _updateNavBtns();
  }
  function _updateNavBtns() {
    document.getElementById('nav-back').disabled = _navIdx <= 0;
    document.getElementById('nav-fwd').disabled  = _navIdx >= _navStack.length - 1;
  }

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
    return new Date(epoch * 1000).toLocaleDateString(getLang(), { day: '2-digit', month: 'short', year: 'numeric' });
  }
  const _s = `fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
  const ICONS = {
    folder:      `<svg viewBox="0 0 16 16" ${_s}><path d="M1.5 5.5a1 1 0 0 1 1-1H6l1.5 2h6a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/></svg>`,
    image:       `<svg viewBox="0 0 16 16" ${_s}><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><circle cx="5.5" cy="6" r="1.5"/><path d="M1.5 10l3.5-3.5L8 10l2-2 4.5 5.5"/></svg>`,
    video:       `<svg viewBox="0 0 16 16" ${_s}><rect x="1.5" y="4" width="9" height="8" rx="1.5"/><path d="M10.5 7.5l4-2.5v5l-4-2.5z"/></svg>`,
    audio:       `<svg viewBox="0 0 16 16" ${_s}><path d="M9 12.5V5l5-1.5v2.5L9 7.5"/><circle cx="6.5" cy="12.5" r="2.5"/></svg>`,
    pdf:         `<svg viewBox="0 0 16 16" ${_s}><path d="M3.5 1.5h7.5L14 5v9.5H3.5z"/><path d="M11 1.5V5H14"/><path d="M6 7.5h2.5a1 1 0 0 1 0 2H6z"/></svg>`,
    archive:     `<svg viewBox="0 0 16 16" ${_s}><rect x="1.5" y="1.5" width="13" height="3.5" rx="1"/><path d="M2.5 5V14h11V5"/><path d="M8 7v4M6 9.5l2 2 2-2"/></svg>`,
    file:        `<svg viewBox="0 0 16 16" ${_s}><path d="M3.5 1.5h7.5L14 5v9.5H3.5z"/><path d="M11 1.5V5H14"/><path d="M5.5 8.5h5M5.5 11h5"/></svg>`,
    code:        `<svg viewBox="0 0 16 16" ${_s}><path d="M4.5 4L1 8l3.5 4M11.5 4L15 8l-3.5 4M9.5 2l-3 12"/></svg>`,
    package:     `<svg viewBox="0 0 16 16" ${_s}><path d="M14 6L8 2 2 6v4.5L8 14l6-3.5z"/><path d="M8 2v12M2 6l6 4 6-4"/></svg>`,
    download:    `<svg viewBox="0 0 16 16" ${_s}><path d="M8 2v9M5 8l3 3 3-3M3 14h10"/></svg>`,
    'dl-lite':   `<svg viewBox="0 0 16 16" ${_s}><path d="M7 2v9M4 8l3 3 3-3M2 14h10"/><path d="M12 2l-1.5 2.5h1.3l-1.8 3" stroke-width="1.3"/></svg>`,
    share:       `<svg viewBox="0 0 16 16" ${_s}><circle cx="12.5" cy="3.5" r="1.5"/><circle cx="12.5" cy="12.5" r="1.5"/><circle cx="3.5" cy="8" r="1.5"/><path d="M5 7.1l6-2.4M5 8.9l6 2.4"/></svg>`,
    rename:      `<svg viewBox="0 0 16 16" ${_s}><path d="M11.5 2.5l2 2-8 8H3.5v-2l8-8zM10 4l2 2"/></svg>`,
    delete:      `<svg viewBox="0 0 16 16" ${_s}><path d="M2.5 5h11M5.5 5V3h5v2M4 5l.75 8.5h6.5L12 5M6.5 7.5v4M9.5 7.5v4"/></svg>`,
    zip:         `<svg viewBox="0 0 16 16" ${_s}><rect x="2" y="2" width="12" height="3.5" rx="1"/><path d="M3 5.5v8h10v-8M8 7.5v4M6.5 10l1.5 2 1.5-2"/></svg>`,
    back:        `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.5 3L5.5 8l5 5"/></svg>`,
    home:        `<svg viewBox="0 0 16 16" ${_s}><path d="M2.5 7.5L8 2.5l5.5 5M4.5 6.5V13h2.5v-3h2v3h2.5V6.5"/></svg>`,
    forward:     `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 3l5 5-5 5"/></svg>`,
    close:       `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13"/></svg>`,
    settings:    `<svg viewBox="0 0 16 16" ${_s}><circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"/></svg>`,
    warning:     `<svg viewBox="0 0 16 16" ${_s}><path d="M8 2L1 14.5h14z"/><path d="M8 6.5v4"/><circle cx="8" cy="12.5" r=".75" fill="currentColor" stroke="none"/></svg>`,
    upload:      `<svg viewBox="0 0 16 16" ${_s}><path d="M8 12V4M5 7l3-3 3 3M3 14.5h10"/></svg>`,
    mkdir:       `<svg viewBox="0 0 16 16" ${_s}><path d="M1.5 5.5a1 1 0 0 1 1-1H6l1.5 2h5a1 1 0 0 1 1 1v3"/><path d="M11 11v4M9 13h4"/></svg>`,
    move:        `<svg viewBox="0 0 16 16" ${_s}><path d="M4 12L12 4M5 4h7v7"/></svg>`,
    drop:        `<svg viewBox="0 0 16 16" ${_s}><path d="M8 1.5v10M5 8l3 3.5 3-3.5M2.5 14.5h11"/></svg>`,
    'folder-open':`<svg viewBox="0 0 16 16" ${_s}><path d="M1.5 5.5a1 1 0 0 1 1-1H6l1.5 2h6a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/><path d="M8 8.5v3M6.5 10l1.5 2 1.5-2"/></svg>`,
    link:        `<svg viewBox="0 0 16 16" ${_s}><path d="M6.5 9.5a3.5 3.5 0 0 0 5 0l2-2a3.5 3.5 0 0 0-5-5L7.5 3.5"/><path d="M9.5 6.5a3.5 3.5 0 0 0-5 0l-2 2a3.5 3.5 0 0 0 5 5L8.5 12.5"/></svg>`,
    external:    `<svg viewBox="0 0 16 16" ${_s}><path d="M7 2.5H3.5a1 1 0 0 0-1 1V13a1 1 0 0 0 1 1H13a1 1 0 0 0 1-1V9.5"/><path d="M9.5 1.5h5v5M7 9L14.5 1.5"/></svg>`,
    antenna:     `<svg viewBox="0 0 16 16" ${_s}><path d="M8 13V8M5.5 10.5A3.5 3.5 0 0 1 10.5 10.5"/><path d="M3 8A6 6 0 0 1 13 8" stroke-width="1.4"/><circle cx="8" cy="14.5" r="1.5"/></svg>`,
    database:    `<svg viewBox="0 0 16 16" ${_s}><ellipse cx="8" cy="4" rx="5.5" ry="2"/><path d="M2.5 4v4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4M2.5 8v4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V8"/></svg>`,
    sync:        `<svg viewBox="0 0 16 16" ${_s}><path d="M14 8A6 6 0 0 1 3 11.5M2 8A6 6 0 0 1 13 4.5"/><path d="M14 4.5V8h-3.5M2 11.5V8h3.5"/></svg>`,
    key:         `<svg viewBox="0 0 16 16" ${_s}><circle cx="6" cy="7.5" r="3.5"/><path d="M8.5 9.5l6 6M11.5 12.5l2-2"/></svg>`,
    timer:       `<svg viewBox="0 0 16 16" ${_s}><circle cx="8" cy="9.5" r="5.5"/><path d="M8 7v3h2.5M5.5 1.5h5M8 1.5v2"/></svg>`,
    music:       `<svg viewBox="0 0 16 16" ${_s}><path d="M9 12.5V5l5-1.5v2.5L9 7.5"/><circle cx="6.5" cy="12.5" r="2.5"/></svg>`,
    volume:      `<svg viewBox="0 0 16 16" ${_s}><path d="M3 6H1.5v4H3l4 3V3z"/><path d="M10.5 5.5a4 4 0 0 1 0 5"/></svg>`,
    'go-back':   `<svg viewBox="0 0 16 16" ${_s}><path d="M4 7.5H11.5a3 3 0 0 1 0 6H10M7 4.5L4 7.5l3 3"/></svg>`,
    'chev-r':    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 3.5L10.5 8l-5 4.5"/></svg>`,
    'q-ok':      `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8l3.5 4 6.5-7"/></svg>`,
    'q-err':     `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>`,
    'q-skip':    `<svg viewBox="0 0 16 16" ${_s}><circle cx="8" cy="8" r="6"/><path d="M5.5 8h5"/></svg>`,
    'q-busy':    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M14 8A6 6 0 1 1 8 2"/></svg>`,
  };
  function ic(name) { return ICONS[name] || ''; }
  function fileIconSvg(mt, name) {
    if (!mt) mt = '';
    if (mt.startsWith('image/')) return ic('image');
    if (mt.startsWith('video/')) return ic('video');
    if (isAudio(mt, name))       return ic('audio');
    if (mt.includes('pdf'))      return ic('pdf');
    if (mt.includes('zip') || mt.includes('tar') || mt.includes('compress')) return ic('archive');
    if (mt.includes('text') || /\.(txt|md|log)$/i.test(name)) return ic('file');
    if (/\.(js|ts|py|go|rs|java|c|cpp|sh|json|yaml|yml|toml)$/i.test(name)) return ic('code');
    return ic('package');
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
  function isAudio(mt, name)  { return (mt||'').startsWith('audio/') || /\.(mp3|ogg|flac|wav|m4a|aac|opus|wma|aiff|ape|mka)$/i.test(name||''); }
  function isMedia(mt, name)  { return (mt||'').startsWith('image/') || (mt||'').startsWith('video/') || isAudio(mt, name); }
  function canTranscode(mt, name) { return (mt||'').startsWith('image/') || (mt||'').startsWith('video/') || isAudio(mt, name); }
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

  async function api(method, url, body, signal) {
    const opts = { method, headers: {} };
    if (signal) opts.signal = signal;
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
  // PIN helpers
  // ═════════════════════════════════════════════════════════════════════════
  function bindPinBoxes(containerId, onChange) {
    const boxes = Array.from(document.querySelectorAll(`#${containerId} .pin-box`));
    boxes.forEach((box, i) => {
      box.addEventListener('input', () => {
        box.value = box.value.replace(/\D/g, '').slice(-1);
        if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
        onChange?.();
      });
      box.addEventListener('keydown', e => {
        if (e.key === 'Backspace' && !box.value && i > 0) { boxes[i - 1].focus(); boxes[i - 1].value = ''; onChange?.(); }
        if (e.key === 'ArrowLeft'  && i > 0) boxes[i - 1].focus();
        if (e.key === 'ArrowRight' && i < boxes.length - 1) boxes[i + 1].focus();
      });
      box.addEventListener('paste', e => {
        e.preventDefault();
        const digits = (e.clipboardData.getData('text') || '').replace(/\D/g,'').slice(0,4);
        digits.split('').forEach((d, j) => { if (boxes[j]) boxes[j].value = d; });
        const last = Math.min(digits.length, boxes.length - 1);
        boxes[last].focus();
        onChange?.();
      });
    });
    return {
      get value() { return boxes.map(b => b.value).join(''); },
      clear() { boxes.forEach(b => b.value = ''); boxes[0].focus(); },
      focus() { boxes[0].focus(); },
    };
  }

  function pinHint(pin) {
    if (pin.length < 4) return null;
    if (/^(.)\1{3}$/.test(pin)) return t('pin.simple');
    if (['1234','2345','3456','4567','5678','6789','9876','8765','7654','6543','5432','4321','0000','1111','2222','3333','4444','5555','6666','7777','8888','9999'].includes(pin))
      return t('pin.weak');
    return null;
  }
  function updatePinBtn(pin, conf, hintId, btnId) {
    const p = pin.value, c = conf.value;
    const hintEl = document.getElementById(hintId);
    const btn    = document.getElementById(btnId);
    const h = pinHint(p);
    if (h && p.length === 4) { hintEl.textContent = h; hintEl.hidden = false; }
    else { hintEl.hidden = true; }
    btn.disabled = (p.length < 4 || c.length < 4 || p !== c || !!h);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // WIZARD
  // ═════════════════════════════════════════════════════════════════════════
  const WIZ = (() => {
    let phone = '', apiId = '', apiHash = '', tempId = '', setupTempId = '', pinResetToken = '', floodId = '', qrTempId = '';
    let isNewUser = false;
    let qrPollTimer = null;

    function showStep(name) {
      if (name !== 'qr-login') stopQrPoll();
      document.querySelectorAll('#wizard-screen .wiz-step').forEach(s => {
        s.hidden = s.dataset.step !== name;
      });
      if (name === 'pin-enter') {
        pinEnter?.clear(); setErr('pin-enter', '');
        document.getElementById('wpe-forgot-ok').hidden = true;
      } else if (name === 'pin-set') {
        pinSet?.clear(); pinSetConf?.clear(); setErr('pin-set', '');
        const h = document.getElementById('wps-hint'); if (h) h.hidden = true;
        const b = document.getElementById('wps-next'); if (b) b.disabled = true;
      } else if (name === 'pin-reset') {
        pinReset?.clear(); pinResetConf?.clear(); setErr('pin-reset', '');
        const h = document.getElementById('wpr-hint'); if (h) h.hidden = true;
        const b = document.getElementById('wpr-next'); if (b) b.disabled = true;
      }
      const labels = { phone: t('wiz.prog.phone'), api: t('wiz.prog.api'), code: t('wiz.prog.code'), '2fa': t('wiz.prog.2fa'), chat: t('wiz.prog.chat') };
      const el = document.getElementById('wiz-progress');
      if (el) el.textContent = name === 'sync' ? '' : `${t('wiz.step')} ${labels[name] || ''}`;
    }

    function setErr(stepKey, msg) {
      const el = document.getElementById({ phone:'wp-err', api:'wa-err', code:'wc-err', '2fa':'wt-err', chat:'wch-err', 'pin-enter':'wpe-err', 'pin-set':'wps-err', 'pin-reset':'wpr-err', method:'wm-err' }[stepKey]);
      if (!el) return;
      if (msg) { el.textContent = msg; el.hidden = false; }
      else     { el.hidden = true; }
    }

    // Paso 1: teléfono → check-phone → API (si nuevo) o send-code (si vuelve)
    document.getElementById('wp-next').addEventListener('click', async () => {
      setErr('phone', '');
      const v = document.getElementById('wp-phone').value.trim();
      if (!/^\+?\d{6,}$/.test(v)) { setErr('phone', t('wiz.phone.invalid')); return; }
      phone = v;
      const btn = document.getElementById('wp-next');
      btn.disabled = true; btn.textContent = t('wiz.phone.checking');
      try {
        const r = await fetch(`${BASE}/api/auth/check-phone`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ phone })
        }).then(x => x.json());
        if (r.exists && r.has_session) {
          isNewUser = false;
          const ql = await fetch(`${BASE}/api/auth/quick-login`, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ phone })
          }).then(x => x.json());
          if (ql.needsPin) {
            showStep('pin-enter');
            pinEnter.focus();
            return;
          }
          if (ql.needsPinSetup) {
            // Sesión TG válida pero sin PIN — crear PIN sin OTP
            setupTempId = ql.setupTempId;
            showStep('pin-set');
            pinSet.focus();
            return;
          }
          // Sesión TG inválida — mostrar selección de método
          showMethodSelectFresh();
        } else if (r.exists && r.has_credentials) {
          isNewUser = false;
          showMethodSelectFresh();
        } else {
          isNewUser = true;
          showStep('api');
        }
      } catch (err) {
        setErr('phone', err.message);
      } finally {
        btn.disabled = false; btn.textContent = t('wiz.phone.continue');
      }
    });

    // Paso 2 (solo nuevos): API ID + Hash → enviar código
    document.getElementById('wa-next').addEventListener('click', async () => {
      setErr('api', '');
      const id = document.getElementById('wa-id').value.trim();
      const h  = document.getElementById('wa-hash').value.trim();
      if (!id || isNaN(parseInt(id, 10))) { setErr('api', t('wiz.api.invalidId')); return; }
      if (!/^[0-9a-f]{32}$/i.test(h))     { setErr('api', t('wiz.api.invalidHash')); return; }
      apiId = id; apiHash = h;
      showMethodSelectFresh();
    });

    async function sendCode() {
      const wpBtn = document.getElementById('wp-next');
      const waBtn = document.getElementById('wa-next');
      if (wpBtn) { wpBtn.disabled = true; }
      if (waBtn) { waBtn.disabled = true; waBtn.textContent = t('wiz.api.sending'); }
      try {
        const body = { phone };
        if (isNewUser && apiId && apiHash) { body.apiId = apiId; body.apiHash = apiHash; }
        const r = await fetch(`${BASE}/api/auth/send-code`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify(body)
        }).then(x => x.json());
        if (!r.ok) {
          if (r.floodId) {
            floodId = r.floodId;
            showMethodSelectFlood(r.waitSecs || 0);
            return;
          }
          throw new Error(r.error || 'Error');
        }
        tempId = r.tempId;
        showStep('code');
      } catch (err) {
        const errStep = document.querySelector('.wiz-step[data-step="verify-method"]:not([hidden])') ? 'method' : isNewUser ? 'api' : 'phone';
        setErr(errStep, err.message);
        throw err;
      } finally {
        if (wpBtn) { wpBtn.disabled = false; }
        if (waBtn) { waBtn.disabled = false; waBtn.textContent = t('wiz.api.sendCode'); }
      }
    }

    // Paso código
    document.getElementById('wc-next').addEventListener('click', async () => {
      setErr('code', '');
      const code = document.getElementById('wc-code').value.replace(/\s/g, '');
      if (!code) { setErr('code', t('wiz.code.missing')); return; }
      const btn = document.getElementById('wc-next');
      btn.disabled = true; btn.textContent = t('wiz.code.verifying');
      try {
        const r = await fetch(`${BASE}/api/auth/verify-code`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ tempId, code })
        }).then(x => x.json());
        if (r.needs2fa) { showStep('2fa'); return; }
        if (!r.ok) throw new Error(r.error || 'Error');
        if (r.needsPin) { setupTempId = r.setupTempId; showStep('pin-set'); pinSet.focus(); return; }
        await afterAuth(r.has_chat);
      } catch (err) {
        setErr('code', err.message);
      } finally {
        btn.disabled = false; btn.textContent = t('wiz.code.verify');
      }
    });

    // Paso 2FA
    document.getElementById('wt-next').addEventListener('click', async () => {
      setErr('2fa', '');
      const password = document.getElementById('wt-pass').value;
      if (!password) { setErr('2fa', t('wiz.2fa.missing')); return; }
      const btn = document.getElementById('wt-next');
      btn.disabled = true; btn.textContent = t('wiz.2fa.verifying');
      try {
        const r = await fetch(`${BASE}/api/auth/verify-2fa`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ tempId, password })
        }).then(x => x.json());
        if (!r.ok) throw new Error(r.error || 'Error');
        if (r.needsPin) { setupTempId = r.setupTempId; showStep('pin-set'); pinSet.focus(); return; }
        await afterAuth(r.has_chat);
      } catch (err) {
        setErr('2fa', err.message);
      } finally {
        btn.disabled = false; btn.textContent = t('wiz.2fa.verify');
      }
    });

    // ── PIN enter (quick-login) ───────────────────────────────────────────
    const pinEnter = bindPinBoxes('wpe-inputs', null);
    document.getElementById('wpe-next').addEventListener('click', async () => {
      setErr('pin-enter', '');
      const pin = pinEnter.value;
      if (pin.length !== 4) { setErr('pin-enter', t('pin.enter.digits')); return; }
      const btn = document.getElementById('wpe-next');
      btn.disabled = true; btn.textContent = t('wiz.code.verifying');
      try {
        const remember = document.getElementById('wpe-remember')?.checked !== false;
        const r = await fetch(`${BASE}/api/auth/verify-pin`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ phone, pin, remember })
        }).then(x => x.json());
        if (!r.ok) throw new Error(r.error || t('pin.enter.wrong'));
        await afterAuth(r.has_chat);
      } catch (err) {
        setErr('pin-enter', err.message);
        pinEnter.clear();
      } finally {
        btn.disabled = false; btn.textContent = t('pin.enter.btn');
      }
    });

    document.getElementById('wpe-forgot').addEventListener('click', async () => {
      const btn = document.getElementById('wpe-forgot');
      btn.disabled = true; btn.textContent = t('wiz.api.sending');
      try {
        await fetch(`${BASE}/api/auth/forgot-pin`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ phone })
        });
        document.getElementById('wpe-forgot-ok').hidden = false;
      } finally {
        btn.disabled = false; btn.textContent = t('pin.enter.forgot');
      }
    });

    // ── PIN set (first time, after OTP) ──────────────────────────────────
    const pinSet     = bindPinBoxes('wps-inputs', updatePinSetBtn);
    const pinSetConf = bindPinBoxes('wps-confirm-inputs', updatePinSetBtn);
    function updatePinSetBtn() { updatePinBtn(pinSet, pinSetConf, 'wps-hint', 'wps-next'); }
    document.getElementById('wps-next').addEventListener('click', async ev => {
      setErr('pin-set', '');
      const pin = pinSet.value, conf = pinSetConf.value;
      if (pin !== conf) { setErr('pin-set', t('pin.mismatch')); return; }
      if (pinHint(pin)) { setErr('pin-set', pinHint(pin)); return; }
      const btn = ev.currentTarget;
      btn.disabled = true; btn.textContent = t('pin.saving');
      try {
        const r = await fetch(`${BASE}/api/auth/setup-pin`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ setupTempId, pin })
        }).then(x => x.json());
        if (!r.ok) throw new Error(r.error || 'Error');
        await afterAuth(r.has_chat);
      } catch (err) {
        setErr('pin-set', err.message);
        btn.disabled = false; btn.textContent = t('pin.set.btn');
      }
    });

    // ── PIN reset (via Telegram link) ─────────────────────────────────────
    const pinReset     = bindPinBoxes('wpr-inputs', updatePinResetBtn);
    const pinResetConf = bindPinBoxes('wpr-confirm-inputs', updatePinResetBtn);
    function updatePinResetBtn() { updatePinBtn(pinReset, pinResetConf, 'wpr-hint', 'wpr-next'); }
    document.getElementById('wpr-next').addEventListener('click', async ev => {
      setErr('pin-reset', '');
      const pin = pinReset.value, conf = pinResetConf.value;
      if (pin !== conf) { setErr('pin-reset', t('pin.mismatch')); return; }
      if (pinHint(pin)) { setErr('pin-reset', pinHint(pin)); return; }
      const btn = ev.currentTarget;
      btn.disabled = true; btn.textContent = t('pin.saving');
      try {
        const r = await fetch(`${BASE}/api/auth/reset-pin`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ token: pinResetToken, pin })
        }).then(x => x.json());
        if (!r.ok) throw new Error(r.error || 'Error');
        await afterAuth(r.has_chat);
      } catch (err) {
        setErr('pin-reset', err.message);
        btn.disabled = false; btn.textContent = t('pin.reset.btn');
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

    // ── Method selection + QR login ───────────────────────────────────────────
    function floodWaitLabel(secs) {
      const hrs = Math.ceil(secs / 3600), mins = Math.ceil(secs / 60);
      return secs >= 3600 ? `${hrs}h` : `${mins} min`;
    }

    function showMethodSelectFresh() {
      floodId = '';
      const card = document.getElementById('wm-otp-card');
      card.classList.replace('method-card--off', 'method-card--on');
      document.getElementById('wm-otp-sub').textContent = t('method.otp.sub');
      setErr('method', '');
      showStep('verify-method');
    }

    function showMethodSelectFlood(waitSecs) {
      const card = document.getElementById('wm-otp-card');
      card.classList.replace('method-card--on', 'method-card--off');
      document.getElementById('wm-otp-sub').textContent = t('method.otp.flood', { wait: floodWaitLabel(waitSecs) });
      setErr('method', '');
      showStep('verify-method');
    }

    let otpCardBusy = false;
    document.getElementById('wm-otp-card').addEventListener('click', async () => {
      const card = document.getElementById('wm-otp-card');
      if (card.classList.contains('method-card--off') || otpCardBusy) return;
      otpCardBusy = true;
      card.classList.add('method-card--busy');
      try { await sendCode(); }
      catch { /* error shown in wm-err */ }
      finally { otpCardBusy = false; card.classList.remove('method-card--busy'); }
    });
    document.getElementById('wm-otp-card').addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); document.getElementById('wm-otp-card').click(); }
    });

    function stopQrPoll() {
      clearTimeout(qrPollTimer); qrPollTimer = null;
    }

    function setQrSpinner(visible) {
      const sp = document.getElementById('wqr-spinner');
      if (sp) sp.hidden = !visible;
    }

    function setQrErr(msg) {
      const el = document.getElementById('wqr-err');
      if (!el) return;
      el.textContent = msg; el.hidden = !msg;
    }

    async function startQrLogin() {
      setQrErr('');
      setQrSpinner(true);
      document.getElementById('wqr-img').src = '';
      try {
        const qrBody = floodId ? { floodId } : (isNewUser ? { phone, apiId, apiHash } : { phone });
        const r = await fetch(`${BASE}/api/auth/qr-start`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(qrBody)
        }).then(x => x.json());
        if (!r.ok) throw new Error(r.error || 'Error');
        qrTempId = r.tempId;
        document.getElementById('wqr-img').src = r.qrImg;
        setQrSpinner(false);
        scheduleQrPoll(r.expiresAt);
      } catch (err) {
        setQrSpinner(false);
        setQrErr(t('qr.error') + ': ' + err.message);
      }
    }

    function scheduleQrPoll(expiresAt) {
      stopQrPoll();
      const now = Math.floor(Date.now() / 1000);
      const delay = expiresAt ? Math.max(1000, (expiresAt - now - 4) * 1000) : 3000;
      qrPollTimer = setTimeout(() => pollQr(), Math.min(delay, 25000));
    }

    async function pollQr() {
      const step = document.querySelector('.wiz-step[data-step="qr-login"]');
      if (!step || step.hidden) return;
      try {
        const r = await fetch(`${BASE}/api/auth/qr-poll/${qrTempId}`).then(x => x.json());
        if (r.error) throw new Error(r.error);
        if (r.status === 'success') { await afterAuth(r.has_chat); return; }
        if (r.status === 'needs_pin') { setupTempId = r.setupTempId; showStep('pin-set'); pinSet.focus(); return; }
        if (r.qrImg) document.getElementById('wqr-img').src = r.qrImg;
        scheduleQrPoll(r.expiresAt);
      } catch (err) {
        setQrErr(t('qr.error') + ': ' + err.message);
      }
    }

    document.getElementById('wm-qr-card').addEventListener('click', () => {
      showStep('qr-login');
      startQrLogin();
    });
    document.getElementById('wm-qr-card').addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); document.getElementById('wm-qr-card').click(); }
    });
    document.getElementById('wqr-back').addEventListener('click', () => showStep('verify-method'));

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
      ul.innerHTML = `<li class="muted small">${t('wiz.chat.loading')}</li>`;
      try {
        const list = await fetch(`${BASE}/api/me/dialogs`).then(r => r.json());
        if (!Array.isArray(list)) throw new Error(list.error || 'Error');
        if (!list.length) { ul.innerHTML = `<li class="muted small">${t('wiz.chat.empty')}</li>`; return; }
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
      if (!title) { setErr('chat', t('wiz.chat.enterName')); return; }
      const btn = document.getElementById('wch-create');
      btn.disabled = true; btn.textContent = t('wiz.chat.creating');
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
        btn.disabled = false; btn.textContent = t('wiz.chat.create');
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
      stats.textContent = t('wiz.sync.connecting');

      let started = false;
      if (syncTimer) clearInterval(syncTimer);
      syncTimer = setInterval(async () => {
        try {
          const s = await fetch(`${BASE}/api/me/sync-status`).then(r => r.json());
          if (s.running || started) {
            started = true;
            const pct = s.scanned ? Math.min(99, Math.round((s.scanned / 2000) * 100)) : 5;
            bar.style.width = pct + '%';
            stats.textContent = t('wiz.sync.scanning', { scanned: s.scanned, imported: s.imported });
          }
          if (s.done) {
            clearInterval(syncTimer); syncTimer = null;
            bar.style.width = '100%';
            stats.textContent = t('wiz.sync.done', { imported: s.imported, scanned: s.scanned });
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
      loadBrowse(getPathFromHash());
    });

    return { showStep, startSyncMonitor, startPinReset(token) { pinResetToken = token; showStep('pin-reset'); pinReset.focus(); } };
  })();

  // ═════════════════════════════════════════════════════════════════════════
  // Auth state UI
  // ═════════════════════════════════════════════════════════════════════════
  function showWizard() {
    closeSettings();
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

      // PIN reset link detection
      const pinResetMatch = location.hash.match(/^#pin-reset=([a-f0-9]+)$/i);
      if (pinResetMatch) {
        history.replaceState(null, '', location.pathname);
        showWizard();
        WIZ.startPinReset(pinResetMatch[1]);
        return;
      }

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
      loadBrowse(getPathFromHash());
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
  // Settings page
  // ═════════════════════════════════════════════════════════════════════════
  function openModal(id) { const m=document.getElementById(id); m.hidden=false; m.setAttribute('aria-hidden','false'); }
  function closeModal(id){ const m=document.getElementById(id); m.hidden=true;  m.setAttribute('aria-hidden','true'); }

  function openSettings() {
    closeDropdown();
    document.getElementById('settings-screen').hidden = false;
    document.getElementById('settings-screen').setAttribute('aria-hidden', 'false');
    refreshSettings();
  }
  function closeSettings() {
    document.getElementById('settings-screen').hidden = true;
    document.getElementById('settings-screen').setAttribute('aria-hidden', 'true');
  }

  document.getElementById('settings-dropdown-btn').addEventListener('click', openSettings);
  document.getElementById('settings-back-btn').addEventListener('click', closeSettings);

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
    if (!apiId || isNaN(parseInt(apiId, 10)))   { errEl.textContent = t('cfg.creds.invalidId'); errEl.hidden = false; return; }
    if (!/^[0-9a-f]{32}$/i.test(apiHash))       { errEl.textContent = t('cfg.creds.invalidHash'); errEl.hidden = false; return; }
    if (!confirm(t('dlg.changeCreds'))) return;
    const btn = document.getElementById('set-creds-save');
    btn.disabled = true; btn.textContent = t('cfg.creds.saving');
    try {
      await api('POST', `${BASE}/api/me/update-credentials`, { apiId, apiHash });
      location.hash = '';
      closeSettings();
      showWizard();
    } catch (err) {
      errEl.textContent = err.message; errEl.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = t('cfg.creds.save');
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
      showCfgMsg('set-ttl-msg', t('cfg.ttl.saved', { n: days }), 'var(--ok)');
    } catch (err) {
      showCfgMsg('set-ttl-msg', 'Error: ' + err.message, 'var(--err)');
    }
  });

  function updateTgStatusUI(status, error) {
    const dot = document.getElementById('tg-status-dot');
    const text = document.getElementById('tg-status-text');
    const errEl = document.getElementById('tg-status-error');
    const map = {
      connected:      { cls: 'dot-ok',   label: t('cfg.tg.connected') },
      idle:           { cls: 'dot-warn', label: t('cfg.tg.idle') },
      no_chat:        { cls: 'dot-off',  label: t('cfg.tg.noChat') },
      no_session:     { cls: 'dot-err',  label: t('cfg.tg.noSession') },
      session_expired:{ cls: 'dot-err',  label: t('cfg.tg.expired') },
      disconnected:   { cls: 'dot-off',  label: t('cfg.tg.disconnected') },
      error:          { cls: 'dot-err',  label: t('cfg.tg.error') },
    };
    const info = map[status] || { cls: 'dot-off', label: status || '—' };
    dot.className = 'status-dot ' + info.cls;
    text.textContent = info.label;
    if (error) { errEl.textContent = error; errEl.hidden = false; }
    else        { errEl.hidden = true; }
  }

  document.getElementById('tg-reconnect-btn').addEventListener('click', async () => {
    const btn = document.getElementById('tg-reconnect-btn');
    btn.disabled = true; btn.textContent = t('cfg.tg.reconnecting');
    try {
      const r = await fetch(`${BASE}/api/me/reconnect`, { method: 'POST' }).then(x => x.json());
      updateTgStatusUI(r.tg_status || (r.ok ? 'connected' : 'error'), r.tg_error);
    } finally {
      btn.disabled = false; btn.textContent = t('cfg.tg.reconnect');
    }
  });

  async function loadSettingsDialogs() {
    const ul = document.getElementById('set-chat-list');
    ul.innerHTML = `<li class="muted small">${t('cfg.chan.loading')}</li>`;
    try {
      const list = await api('GET', `${BASE}/api/me/dialogs`);
      if (!list.length) { ul.innerHTML = `<li class="muted small">${t('cfg.chan.empty')}</li>`; return; }
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
          if (!confirm(t('dlg.changeChan', { name: li.querySelector('.chat-pick-name').textContent }))) return;
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
    btn.disabled = true; btn.textContent = t('cfg.chan.creating');
    document.getElementById('set-chat-err').hidden = true;
    try {
      const r = await api('POST', `${BASE}/api/me/create-channel`, { title });
      await selectChat(r.id);
    } catch (e) {
      const errEl = document.getElementById('set-chat-err');
      errEl.textContent = e.message; errEl.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = t('cfg.chan.createBtn');
    }
  });

  function showCfgMsg(id, text, color) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.style.color = color || 'var(--ok)';
    el.hidden = false;
  }

  async function selectChat(chatId) {
    showCfgMsg('set-chat-msg', t('cfg.chan.changing'), 'var(--muted)');
    try {
      await api('POST', `${BASE}/api/me/select-chat`, { tg_chat: chatId });
      showCfgMsg('set-chat-msg', t('cfg.chan.changed'), 'var(--ok)');
      await refreshSettings();
      monitorSyncInSettings();
      setTimeout(() => loadBrowse(''), 800);
    } catch (e) {
      showCfgMsg('set-chat-msg', 'Error: ' + e.message, 'var(--err)');
    }
  }

  document.getElementById('trigger-sync').addEventListener('click', async () => {
    await api('POST', `${BASE}/api/me/sync`);
    showCfgMsg('sync-msg', t('cfg.sync.syncing'), 'var(--muted)');
    monitorSyncInSettings();
  });

  let settingsSyncTimer = null;
  function monitorSyncInSettings() {
    const wrap = document.getElementById('sync-progress-wrap');
    const bar = document.getElementById('sync-progress-bar');
    wrap.hidden = false; bar.style.width = '0%';
    if (settingsSyncTimer) clearInterval(settingsSyncTimer);
    settingsSyncTimer = setInterval(async () => {
      try {
        const s = await api('GET', `${BASE}/api/me/sync-status`);
        const pct = s.scanned ? Math.min(99, Math.round((s.scanned / 2000) * 100)) : 5;
        bar.style.width = pct + '%';
        showCfgMsg('sync-msg', t('cfg.sync.progress', { n: s.scanned, m: s.imported }), 'var(--muted)');
        if (s.done) {
          clearInterval(settingsSyncTimer); settingsSyncTimer = null;
          bar.style.width = '100%';
          showCfgMsg('sync-msg', t('cfg.sync.done', { n: s.imported, m: s.scanned }), 'var(--ok)');
          loadBrowse(currentPath, true);
        }
        if (s.error) {
          clearInterval(settingsSyncTimer); settingsSyncTimer = null;
          showCfgMsg('sync-msg', 'Error: ' + s.error, 'var(--err)');
        }
      } catch { /* keep */ }
    }, 1000);
  }

  // Tabs select / create en settings
  document.querySelectorAll('#settings-screen .chat-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const wrap = tab.closest('.cfg-card-body');
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
      if (!document.getElementById('settings-screen').hidden) { closeSettings(); return; }
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
  let selectionMode = false;

  function renderBulkBar() {
    const bar    = document.getElementById('bulk-bar');
    const count  = document.getElementById('bulk-count');
    const allCb  = document.getElementById('select-all');
    const lbl    = document.getElementById('select-all-label');
    const delBtn = document.getElementById('bulk-delete');
    const zipBtn = document.getElementById('bulk-zip');
    const total  = currentEntries.length;
    const sel    = selected.size;
    bar.hidden = selected.size === 0;
    count.textContent  = sel === 0 ? t('bulk.sel0') : sel === 1 ? t('bulk.sel1') : t('bulk.selN', { n: sel });
    allCb.checked      = total > 0 && sel === total;
    allCb.indeterminate = sel > 0 && sel < total;
    lbl.textContent    = (sel === total && total > 0) ? t('bulk.deselectAll') : t('bulk.selectAll');
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

  function enterSelectionMode(li, key) {
    selectionMode = true;
    document.getElementById('file-list').classList.add('selection-mode');
    const cb = li.querySelector('.row-check');
    if (cb && !cb.checked) {
      cb.checked = true;
      selected.add(key);
      li.classList.add('is-selected');
    }
    renderBulkBar();
  }

  function exitSelectionMode() {
    selectionMode = false;
    document.getElementById('file-list').classList.remove('selection-mode');
    selected.clear();
    document.querySelectorAll('.row-check').forEach(cb => {
      cb.checked = false;
      cb.closest('li')?.classList.remove('is-selected');
    });
    const allCb = document.getElementById('select-all');
    if (allCb) { allCb.checked = false; allCb.indeterminate = false; }
    renderBulkBar();
  }

  document.getElementById('cancel-selection-btn').addEventListener('click', exitSelectionMode);

  // ═════════════════════════════════════════════════════════════════════════
  // Browser / breadcrumbs / rows
  // ═════════════════════════════════════════════════════════════════════════
  function renderCrumbs(p, crumbs) {
    const parts = p ? p.split('/').filter(Boolean) : [];
    const el = document.getElementById('crumbs');
    const html = [`<button class="crumb" data-go="" data-fid="">${t('nav.root')}</button>`];
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
        if (ev.dataTransfer.types.includes('application/x-cloud-items')) {
          ev.preventDefault(); b.classList.add('drop-target');
        }
      });
      b.addEventListener('dragover', ev => {
        if (ev.dataTransfer.types.includes('application/x-cloud-items')) {
          ev.preventDefault(); ev.dataTransfer.dropEffect = 'move';
        }
      });
      b.addEventListener('dragleave', () => b.classList.remove('drop-target'));
      b.addEventListener('drop', async ev => {
        if (!ev.dataTransfer.types.includes('application/x-cloud-items')) return;
        ev.preventDefault();
        b.classList.remove('drop-target');
        let items; try { items = JSON.parse(ev.dataTransfer.getData('application/x-cloud-items')); } catch { return; }
        const targetFid = b.dataset.fid === '' ? null : Number(b.dataset.fid);
        for (const item of items) {
          if (item.type === 'dir' && item.id === targetFid) continue;
          await moveItem(item, targetFid);
        }
      });
    });
  }

  let _browseAbortCtrl = null;

  async function loadBrowse(p, fromHistory = false) {
    clearDedupState();
    if (selectionMode) exitSelectionMode();
    currentPath = p || '';
    const newHash = pathToHash(currentPath);
    if (!fromHistory) {
      history.pushState({ path: currentPath }, '', location.pathname + (newHash || ''));
      if (currentPath === '') {
        _navStack = [''];
        _navIdx = 0;
        _updateNavBtns();
      } else {
        _navPush(currentPath);
      }
    } else {
      history.replaceState({ path: currentPath }, '', location.pathname + (newHash || ''));
      if (currentPath === '') {
        _navStack = [''];
        _navIdx = 0;
      }
      _updateNavBtns();
    }
    selected.clear();
    renderBulkBar();
    setBrowserStatus(t('browser.loading'));
    document.getElementById('file-list').innerHTML = `<li class="empty muted">${t('browser.loading')}</li>`;

    if (_browseAbortCtrl) _browseAbortCtrl.abort();
    _browseAbortCtrl = new AbortController();
    const signal = _browseAbortCtrl.signal;

    let data;
    try {
      data = await api('GET', `${BASE}/api/browse?path=${encodeURIComponent(currentPath)}`, undefined, signal);
    } catch (err) {
      if (err.name === 'AbortError') return;
      document.getElementById('file-list').innerHTML = `<li class="empty">Error: ${esc(err.message)}</li>`;
      setBrowserStatus(''); currentEntries = []; renderBulkBar();
      renderCrumbs(currentPath, []); return;
    }
    renderCrumbs(currentPath, data.crumbs || []);
    currentFolderId = data.folder_id ?? null;

    currentEntries = [
      ...data.dirs.map(d => ({ type: 'dir',  ...d })),
      ...data.files.map(f => ({ type: 'file', ...f })),
    ];

    if (!currentEntries.length) {
      document.getElementById('file-list').innerHTML = `<li class="empty muted">${t('browser.empty')}</li>`;
    } else {
      document.getElementById('file-list').innerHTML = currentEntries.map(renderRow).join('');
      bindRowEvents();
    }
    setBrowserStatus(t('browser.status', { dirs: data.dirs.length, files: data.files.length }));
    renderBulkBar();
  }

  function renderRow(e) {
    const key = `${e.type[0]}:${e.id}`;
    if (e.type === 'dir') {
      return `<li class="row${e.share_token ? ' is-shared' : ''}" data-type="dir" data-id="${e.id}" data-key="${key}"
               data-name="${esc(e.name)}" data-share-token="${esc(e.share_token || '')}"
               data-share-expires="${e.share_expires_at || ''}" data-share-dur="${e.share_duration ?? 0}">
        <input type="checkbox" class="row-check" />
        <span class="row-icon">${ic('folder')}</span>
        <div class="row-main">
          <div class="row-name">${esc(e.name)}${e.share_token ? ` <span class="share-badge">${t('row.shared')}</span>` : ''}</div>
          <div class="row-sub">${fmtDate(e.created_at)}</div>
        </div>
        <span class="row-meta">${t('row.folder')}</span>
        <span class="row-actions">
          <button class="iconbtn" data-act="zip"    title="${t('row.zip')}">${ic('zip')}</button>
          <button class="iconbtn" data-act="share"  title="${t('row.share')}">${ic('share')}</button>
          <button class="iconbtn" data-act="rename" title="${t('row.rename')}">${ic('rename')}</button>
          <button class="iconbtn" data-act="delete" title="${t('row.delete')}">${ic('delete')}</button>
        </span>
      </li>`;
    }
    const fallback = esc(fileIcon(e.mime_type, e.name));
    const thumbHtml = `<img class="row-thumb" src="${BASE}/api/thumb?id=${e.id}" alt="" loading="lazy"
      onerror="this.onerror=null;this.outerHTML='<span class=\\'row-icon\\'>${fallback}</span>'" />`;
    return `<li class="row${e.share_token ? ' is-shared' : ''}" data-type="file" data-id="${e.id}" data-key="${key}"
               data-name="${esc(e.name)}" data-mime="${esc(e.mime_type)}" data-size="${e.size}"
               data-share-token="${esc(e.share_token || '')}" data-share-expires="${e.share_expires_at || ''}" data-share-dur="${e.share_duration ?? 0}">
      <input type="checkbox" class="row-check" />
      ${thumbHtml}
      <div class="row-main">
        <div class="row-name">${esc(e.name)}${e.share_token ? ` <span class="share-badge">${t('row.shared')}</span>` : ''}</div>
        <div class="row-sub">${fmtDate(e.created_at)}${e.chunk_count > 1 ? t('row.parts', { n: e.chunk_count }) : ''}</div>
      </div>
      <span class="row-meta">${fmtSize(e.size)}</span>
      <span class="row-actions">
        <button class="iconbtn" data-act="download"      title="${t('row.download')}">${ic('download')}</button>
        ${canTranscode(e.mime_type, e.name) ? `<button class="iconbtn" data-act="download-lite" title="${t('row.downloadLite')}">${ic('dl-lite')}</button>` : ''}
        <button class="iconbtn" data-act="share"         title="${t('row.share')}">${ic('share')}</button>
        <button class="iconbtn" data-act="rename"        title="${t('row.rename')}">${ic('rename')}</button>
        <button class="iconbtn" data-act="delete"        title="${t('row.delete')}">${ic('delete')}</button>
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

      let longPressHappened = false;
      let pressTimer = null;
      let dragTimer   = null;
      let dragArmed   = false;
      let pressX = 0, pressY = 0;
      let touchDragActive = false;
      let lastTouchTime = 0;
      let dragGhost = null;

      const removeDragGhost = () => { if (dragGhost) { dragGhost.remove(); dragGhost = null; } };
      const moveDragGhost   = (x, y) => { if (dragGhost) dragGhost.style.transform = `translate(${x + 18}px,${y - 44}px)`; };
      const createDragGhost = (x, y) => {
        removeDragGhost();
        dragGhost = document.createElement('div');
        dragGhost.className = 'touch-drag-ghost';
        const multiCount = selectionMode && selected.has(key) && selected.size > 1 ? selected.size : 0;
        if (multiCount > 1) {
          dragGhost.innerHTML = `<span class="tdg-icon">${ic('package')}</span><span class="tdg-name">${multiCount} ${t('drag.items')}</span><span class="tdg-badge">${multiCount}</span>`;
          dragGhost.classList.add('tdg-multi');
        } else {
          const icon = type === 'dir' ? ic('folder') : fileIconSvg(mime_t, name);
          dragGhost.innerHTML = `<span class="tdg-icon">${icon}</span><span class="tdg-name">${esc(name)}</span>`;
        }
        document.body.appendChild(dragGhost);
        moveDragGhost(x, y);
      };

      const cancelPress = () => {
        clearTimeout(pressTimer); pressTimer = null;
        clearTimeout(dragTimer);  dragTimer  = null;
        dragArmed = false;
        li.classList.remove('pressing');
      };

      // ── Touch handlers (mobile) ──────────────────────────────────────────
      li.addEventListener('touchstart', ev => {
        if (ev.target.closest('.row-actions')) return;
        lastTouchTime = Date.now();
        const t = ev.touches[0];
        longPressHappened = false;
        touchDragActive   = false;
        dragArmed         = false;
        pressX = t.clientX; pressY = t.clientY;
        clearTimeout(pressTimer); clearTimeout(dragTimer);
        li.classList.add('pressing');

        dragTimer = setTimeout(() => { dragTimer = null; dragArmed = true; }, 200);

        pressTimer = setTimeout(() => {
          pressTimer = null;
          longPressHappened = true;
          dragArmed = false;
          li.classList.remove('pressing');
          navigator.vibrate?.(40);
          enterSelectionMode(li, key);
        }, 900);
      });

      li.addEventListener('touchmove', ev => {
        const t     = ev.touches[0];
        const moved = Math.hypot(t.clientX - pressX, t.clientY - pressY);

        if (moved < 4) return; // jitter

        if (touchDragActive) {
          ev.preventDefault();
          moveDragGhost(t.clientX, t.clientY);
          document.querySelectorAll('.row.drop-target').forEach(el => el.classList.remove('drop-target'));
          const elUnder = document.elementFromPoint(t.clientX, t.clientY);
          const tgt = elUnder?.closest('.row[data-type="dir"]');
          if (tgt && tgt !== li) tgt.classList.add('drop-target');
          return;
        }

        if (longPressHappened) {
          ev.preventDefault();
          touchDragActive = true;
          li.classList.add('dragging');
          createDragGhost(t.clientX, t.clientY);
          return;
        }

        if (dragArmed) {
          clearTimeout(pressTimer); pressTimer = null;
          ev.preventDefault();
          touchDragActive = true;
          li.classList.add('dragging');
          li.classList.remove('pressing');
          createDragGhost(t.clientX, t.clientY);
          document.querySelectorAll('.row.drop-target').forEach(el => el.classList.remove('drop-target'));
          const elUnder = document.elementFromPoint(t.clientX, t.clientY);
          const tgt = elUnder?.closest('.row[data-type="dir"]');
          if (tgt && tgt !== li) tgt.classList.add('drop-target');
          return;
        }

        cancelPress();
      }, { passive: false });

      li.addEventListener('touchend', () => {
        if (!touchDragActive) { cancelPress(); return; }
        touchDragActive = false;
        removeDragGhost();
        document.querySelectorAll('.row.dragging').forEach(el => el.classList.remove('dragging'));
        const dropTarget = document.querySelector('.row.drop-target');
        document.querySelectorAll('.row.drop-target').forEach(el => el.classList.remove('drop-target'));
        cancelPress();
        if (!dropTarget || dropTarget === li) return;
        const targetId = Number(dropTarget.dataset.id);
        let dragItems;
        if (selectionMode && selected.has(key) && selected.size > 1) {
          dragItems = Array.from(selected).map(k => {
            const [t2, rawId] = k.split(':');
            const rowEl = document.querySelector(`[data-key="${k}"]`);
            return { type: t2 === 'f' ? 'file' : 'dir', id: Number(rawId), name: rowEl?.dataset.name || k };
          });
        } else {
          dragItems = [{ type, id, name }];
        }
        for (const item of dragItems) {
          if (item.type === 'dir' && item.id === targetId) continue;
          moveItem(item, targetId);
        }
      });

      li.addEventListener('touchcancel', () => {
        cancelPress();
        touchDragActive = false;
        removeDragGhost();
        document.querySelectorAll('.row.dragging').forEach(el => el.classList.remove('dragging'));
        document.querySelectorAll('.row.drop-target').forEach(el => el.classList.remove('drop-target'));
      });

      // ── Mouse handlers (desktop, ignora eventos sintéticos post-touch) ───
      li.addEventListener('mousedown', ev => {
        if (Date.now() - lastTouchTime < 700) return;
        if (ev.button !== 0 || ev.target.closest('.row-actions')) return;
        longPressHappened = false;
        pressX = ev.clientX; pressY = ev.clientY;
        clearTimeout(pressTimer);
        li.classList.add('pressing');
        pressTimer = setTimeout(() => {
          pressTimer = null;
          longPressHappened = true;
          li.classList.remove('pressing');
          enterSelectionMode(li, key);
        }, 600);
      });
      li.addEventListener('mouseup',    () => { if (Date.now() - lastTouchTime < 700) return; cancelPress(); });
      li.addEventListener('mouseleave', () => { if (Date.now() - lastTouchTime < 700) return; cancelPress(); });
      li.addEventListener('mousemove',  ev => {
        if (Date.now() - lastTouchTime < 700) return;
        if (!pressTimer) return;
        if (Math.hypot(ev.clientX - pressX, ev.clientY - pressY) > 15) cancelPress();
      });

      li.addEventListener('click', ev => {
        if (ev.target.closest('.row-actions, .row-check')) return;
        if (longPressHappened) { longPressHappened = false; return; }
        if (selectionMode) {
          const rowCb = li.querySelector('.row-check');
          if (rowCb) {
            rowCb.checked = !rowCb.checked;
            if (rowCb.checked) selected.add(key); else selected.delete(key);
            li.classList.toggle('is-selected', rowCb.checked);
            if (selected.size === 0) exitSelectionMode();
            else renderBulkBar();
          }
          return;
        }
        if (type === 'dir') loadBrowse(currentPath ? `${currentPath}/${name}` : name);
        else                openPreview(id, name, mime_t, Number(li.dataset.size), li.dataset.shareToken || null, li.dataset.shareExpires ? Number(li.dataset.shareExpires) : null, li.dataset.shareDur ? Number(li.dataset.shareDur) : 0);
      });

      li.draggable = navigator.maxTouchPoints === 0;
      li.addEventListener('dragstart', ev => {
        cancelPress();
        ev.dataTransfer.effectAllowed = 'move';
        let dragItems;
        if (selectionMode && selected.has(key) && selected.size > 1) {
          dragItems = Array.from(selected).map(k => {
            const [t, rawId] = k.split(':');
            const el = document.querySelector(`[data-key="${k}"]`);
            return { type: t === 'f' ? 'file' : 'dir', id: Number(rawId), name: el?.dataset.name || k };
          });
        } else {
          dragItems = [{ type, id, name }];
        }
        ev.dataTransfer.setData('application/x-cloud-items', JSON.stringify(dragItems));
        ev.dataTransfer.setData('text/plain', dragItems.map(i => i.name).join(', '));
        li.classList.add('dragging');
        if (selectionMode && selected.has(key)) {
          selected.forEach(k => {
            const el = document.querySelector(`[data-key="${k}"]`);
            if (el && el !== li) el.classList.add('dragging');
          });
        }
      });
      li.addEventListener('dragend', () => {
        document.querySelectorAll('.row.dragging').forEach(el => el.classList.remove('dragging'));
      });
      li.addEventListener('contextmenu', ev => { if (pressTimer || longPressHappened) ev.preventDefault(); });

      if (type === 'dir') {
        li.addEventListener('dragenter', ev => {
          if (ev.dataTransfer.types.includes('application/x-cloud-items')) {
            ev.preventDefault(); li.classList.add('drop-target');
          }
        });
        li.addEventListener('dragover', ev => {
          if (ev.dataTransfer.types.includes('application/x-cloud-items')) {
            ev.preventDefault(); ev.dataTransfer.dropEffect = 'move';
          }
        });
        li.addEventListener('dragleave', ev => {
          if (!li.contains(ev.relatedTarget)) li.classList.remove('drop-target');
        });
        li.addEventListener('drop', async ev => {
          if (!ev.dataTransfer.types.includes('application/x-cloud-items')) return;
          ev.preventDefault(); ev.stopPropagation();
          li.classList.remove('drop-target');
          let items; try { items = JSON.parse(ev.dataTransfer.getData('application/x-cloud-items')); } catch { return; }
          for (const item of items) {
            if (item.type === 'dir' && item.id === id) continue;
            await moveItem(item, id);
          }
        });
      }

      li.querySelectorAll('.iconbtn').forEach(btn => btn.addEventListener('click', ev => {
        ev.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'download')           triggerDownload(`${BASE}/api/stream?id=${id}&inline=0`, name);
        else if (act === 'download-lite') triggerDownload(`${BASE}/api/transcode?id=${id}`);
        else if (act === 'zip')           triggerDownload(`${BASE}/api/zip?id=${id}`, name + '.zip');
        else if (act === 'share') {
          const st = li.dataset.shareToken || null;
          const se = li.dataset.shareExpires ? Number(li.dataset.shareExpires) : null;
          const sd = li.dataset.shareDur    ? Number(li.dataset.shareDur)    : 0;
          openShareModal(id, name, st ? { token: st, expires_at: se, duration: sd } : null, type === 'dir');
        }
        else if (act === 'rename')        promptRename(type, id, name);
        else if (act === 'delete')        confirmDelete([{ type, id, name }]);
      }));
    });
  }

  async function moveItem(item, targetFolderId) {
    setBrowserStatus(t('act.moving', { name: item.name }));
    try {
      await api('POST', `${BASE}/api/move`, { type: item.type, id: item.id, targetFolderId });
      setBrowserStatus(t('act.moved'), 'ok');
      loadBrowse(currentPath, true);
    } catch (err) { setBrowserStatus(t('act.error', { e: err.message }), 'err'); }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Preview modal
  // ═════════════════════════════════════════════════════════════════════════
  let currentPreview = null;
  function openPreview(id, name, mimeType, size, shareToken = null, shareExpires = null, shareDuration = 0) {
    currentPreview = { id, name, mimeType, size, shareToken, shareExpires, shareDuration };
    const body = document.getElementById('preview-body');
    document.getElementById('preview-name').textContent = name;
    document.getElementById('preview-meta').textContent = fmtSize(size);
    document.getElementById('preview-download').onclick      = () => triggerDownload(`${BASE}/api/stream?id=${id}&inline=0`, name);
    document.getElementById('preview-download-lite').hidden  = !canTranscode(mimeType, name);
    document.getElementById('preview-download-lite').onclick = () => triggerDownload(`${BASE}/api/transcode?id=${id}`);

    const src = `${BASE}/api/stream?id=${id}&inline=1`;
    if (mimeType.startsWith('image/')) {
      body.innerHTML = `<img src="${esc(src)}" alt="${esc(name)}" />`;
    } else if (mimeType.startsWith('video/')) {
      body.innerHTML = `<video controls autoplay src="${esc(src)}"></video>`;
    } else if (isAudio(mimeType, name)) {
      body.innerHTML = `<div class="ap">
        <div class="ap-disc-wrap">
          <div class="ap-disc" id="ap-disc">
            <img class="ap-cover" src="${BASE}/api/thumb?id=${id}" alt=""
              onerror="this.style.display='none'">
          </div>
          <div class="ap-disc-center" id="ap-disc-center">${ic('music')}</div>
        </div>
        <div class="ap-info">
          <div class="ap-name">${esc(name)}</div>
          <div class="ap-size">${fmtSize(size)}</div>
        </div>
        <div class="ap-seek-row">
          <span class="ap-time" id="ap-cur">0:00</span>
          <input class="ap-range ap-seek-range" id="ap-seek" type="range" min="0" max="100" value="0" step="0.01">
          <span class="ap-time ap-time-r" id="ap-dur">--:--</span>
        </div>
        <div class="ap-btns">
          <button class="ap-play-btn" id="ap-play" aria-label="Reproducir/Pausar"><svg viewBox="-1 0 10 10" width="18" height="18" fill="currentColor" aria-hidden="true"><polygon points="1,0 9,5 1,10"/></svg></button>
        </div>
        <div class="ap-vol-row">
          <span class="ap-vol-icon">${ic('volume')}</span>
          <input class="ap-range ap-vol-range" id="ap-vol" type="range" min="0" max="1" step="0.01">
        </div>
        <audio id="ap-audio" src="${esc(src)}" autoplay></audio>
      </div>`;
      (function initAP() {
        const audio   = document.getElementById('ap-audio');
        const playBtn = document.getElementById('ap-play');
        const seekEl  = document.getElementById('ap-seek');
        const curEl   = document.getElementById('ap-cur');
        const durEl   = document.getElementById('ap-dur');
        const volEl   = document.getElementById('ap-vol');
        const disc    = document.getElementById('ap-disc');
        function fmt(s) {
          if (!isFinite(s)) return '--:--';
          return Math.floor(s/60) + ':' + String(Math.floor(s%60)).padStart(2,'0');
        }
        function fill(el) {
          const mn = +el.min||0, mx = +el.max||1, v = +el.value;
          el.style.setProperty('--val', ((v-mn)/(mx-mn)*100)+'%');
        }
        audio.volume = _apVol;
        volEl.value  = String(_apVol);
        fill(volEl);
        audio.addEventListener('loadedmetadata', () => { seekEl.max = audio.duration; durEl.textContent = fmt(audio.duration); fill(seekEl); });
        audio.addEventListener('timeupdate', () => { seekEl.value = audio.currentTime; curEl.textContent = fmt(audio.currentTime); fill(seekEl); });
        const SVG_PLAY  = `<svg viewBox="-1 0 10 10" width="18" height="18" fill="currentColor" aria-hidden="true"><polygon points="1,0 9,5 1,10"/></svg>`;
        const SVG_PAUSE = `<svg viewBox="0 0 10 10" width="18" height="18" fill="currentColor" aria-hidden="true"><rect x="1" y="0" width="3" height="10"/><rect x="6" y="0" width="3" height="10"/></svg>`;
        audio.addEventListener('play',  () => { playBtn.innerHTML = SVG_PAUSE; disc.classList.add('playing'); });
        audio.addEventListener('pause', () => { playBtn.innerHTML = SVG_PLAY;  disc.classList.remove('playing'); });
        audio.addEventListener('ended', () => { playBtn.innerHTML = SVG_PLAY;  disc.classList.remove('playing'); });
        playBtn.addEventListener('click', () => audio.paused ? audio.play() : audio.pause());
        seekEl.addEventListener('input', () => { audio.currentTime = +seekEl.value; fill(seekEl); });
        volEl.addEventListener('input', () => {
          _apVol = +volEl.value; audio.volume = _apVol; fill(volEl);
          try { localStorage.setItem('ap-vol', _apVol); } catch {}
        });
      })();
    } else if (isPdf(mimeType, name)) {
      body.innerHTML = `<embed src="${esc(src)}" type="application/pdf" />`;
    } else if (isText(mimeType, name)) {
      body.innerHTML = `<pre class="preview-text muted">${t('prev.textLoading')}</pre>`;
      const MAX = 500_000;
      fetch(src, { headers: { Range: `bytes=0-${MAX - 1}` } })
        .then(r => r.text())
        .then(text => {
          const truncated = size > MAX;
          body.innerHTML = `<pre class="preview-text">${esc(text)}</pre>` +
            (truncated ? `<div class="preview-truncated muted small">${t('prev.textTrunc', { size: fmtSize(MAX), total: fmtSize(size) })}</div>` : '');
        })
        .catch(err => { body.innerHTML = `<pre class="preview-text">Error: ${esc(err.message)}</pre>`; });
    } else if (isOffice(mimeType, name)) {
      body.innerHTML = `<div class="preview-file-info">
        <div class="preview-file-icon">${fileIconSvg(mimeType, name)}</div>
        <div class="preview-file-name">${esc(name)}</div>
        <div class="preview-file-size">${fmtSize(size)}</div>
        <p class="muted small" style="margin-top:14px;max-width:380px;line-height:1.5">
          ${t('prev.officeMsg')}
        </p>
      </div>`;
    } else {
      body.innerHTML = `<div class="preview-file-info">
        <div class="preview-file-icon">${fileIconSvg(mimeType, name)}</div>
        <div class="preview-file-name">${esc(name)}</div>
        <div class="preview-file-size">${fmtSize(size)}</div>
      </div>`;
    }
    openModal('preview-modal');
  }

  document.getElementById('preview-share').addEventListener('click', () => {
    if (!currentPreview) return;
    const { id, name, shareToken, shareExpires, shareDuration } = currentPreview;
    closeModal('preview-modal');
    document.getElementById('preview-body').innerHTML = '';
    currentPreview = null;
    openShareModal(id, name, shareToken ? { token: shareToken, expires_at: shareExpires, duration: shareDuration } : null);
  });

  document.getElementById('preview-rename').addEventListener('click', async () => {
    if (!currentPreview) return;
    const newName = prompt(t('dlg.rename', { name: currentPreview.name }), currentPreview.name);
    if (!newName || newName === currentPreview.name) return;
    try {
      await api('POST', `${BASE}/api/rename`, { type: 'file', id: currentPreview.id, newName });
      closeModal('preview-modal');
      loadBrowse(currentPath, true);
    } catch (err) { alert('Error: ' + err.message); }
  });

  document.getElementById('preview-delete').addEventListener('click', async () => {
    if (!currentPreview) return;
    if (!confirm(t('dlg.deleteFile', { name: currentPreview.name }))) return;
    try {
      await api('POST', `${BASE}/api/delete`, { items: [{ type: 'file', id: currentPreview.id, name: currentPreview.name }] });
      closeModal('preview-modal');
      loadBrowse(currentPath, true);
    } catch (err) { alert('Error: ' + err.message); }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Mkdir / rename / delete / bulk
  // ═════════════════════════════════════════════════════════════════════════
  document.getElementById('mkdir-btn').addEventListener('click', async () => {
    const name = prompt(t('dlg.mkdir'));
    if (!name?.trim()) return;
    setBrowserStatus(t('act.creating'));
    try {
      await api('POST', `${BASE}/api/mkdir`, { parent: currentPath, name: name.trim() });
      setBrowserStatus(t('act.folderCreated'), 'ok');
      loadBrowse(currentPath, true);
    } catch (err) { setBrowserStatus('Error: ' + err.message, 'err'); }
  });

  async function promptRename(type, id, oldName) {
    const newName = prompt(t('dlg.rename', { name: oldName }), oldName);
    if (!newName || newName === oldName) return;
    setBrowserStatus(t('act.renaming'));
    try {
      await api('POST', `${BASE}/api/rename`, { type, id, newName });
      setBrowserStatus(t('act.renamed'), 'ok'); loadBrowse(currentPath, true);
    } catch (err) { setBrowserStatus(t('act.error', { e: err.message }), 'err'); }
  }

  async function confirmDelete(items) {
    const names = items.map(i => '· ' + i.name).join('\n');
    if (!confirm(t('dlg.deleteItems', { n: items.length, names }))) return;
    setBrowserStatus(t('act.deleting', { n: items.length }));
    try {
      const r = await api('POST', `${BASE}/api/delete`, { items });
      const fails = (r.results || []).filter(x => !x.ok);
      setBrowserStatus(fails.length === 0 ? t('act.deleted', { n: items.length }) : t('act.failed', { n: fails.length }), fails.length ? 'err' : 'ok');
      selected.clear(); loadBrowse(currentPath, true);
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
    if (selected.size !== 1) { setBrowserStatus(t('bulk.zipOne'), 'err'); return; }
    const key = Array.from(selected)[0];
    if (!key.startsWith('d:')) { setBrowserStatus(t('bulk.zipFolder'), 'err'); return; }
    const folderName = document.querySelector(`[data-key="${key}"]`)?.dataset.name || 'carpeta';
    triggerDownload(`${BASE}/api/zip?id=${key.split(':')[1]}`, folderName + '.zip');
  });

  // ── Move modal ────────────────────────────────────────────────────────────
  let _movePath = '';
  let _moveFolderId = null;

  document.getElementById('bulk-move').addEventListener('click', () => {
    if (!selected.size) return;
    _movePath = '';
    _moveFolderId = null;
    const _ms = document.getElementById('move-status');
    _ms.textContent = ''; _ms.style.color = '';
    document.getElementById('move-here-btn').disabled = false;
    openModal('move-modal');
    loadMoveFolders('');
  });

  async function loadMoveFolders(p) {
    _movePath = p;
    _moveFolderId = null;  // reset immediately — prevents stale value if user clicks "Mover aquí" during load
    const moveBtn = document.getElementById('move-here-btn');
    moveBtn.disabled = true;
    const ul = document.getElementById('move-folder-list');
    ul.innerHTML = `<li class="empty muted" style="padding:12px 0;text-align:center">${t('browser.loading')}</li>`;
    try {
      const data = await api('GET', `${BASE}/api/browse?path=${encodeURIComponent(p)}`);
      // Use folder_id directly from API (null at root, number inside a folder)
      _moveFolderId = data.folder_id ?? null;
      const crumbs = data.crumbs || [];
      moveBtn.disabled = false;

      // Breadcrumbs
      const nav = document.getElementById('move-crumbs');
      nav.innerHTML = '';
      const homeBtn = document.createElement('button');
      homeBtn.className = 'crumb-btn'; homeBtn.textContent = t('move.home');
      homeBtn.addEventListener('click', () => loadMoveFolders(''));
      nav.appendChild(homeBtn);
      crumbs.forEach((c, i) => {
        const sep = document.createElement('span');
        sep.className = 'crumb-sep'; sep.textContent = '›';
        nav.appendChild(sep);
        const btn = document.createElement('button');
        btn.className = 'crumb-btn';
        btn.textContent = c.name;
        btn.addEventListener('click', () => loadMoveFolders(crumbs.slice(0, i + 1).map(x => x.name).join('/')));
        nav.appendChild(btn);
      });

      // Destination label
      const destLabel = crumbs.length ? crumbs[crumbs.length - 1].name : t('move.root');
      const _ms2 = document.getElementById('move-status');
      _ms2.textContent = t('move.dest', { name: destLabel }); _ms2.style.color = '';

      // Folder list
      ul.innerHTML = '';
      const dirs = (data.dirs || []).filter(d => !Array.from(selected).includes(`d:${d.id}`));

      // "Go to root" row — only shown when not already at root
      if (p !== '') {
        const rootLi = document.createElement('li');
        rootLi.className = 'move-folder-item move-folder-root';
        rootLi.innerHTML = `<span class="move-folder-icon">${ic('home')}</span><span class="move-folder-name">${t('move.root')}</span><span class="move-folder-arrow">${ic('go-back')}</span>`;
        rootLi.addEventListener('click', () => loadMoveFolders(''));
        ul.appendChild(rootLi);
      }

      if (!dirs.length) {
        const emptyLi = document.createElement('li');
        emptyLi.className = 'empty muted';
        emptyLi.style.cssText = 'padding:12px 0;text-align:center';
        emptyLi.textContent = t('move.noSubs');
        ul.appendChild(emptyLi);
      } else {
        dirs.forEach(d => {
          const li = document.createElement('li');
          li.className = 'move-folder-item';
          li.innerHTML = `<span class="move-folder-icon">${ic('folder')}</span><span class="move-folder-name">${esc(d.name)}</span><span class="move-folder-arrow">${ic('chev-r')}</span>`;
          li.addEventListener('click', () => {
            const subPath = p ? `${p}/${d.name}` : d.name;
            loadMoveFolders(subPath);
          });
          ul.appendChild(li);
        });
      }
    } catch (err) {
      ul.innerHTML = `<li class="empty muted" style="padding:12px 0;text-align:center">${t('act.error', { e: esc(err.message) })}</li>`;
    }
  }

  document.getElementById('move-here-btn').addEventListener('click', async () => {
    const items = Array.from(selected).map(key => {
      const [t, rawId] = key.split(':');
      return { type: t === 'f' ? 'file' : 'dir', id: Number(rawId) };
    });
    const statusEl = document.getElementById('move-status');
    const btn = document.getElementById('move-here-btn');

    if (_moveFolderId === currentFolderId) {
      statusEl.textContent = t('move.alreadyHere');
      statusEl.style.color = 'var(--warn, orange)';
      return;
    }

    statusEl.textContent = t('move.moving');
    statusEl.style.color = '';
    btn.disabled = true;
    try {
      for (const item of items) {
        await api('POST', `${BASE}/api/move`, { type: item.type, id: item.id, targetFolderId: _moveFolderId });
      }
      closeModal('move-modal');
      exitSelectionMode();
      await loadBrowse(currentPath, true);
      setBrowserStatus(t('move.moved', { n: items.length }), 'ok');
    } catch (err) {
      statusEl.textContent = 'Error: ' + err.message;
    } finally {
      btn.disabled = false;
    }
  });

  // Nav buttons
  document.getElementById('nav-back').addEventListener('click', () => {
    if (_navIdx > 0) {
      _navIdx--;
      const dest = _navStack[_navIdx];
      if (dest === '') { _navStack = ['']; _navIdx = 0; }
      _updateNavBtns();
      loadBrowse(dest, true);
    }
  });
  document.getElementById('nav-fwd').addEventListener('click', () => {
    if (_navIdx < _navStack.length - 1) { _navIdx++; _updateNavBtns(); loadBrowse(_navStack[_navIdx], true); }
  });
  document.getElementById('nav-home').addEventListener('click', () => loadBrowse(''));

  // Sincronizar cuando el usuario usa los botones del navegador (atrás/adelante nativo)
  window.addEventListener('popstate', ev => {
    const path = ev.state?.path ?? getPathFromHash();
    const idx = _navStack.lastIndexOf(path);
    if (idx >= 0) {
      _navIdx = idx;
    } else {
      _navStack = _navStack.slice(0, _navIdx + 1);
      _navStack.push(path);
      _navIdx = _navStack.length - 1;
    }
    _updateNavBtns();
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
  let uploading   = false;
  let cancelFlag  = false;
  let dedupMode   = false;
  let _dedupToDelete = [];
  const CONCURRENCY = 3;

  async function browserFileHash(file) {
    if (file.size > 100 * 1024 * 1024) return null; // >100 MB: skip full hash, use size only
    try {
      const buf = await file.arrayBuffer();
      const hashBuf = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch { return null; }
  }

  async function checkDedupAsync(item) {
    const sameSize = currentEntries.filter(e => e.type === 'file' && e.size === item.file.size);
    if (!sameSize.length) return false;
    const hash = await browserFileHash(item.file);
    item._hash = hash;
    try {
      const res = await api('POST', `${BASE}/api/dedup/check`, {
        folder_id: currentFolderId ?? null,
        items: [{ idx: 0, size: item.file.size, hash }],
      });
      return (res.matches?.length ?? 0) > 0;
    } catch { return sameSize.length > 0; }
  }
  function clearDedupState() {
    document.querySelectorAll('#file-list .dup-highlight').forEach(li => li.classList.remove('dup-highlight'));
    const bar = document.getElementById('dedup-bar');
    if (bar) { bar.hidden = true; bar.classList.remove('dedup-ok'); }
    const confirmBtn = document.getElementById('dedup-confirm-btn');
    if (confirmBtn) confirmBtn.hidden = false;
    _dedupToDelete = [];
  }

  let _refreshTimer = null;
  function scheduleRefresh() {
    clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(() => loadBrowse(currentPath, true), 1200);
  }

  // ── Floating upload bubble ────────────────────────────────────────────────
  function showBubble()  { document.getElementById('upload-bubble').hidden = false; }
  function hideBubble()  { document.getElementById('upload-bubble').hidden = true;  }
  function syncBubble(pct, done, total) {
    document.getElementById('upload-bubble-bar').style.width = pct + '%';
    document.getElementById('upload-bubble-pct').textContent = pct + '%';
    document.getElementById('upload-bubble-info').textContent =
      cancelFlag ? t('up.cancelling') : t('up.progress', { done, total });
  }

  document.getElementById('upload-bubble-view').addEventListener('click', () => openModal('upload-modal'));
  function cancelAllUploads() {
    cancelFlag = true;
    uploadQueue.filter(i => i.status === 'busy').forEach(item => { if (item._abort) item._abort(); });
    uploadQueue = [];
    renderQueue();
  }

  document.getElementById('upload-bubble-cancel').addEventListener('click', cancelAllUploads);
  document.getElementById('upload-cancel-btn').addEventListener('click', () => {
    cancelAllUploads();
    closeModal('upload-modal');
  });

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

  // ── Duplicate detection ───────────────────────────────────────────────────
  document.getElementById('dedup-btn').addEventListener('click', async () => {
    clearDedupState();
    const bar = document.getElementById('dedup-bar');
    const msg = document.getElementById('dedup-msg');
    const confirmBtn = document.getElementById('dedup-confirm-btn');
    const icon = document.querySelector('.dedup-bar-icon');
    icon.textContent = '⟳'; msg.textContent = t('dedup.scanning');
    confirmBtn.hidden = true; bar.classList.remove('dedup-ok'); bar.hidden = false;
    try {
      const data = await api('POST', `${BASE}/api/dedup/scan`, { folder_id: currentFolderId ?? null });
      const groups = data.groups || [];
      if (!groups.length) {
        bar.classList.add('dedup-ok'); icon.textContent = '✓';
        msg.textContent = t('dedup.none');
        confirmBtn.hidden = true;
        setTimeout(() => clearDedupState(), 3500);
        return;
      }
      _dedupToDelete = groups.flatMap(g => {
        const sorted = [...g.files].sort((a, b) => a.id - b.id);
        return sorted.slice(1); // keep oldest, flag the rest
      });
      _dedupToDelete.forEach(f => {
        const li = document.querySelector(`#file-list li[data-id="${f.id}"]`);
        if (li) li.classList.add('dup-highlight');
      });
      const exactCount = groups.filter(g => g.method === 'hash').reduce((s, g) => s + g.files.length - 1, 0);
      const sizeCount  = groups.filter(g => g.method === 'size').reduce((s, g) => s + g.files.length - 1, 0);
      const parts = [];
      if (exactCount) parts.push(t('dedup.exact', { n: exactCount }));
      if (sizeCount)  parts.push(t('dedup.probable', { n: sizeCount }));
      icon.textContent = '⚠'; bar.classList.remove('dedup-ok');
      msg.textContent = t('dedup.summary', { parts: parts.join(' · '), groups: groups.length });
      confirmBtn.hidden = false;
    } catch (err) {
      icon.textContent = '✗'; msg.textContent = t('dedup.error', { e: err.message }); confirmBtn.hidden = true;
    }
  });
  document.getElementById('dedup-confirm-btn').addEventListener('click', async () => {
    if (!_dedupToDelete.length) return;
    const items = _dedupToDelete.map(f => ({ type: 'file', id: f.id, name: f.name }));
    clearDedupState();
    setBrowserStatus(t('dedup.deleting', { n: items.length }));
    try {
      const r = await api('POST', `${BASE}/api/delete`, { items });
      const fails = (r.results || []).filter(x => !x.ok);
      setBrowserStatus(fails.length === 0 ? t('dedup.deleted', { n: items.length }) : t('act.failed', { n: fails.length }), fails.length ? 'err' : 'ok');
      loadBrowse(currentPath, true);
    } catch (err) { setBrowserStatus('Error: ' + err.message, 'err'); }
  });
  document.getElementById('dedup-cancel-btn').addEventListener('click', clearDedupState);

  // ── Dedup switch (upload modal) ───────────────────────────────────────────
  document.getElementById('dedup-switch').addEventListener('change', e => {
    dedupMode = e.target.checked;
    uploadQueue.forEach(item => {
      if (item.status === 'ok' || item.status === 'busy' || item.status === 'err' || item.status === 'cancelled') return;
      const isFlat = !item.rel || item.rel === item.file.name;
      if (!dedupMode) {
        if (item.status === 'skipped' || item.status === 'checking') item.status = 'pending';
      } else if (isFlat) {
        _scheduleItemDedupCheck(item);
      }
    });
    renderQueue();
  });

  function openUploadModal(files) {
    openModal('upload-modal');
    if (!uploading) {
      uploadQueue = [];
      dedupMode = false;
      document.getElementById('dedup-switch').checked = false;
      renderQueue();
      document.getElementById('upload-status').textContent = '';
      document.getElementById('upload-cancel-btn').hidden = true;
      const oWrap = document.getElementById('upload-overall-wrap');
      if (oWrap) oWrap.hidden = true;
      document.getElementById('upload-overall-bar').style.width = '0%';
      document.getElementById('upload-overall-pct').textContent = '0%';
    }
    if (files.length) addToQueue(files);
  }
  function addToQueue(files) {
    for (const { file, rel } of files) {
      const item = { file, rel, status: 'pending', progress: 0 };
      uploadQueue.push(item);
      const isFlat = !rel || rel === file.name;
      if (dedupMode && isFlat) _scheduleItemDedupCheck(item);
    }
    renderQueue();
  }

  function _scheduleItemDedupCheck(item) {
    item.status = 'checking';
    renderQueue();
    checkDedupAsync(item).then(isDup => {
      if (item.status === 'checking') item.status = isDup ? 'skipped' : 'pending';
      renderQueue();
    }).catch(() => {
      if (item.status === 'checking') item.status = 'pending';
      renderQueue();
    });
  }
  function renderQueue() {
    const ul = document.getElementById('upload-queue');
    const startBtn = document.getElementById('start-upload-btn');
    startBtn.disabled = uploading || !uploadQueue.some(i => i.status === 'pending') || uploadQueue.some(i => i.status === 'checking');
    if (!uploadQueue.length) { ul.innerHTML = ''; return; }
    ul.innerHTML = uploadQueue.map((item, idx) => {
      const statusIcon =
        item.status === 'ok'        ? `<span class="q-status ok">${ic('q-ok')}</span>`                                   :
        item.status === 'err'       ? `<span class="q-status err">${ic('q-err')}</span>`                                  :
        item.status === 'cancelled' ? `<span class="q-status err">${ic('q-err')}</span>`                                  :
        item.status === 'skipped'   ? `<span class="q-status skip" title="${t('up.skipTitle')}">${ic('q-skip')}</span>`:
        item.status === 'checking'  ? `<span class="q-status busy" title="${t('up.checkTitle')}">${ic('q-busy')}</span>`  :
        item.status === 'busy'      ? `<span class="q-status busy">${ic('q-busy')}</span>`                                : '';
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
    if (!pending.length || uploading) return;

    uploading   = true;
    cancelFlag  = false;
    document.getElementById('upload-cancel-btn').hidden = false;

    const totalBytes    = pending.reduce((s, i) => s + i.file.size, 0);
    const fileBytesMap  = new Map(pending.map(item => [item, 0]));

    const oWrap = document.getElementById('upload-overall-wrap');
    const oBar  = document.getElementById('upload-overall-bar');
    const oPct  = document.getElementById('upload-overall-pct');
    if (oWrap) oWrap.hidden = false;

    function getOverallPct() {
      const uploaded = [...fileBytesMap.values()].reduce((s, v) => s + v, 0);
      return totalBytes > 0 ? Math.min(100, Math.round((uploaded / totalBytes) * 100)) : 0;
    }
    function syncProgress() {
      const pct  = getOverallPct();
      const done = pending.filter(i => i.status === 'ok' || i.status === 'err').length;
      if (oBar) oBar.style.width = pct + '%';
      if (oPct) oPct.textContent = pct + '%';
      syncBubble(pct, done, pending.length);
      renderQueue();
    }

    showBubble();
    syncProgress();

    // Concurrent worker pool
    let idx = 0;
    async function worker() {
      while (true) {
        if (cancelFlag || idx >= pending.length) break;
        const item = pending[idx++];
        item.status = 'busy';
        try {
          await tusUpload(item, bytes => { fileBytesMap.set(item, bytes); syncProgress(); });
          fileBytesMap.set(item, item.file.size);
          item.status = 'ok';
          scheduleRefresh();
        } catch {
          if (cancelFlag) { item.status = 'cancelled'; fileBytesMap.set(item, 0); }
          else            { item.status = 'err'; }
        }
        syncProgress();
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    uploading = false;
    document.getElementById('upload-cancel-btn').hidden = true;
    const ok   = pending.filter(i => i.status === 'ok').length;
    const fail = pending.filter(i => i.status === 'err').length;
    const finalPct = cancelFlag ? getOverallPct() : 100;
    if (oBar) oBar.style.width = finalPct + '%';
    if (oPct) oPct.textContent = finalPct + '%';

    const statusEl = document.getElementById('upload-status');
    if (statusEl) {
      statusEl.textContent = cancelFlag
        ? t('up.cancelled', { n: ok })
        : fail === 0 ? t('up.done', { n: ok }) : t('up.partial', { ok, fail });
      statusEl.style.color = cancelFlag ? 'var(--muted)' : fail === 0 ? 'var(--ok)' : 'var(--err)';
    }
    renderQueue();

    if (!cancelFlag) {
      loadBrowse(currentPath, true);
      setTimeout(hideBubble, 2500);
    } else {
      syncBubble(finalPct, ok, pending.length);
      setTimeout(hideBubble, 3000);
    }
  }

  function tusUpload(item, onProgress) {
    return new Promise((resolve, reject) => {
      const fileSize  = item.file.size;
      const chunkSize = 8 * 1024 * 1024;
      let offset = 0, tusUrl = '', currentXHR = null;

      item._abort = () => { if (currentXHR) currentXHR.abort(); };

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
        req.onerror = () => reject(new Error('Error de red'));
        req.send(null);
      }
      function uploadChunk() {
        if (cancelFlag) { reject(new Error('cancelled')); return; }
        if (offset >= fileSize) { resolve(); return; }
        const end   = Math.min(offset + chunkSize, fileSize);
        const slice = item.file.slice(offset, end);
        const req   = new XMLHttpRequest();
        currentXHR  = req;
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
        req.onload  = () => {
          if (req.status === 204 || req.status === 200) { offset = end; uploadChunk(); }
          else reject(new Error(`TUS patch: ${req.status}`));
        };
        req.onabort = () => reject(new Error('cancelled'));
        req.onerror = () => reject(new Error(cancelFlag ? 'cancelled' : 'Error de red'));
        req.send(slice);
      }
      createUpload();
    });
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Share modal
  // ═════════════════════════════════════════════════════════════════════════
  let _shareFileId   = null;
  let _shareToken    = null;
  let _shareIsFolder = false;
  let _expiryTimer   = null;
  let _apVol = parseFloat(localStorage.getItem('ap-vol') || '1');

  function _startShareCountdown(expires_at) {
    const label = document.getElementById('share-expiry-label');
    if (_expiryTimer) { clearInterval(_expiryTimer); _expiryTimer = null; }
    if (!expires_at) {
      label.textContent = t('shr.permanent');
      label.style.color = '';
      return;
    }
    function update() {
      const diff = expires_at - Math.floor(Date.now() / 1000);
      if (diff <= 0) {
        label.textContent = t('shr.expired');
        label.style.color = 'var(--err)';
        clearInterval(_expiryTimer); _expiryTimer = null;
        return;
      }
      const h = Math.floor(diff / 3600);
      const m = Math.floor((diff % 3600) / 60);
      const s = diff % 60;
      let str = t('shr.expiresIn');
      if (h > 0) str += `${h}h `;
      if (h > 0 || m > 0) str += `${String(m).padStart(2,'0')}m `;
      str += `${String(s).padStart(2,'0')}s`;
      label.style.color = diff < 300 ? 'var(--err)' : diff < 3600 ? '#f59e0b' : 'var(--muted)';
      label.textContent = str;
    }
    update();
    _expiryTimer = setInterval(update, 1000);
  }

  function openShareModal(fileId, fileName, existingShare = null, isFolder = false) {
    _shareFileId   = fileId;
    _shareIsFolder = isFolder;
    _shareToken    = existingShare?.token || null;
    document.querySelector('#share-modal .modal-title').textContent = isFolder ? t('shr.titleFolder') : t('shr.titleFile');
    document.getElementById('share-file-name').textContent = fileName;
    document.getElementById('share-err').hidden = true;
    const _sel = document.getElementById('share-dur-select');
    if (existingShare) {
      const _dur = existingShare.duration ?? 0;
      const _opts = [3600, 18000, 86400, 259200, 604800, 0];
      const _best = _opts.reduce((a, b) => Math.abs(b - _dur) < Math.abs(a - _dur) ? b : a);
      _sel.value = String(_best);
    } else {
      _sel.value = '3600';
    }
    const genBtn  = document.getElementById('share-gen-btn');
    const stopBtn = document.getElementById('share-stop-btn');
    const result  = document.getElementById('share-result');
    // Clear stale values first
    document.getElementById('share-link-input').value = '';
    document.getElementById('share-qr-img').src = '';
    document.getElementById('share-expiry-label').textContent = '';
    if (existingShare) {
      // Already shared — show existing link + QR immediately
      const url = `${window.location.protocol}//${window.location.host}${BASE}/s/${existingShare.token}`;
      document.getElementById('share-link-input').value = url;
      document.getElementById('share-qr-img').src = `${BASE}/s/${existingShare.token}/qr`;
      _startShareCountdown(existingShare.expires_at);
      result.hidden  = false;
      stopBtn.hidden = false;
      genBtn.textContent = t('shr.regenerate');
    } else {
      // Not shared — hide result until user clicks Generate
      result.hidden  = true;
      stopBtn.hidden = true;
      genBtn.textContent = t('shr.generate');
    }
    genBtn.disabled = false;
    openModal('share-modal');
  }

  document.getElementById('share-gen-btn').addEventListener('click', async () => {
    if (!_shareFileId) return;
    const btn     = document.getElementById('share-gen-btn');
    const errEl   = document.getElementById('share-err');
    const stopBtn = document.getElementById('share-stop-btn');
    errEl.hidden = true;
    btn.disabled = true; btn.textContent = t('shr.generating');
    try {
      if (_shareToken) {
        await api('DELETE', `${BASE}/api/share/${_shareToken}`).catch(() => {});
        _shareToken = null;
      }
      const dur  = Number(document.getElementById('share-dur-select').value);
      const body = _shareIsFolder
        ? { folderId: _shareFileId, duration: dur }
        : { fileId:   _shareFileId, duration: dur };
      const r = await api('POST', `${BASE}/api/share`, body);
      _shareToken = r.token;
      document.getElementById('share-link-input').value = r.url;
      document.getElementById('share-qr-img').src = `${BASE}/s/${r.token}/qr`;
      _startShareCountdown(r.expires_at);
      document.getElementById('share-result').hidden = false;
      stopBtn.hidden = false;
      btn.textContent = t('shr.regenerate'); btn.disabled = false;
      // Instantly patch the file row without waiting for full reload
      const _genLi = document.querySelector(`#file-list [data-id="${_shareFileId}"][data-type="${_shareIsFolder ? 'dir' : 'file'}"]`);
      if (_genLi) {
        _genLi.classList.add('is-shared');
        _genLi.dataset.shareToken   = r.token;
        _genLi.dataset.shareExpires = r.expires_at || '';
        _genLi.dataset.shareDur     = dur;
        const _nameEl = _genLi.querySelector('.row-name');
        if (_nameEl && !_nameEl.querySelector('.share-badge')) {
          _nameEl.insertAdjacentHTML('beforeend', ` <span class="share-badge">${t('row.shared')}</span>`);
        }
      }
      loadBrowse(currentPath, true);
    } catch (err) {
      errEl.textContent = err.message; errEl.hidden = false;
      btn.textContent = t('shr.generate'); btn.disabled = false;
    }
  });

  document.getElementById('share-stop-btn').addEventListener('click', async () => {
    if (!_shareToken) return;
    const btn = document.getElementById('share-stop-btn');
    btn.disabled = true; btn.textContent = t('shr.stopping');
    try {
      await api('DELETE', `${BASE}/api/share/${_shareToken}`);
      _shareToken = null;
      // Instantly patch the file row
      const _stopLi = document.querySelector(`#file-list [data-id="${_shareFileId}"][data-type="${_shareIsFolder ? 'dir' : 'file'}"]`);
      if (_stopLi) {
        _stopLi.classList.remove('is-shared');
        _stopLi.dataset.shareToken = '';
        _stopLi.dataset.shareExpires = '';
        _stopLi.dataset.shareDur = '0';
        _stopLi.querySelector('.share-badge')?.remove();
      }
      closeModal('share-modal');
      loadBrowse(currentPath, true);
    } catch (err) {
      document.getElementById('share-err').textContent = err.message;
      document.getElementById('share-err').hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = t('shr.stop');
    }
  });

  document.getElementById('share-copy-btn').addEventListener('click', () => {
    const val = document.getElementById('share-link-input').value;
    if (!val) return;
    const btn = document.getElementById('share-copy-btn');
    navigator.clipboard.writeText(val).then(() => {
      btn.textContent = t('shr.copied');
      setTimeout(() => { btn.textContent = t('shr.copy'); }, 2000);
    }).catch(() => {
      const el = document.getElementById('share-link-input');
      el.select(); document.execCommand('copy');
      btn.textContent = t('shr.copied');
      setTimeout(() => { btn.textContent = t('shr.copy'); }, 2000);
    });
  });

  document.getElementById('share-qr-share-btn').addEventListener('click', async () => {
    if (!_shareToken) return;
    const qrUrl   = `${BASE}/s/${_shareToken}/qr`;
    const linkUrl = document.getElementById('share-link-input').value;
    try {
      const res  = await fetch(qrUrl);
      const blob = await res.blob();
      const file = new File([blob], 'compartir-qr.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: t('shr.shareLink'), text: linkUrl });
      } else if (navigator.share) {
        await navigator.share({ url: linkUrl, title: t('shr.shareFile') });
      } else {
        triggerDownload(qrUrl, 'qr.png');
      }
    } catch (e) {
      if (e.name !== 'AbortError') triggerDownload(qrUrl, 'qr.png');
    }
  });

  // Inicio
  checkAuth();
})();

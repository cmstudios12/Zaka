/* ZAKA FASHION • Fast Phone Barcode Scanner v3
   Keeps the existing Supabase till pairing and barcode insert workflow intact.
   Works on HTTPS (or localhost) with browser-supported camera capabilities. */
(() => {
  'use strict';
  const PROJECT = 'https://oyxgjjzvfjzgzlwqwegv.supabase.co';
  const KEY = 'sb_publishable_pWTWcC_YxMNEbyDkytYAQw_u6PZy9CH';
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = v => new Intl.NumberFormat('en-ZA', {style:'currency',currency:'ZAR'}).format(Number(v || 0));
  const icons = () => window.lucide?.createIcons({attrs:{'stroke-width':1.8}});
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  let db, user, sessionId = null, pairSecret = '';
  let reader = null, running = false, starting = false, stopping = false;
  let busy = false, activeCode = '', nextCode = '', recentBarcode = '', recentAt = 0, lastDecodeAt = 0;
  let barcodeRemoved = true, latestProduct = null, scanCount = 0, history = [];
  let audio = null, soundOn = true, torch = false, cameraId = '', camerasLoaded = false;
  let capabilities = {}, zoom = null, zoomTimer = null;
  let catalog = new Map(), loadingCatalog = false, catalogTimer = null;
  let sessionTimer = null, toastTimer = null, successTimer = null;

  function toast(message, error = false) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').className = 'toast' + (error ? ' error' : '');
    toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 3700);
  }
  function errorBox(message) { $('loginError').textContent = message; $('loginError').classList.remove('hidden'); }
  function connection(text, connected) {
    const el = $('pairMessage');
    el.textContent = text;
    el.style.background = connected ? '#e4f4e8' : '#fff5e9';
    el.style.color = connected ? '#286d46' : '#946121';
  }
  function indicator(text, mode = '') {
    $('scanIndicator').textContent = text;
    $('scanIndicator').className = 'scan-indicator' + (mode ? ' is-' + mode : '');
  }
  function result(p, code) {
    if (!p) {
      $('lastResult').innerHTML = `<span class="warning-tag">Barcode not found</span><div class="last-product">${esc(code)}</div><p class="small muted">Check that this product is active and its label matches Zaka Fashion inventory.</p>`;
      $('addAgain').classList.add('hidden');
      indicator('Not found', 'error');
      return;
    }
    $('lastResult').innerHTML = `<span class="success-tag"><i data-lucide="check-circle-2" class="icon"></i> SENT TO CASHIER TILL</span><div class="last-product" style="margin-top:10px">${esc(p.name)}<small>${esc([p.colour,p.size].filter(Boolean).join(' / ') || 'Standard')} · ${esc(p.barcode)}</small></div><div class="last-price">${money(p.price)}</div><div class="small muted">${Number(p.quantity)} unit(s) currently in inventory</div>`;
    $('addAgain').classList.remove('hidden');
    indicator('Added', 'success');
    icons();
  }
  function renderHistory() {
    $('phoneHistory').innerHTML = history.length
      ? history.map(p => `<li><span>${esc(p.name)}<small>${esc([p.colour,p.size].filter(Boolean).join(' / ') || 'Standard')}</small></span><strong>${money(p.price)}</strong></li>`).join('')
      : '<li class="muted">No scans yet.</li>';
  }

  /* Prepare sound on a real button press; required by iOS Safari audio restrictions. */
  function unlockAudio(force = false) {
    if (!soundOn && !force) return null;
    try {
      audio ||= new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') void audio.resume();
      return audio;
    } catch (err) { console.warn('Audio not available:', err); return null; }
  }
  async function beep(force = false) {
    if (!soundOn && !force) return;
    try {
      const ctx = unlockAudio(force);
      if (!ctx) return;
      if (ctx.state !== 'running') await ctx.resume();
      if (ctx.state !== 'running') return;
      const now = audio.currentTime;
      const volume = audio.createGain();
      volume.gain.setValueAtTime(0.0001, now);
      volume.gain.exponentialRampToValueAtTime(0.13, now + 0.009);
      volume.gain.setValueAtTime(0.13, now + 0.10);
      volume.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
      volume.connect(audio.destination);
      const tone1 = audio.createOscillator();
      tone1.type = 'square'; tone1.frequency.setValueAtTime(1175, now);
      tone1.connect(volume); tone1.start(now); tone1.stop(now + 0.155);
      tone1.onended = () => { tone1.disconnect(); volume.disconnect(); };
    } catch (err) { console.warn('Beep unavailable:', err); }
  }
  function successFeedback() {
    void beep();
    try { navigator.vibrate?.(55); } catch (_) { /* unsupported */ }
    const el = $('scanSuccess');
    clearTimeout(successTimer);
    el.classList.remove('hidden');
    $('scanCount').textContent = String(++scanCount);
    successTimer = setTimeout(() => el.classList.add('hidden'), 750);
    const card = document.querySelector('.fast-camera');
    card?.classList.add('is-successful');
    setTimeout(() => card?.classList.remove('is-successful'), 500);
  }

  /* Cache products so normal checkout needs only one server request (the scan insert).
     Misses are verified against Supabase, so newly added products can still scan. */
  async function refreshCatalog() {
    if (loadingCatalog || !db || !user) return;
    loadingCatalog = true;
    try {
      const updated = new Map();
      for (let offset = 0; offset < 10000; offset += 1000) {
        const { data, error } = await db.from('zf_products')
          .select('id,name,barcode,colour,size,price,quantity,status')
          .eq('status', 'active')
          .range(offset, offset + 999);
        if (error) throw new Error(error.message);
        for (const p of data || []) if (p.barcode) updated.set(String(p.barcode).trim().toUpperCase(), p);
        if (!data || data.length < 1000) break;
      }
      catalog = updated;
    } catch (err) {
      console.warn('Product cache could not refresh:', err.message);
      // Keep old cache if the connection briefly drops.
    } finally { loadingCatalog = false; }
  }
  async function findProduct(code) {
    if (catalog.has(code)) return catalog.get(code);
    const { data, error } = await db.from('zf_products')
      .select('id,name,barcode,colour,size,price,quantity,status')
      .eq('barcode', code).eq('status', 'active').maybeSingle();
    if (error) throw new Error(error.message);
    if (data) catalog.set(code, data);
    return data || null;
  }

  /* Keep scanning while Supabase writes, but never send accidental duplicate frames. */
  function onDecode(raw) {
    const code = String(raw || '').trim().toUpperCase();
    if (!code || code.length < 3 || code.length > 100) return;
    lastDecodeAt = Date.now();
    if (code !== recentBarcode) barcodeRemoved = true;
    if (code === recentBarcode && (!barcodeRemoved || Date.now() - recentAt < 2300)) return;
    void sendBarcode(code);
  }
  function onNoDecode() {
    if (recentBarcode && Date.now() - lastDecodeAt > 800) barcodeRemoved = true;
  }
  async function sendBarcode(raw, force = false) {
    const code = String(raw || '').trim().toUpperCase();
    if (!sessionId) { toast('Pair the phone with an open till first.', true); return; }
    if (code.length < 3 || code.length > 100) { toast('Enter a valid barcode.', true); return; }
    if (!force && code === recentBarcode && (!barcodeRemoved || Date.now() - recentAt < 2300)) return;
    if (busy) {
      if (code !== activeCode && code !== recentBarcode) nextCode = code;
      return;
    }
    busy = true;
    activeCode = code;
    indicator('Sending…', 'loading');
    try {
      const product = await findProduct(code);
      if (!product) { result(null, code); toast('Unknown barcode. Nothing added.', true); return; }
      const { error } = await db.from('zf_till_scans').insert({session_id:sessionId, barcode:product.barcode});
      if (error) throw new Error(error.message);
      recentBarcode = code;
      recentAt = Date.now();
      barcodeRemoved = false;
      latestProduct = product;
      result(product, code);
      successFeedback();
      history.unshift(product); history = history.slice(0, 8); renderHistory();
    } catch (err) {
      indicator('Failed', 'error');
      toast('Could not send barcode: ' + err.message, true);
      if (/expired|RLS|policy|closed|permission|session/i.test(err.message))
        connection('Check that the cashier till session is open. Pair again if needed.', false);
    } finally {
      busy = false; activeCode = '';
      const next = nextCode; nextCode = '';
      if (next && next !== recentBarcode && sessionId) void sendBarcode(next);
    }
  }

  async function pair() {
    if (!pairSecret) { connection('Open the QR pairing link on your cashier till computer.', false); return; }
    connection('Connecting this phone to the cashier till…', false);
    try {
      const {data, error} = await db.rpc('zf_join_till', {p_secret:pairSecret});
      if (error) throw new Error(error.message);
      sessionId = data;
      const {data:session, error:readError} = await db.from('zf_till_sessions')
        .select('id,status').eq('id', sessionId).single();
      if (readError || session.status !== 'open') throw new Error(readError?.message || 'Till session is closed.');
      connection('Connected to cashier till. Your scanner is ready.', true);
      $('startCamera').disabled = false;
      clearInterval(sessionTimer);
      sessionTimer = setInterval(checkTill, 10000);
    } catch (err) {
      sessionId = null;
      connection(err.message + ' Scan the latest pairing QR on the till.', false);
      toast('Could not connect: ' + err.message, true);
    }
  }
  async function checkTill() {
    if (!sessionId) return;
    try {
      const {data, error} = await db.from('zf_till_sessions')
        .select('status,scanner_id').eq('id', sessionId).maybeSingle();
      if (error || !data || data.status !== 'open' || data.scanner_id !== user.id) {
        sessionId = null;
        connection('Till disconnected. Scan the cashier’s new pairing QR.', false);
        $('startCamera').disabled = true;
        await stopCamera();
      }
    } catch (err) { console.warn('Till check:', err); }
  }

  function cameraState() {
    $('startCamera').classList.toggle('hidden', running);
    $('stopCamera').classList.toggle('hidden', !running);
    $('targetBox').classList.toggle('hidden', !running);
    $('cameraPlaceholder').classList.toggle('hidden', running);
    document.querySelector('.fast-camera')?.classList.toggle('is-running', running);
    $('cameraStatus').textContent = running ? 'Scanning live' : 'Camera off';
    $('scanTools').classList.toggle('hidden', !running);
    if (!running) {
      for (const id of ['torchBtn','zoomOut','zoomIn','zoomRange','zoomLabel','refocusBtn','cameraSelect']) $(id).classList.add('hidden');
    }
  }
  function boxSize(width, height) {
    // Horizontal scanning window for long clothing Code 128 barcodes.
    return {width:Math.max(100, Math.floor(Math.min(width - 16, width * .93))), height:Math.max(100, Math.floor(Math.min(height - 16, height * .53)))};
  }
  function getCaps() {
    try { return reader?.getRunningTrackCapabilities?.() || {}; }
    catch (_) { return {}; }
  }
  function getSettings() {
    try { return reader?.getRunningTrackSettings?.() || {}; }
    catch (_) { return {}; }
  }
  async function constrain(property, value) {
    if (!reader || !running) return false;
    try {
      await reader.applyVideoConstraints({advanced:[{[property]:value}]});
      return true;
    } catch (err) { console.warn('Camera setting not supported:', property, err); return false; }
  }
  async function setupCameraControls() {
    capabilities = getCaps();
    const modes = capabilities.focusMode || [];
    if (Array.isArray(modes) && modes.includes('continuous')) await constrain('focusMode', 'continuous');
    const canFocus = Array.isArray(modes) && (modes.includes('single-shot') || modes.includes('continuous'));
    $('refocusBtn').classList.toggle('hidden', !canFocus);
    $('torchBtn').classList.toggle('hidden', !capabilities.torch);
    const range = capabilities.zoom;
    const hasZoom = range && Number.isFinite(range.min) && Number.isFinite(range.max) && range.max > range.min;
    for (const id of ['zoomOut','zoomIn','zoomRange','zoomLabel']) $(id).classList.toggle('hidden', !hasZoom);
    if (hasZoom) {
      zoom = getSettings().zoom || range.min;
      $('zoomRange').min = String(range.min);
      $('zoomRange').max = String(range.max);
      $('zoomRange').step = String(range.step || .1);
      $('zoomRange').value = String(zoom);
      $('zoomValue').textContent = Number(zoom).toFixed(1) + '×';
    } else zoom = null;
    $('focusHint').innerHTML = hasZoom
      ? 'Keep the phone <strong>15–25 cm away</strong> to avoid blur. Use <strong>Zoom +</strong> instead of moving the phone closer.'
      : 'Keep the phone <strong>15–25 cm away</strong>. Too close is outside the camera’s focus range; move back until the bars look sharp.';
    await listCameras();
  }
  async function listCameras() {
    if (camerasLoaded) {
      $('cameraSelect').classList.toggle('hidden', $('cameraSelect').options.length <= 1);
      return;
    }
    try {
      const all = await window.Html5Qrcode.getCameras();
      if (!Array.isArray(all) || all.length <= 1) return;
      // List all cameras so the cashier can switch to an alternative rear/macro lens.
      const dropdown = $('cameraSelect');
      dropdown.replaceChildren();
      const automatic = document.createElement('option');
      automatic.value = ''; automatic.textContent = 'Automatic rear camera'; dropdown.append(automatic);
      all.forEach((cam, index) => {
        const option = document.createElement('option');
        option.value = cam.id;
        option.textContent = cam.label || ('Camera ' + (index + 1));
        dropdown.append(option);
      });
      dropdown.value = cameraId;
      dropdown.classList.remove('hidden');
      camerasLoaded = true;
    } catch (err) { console.warn('Unable to list cameras:', err); }
  }
  async function startCamera() {
    if (starting || stopping || running) return;
    if (!sessionId) { toast('First pair using the cashier till QR code.', true); return; }
    if (!window.isSecureContext) { toast('Camera permission requires HTTPS or localhost.', true); return; }
    if (!window.Html5Qrcode) { toast('Camera decoder did not load. Check your internet.', true); return; }
    unlockAudio(); // Called synchronously inside real Start button press.
    starting = true;
    $('startCamera').disabled = true;
    $('cameraStatus').textContent = 'Starting…';
    const F = window.Html5QrcodeSupportedFormats;
    try {
      const scannerConfig = {formatsToSupport:[F.CODE_128,F.CODE_39,F.EAN_13,F.EAN_8,F.UPC_A,F.ITF],
        experimentalFeatures:{useBarCodeDetectorIfSupported:true}, verbose:false};
      reader = new window.Html5Qrcode('reader', scannerConfig);
      const cameraChoice = cameraId ? {deviceId:{exact:cameraId}} : {facingMode:'environment'};
      // Prefer adequate definition instead of processing an unnecessarily huge full frame.
      const cameraSettings = {fps:24, disableFlip:true, qrbox:boxSize,
        videoConstraints:{...cameraChoice,width:{ideal:1280},height:{ideal:720}}};
      try {
        await reader.start(cameraId || {facingMode:'environment'}, cameraSettings, onDecode, onNoDecode);
      } catch (firstError) {
        // Some mobile browsers dislike explicit video constraints. Fall back to simple rear camera.
        console.warn('High-definition camera config failed. Retrying standard:', firstError);
        try { await reader.clear(); } catch (_) {}
        reader = new window.Html5Qrcode('reader', scannerConfig);
        await reader.start(cameraId || {facingMode:'environment'},
          {fps:18,disableFlip:true,qrbox:boxSize}, onDecode, onNoDecode);
      }
      running = true;
      cameraState();
      await setupCameraControls();
      indicator('Scanning');
    } catch (err) {
      console.error('Scanner start failed:', err);
      running = false;
      cameraState();
      $('cameraStatus').textContent = 'Camera unavailable';
      toast('Could not open camera: ' + (err?.message || err), true);
      try { await reader?.clear(); } catch (_) {}
      reader = null;
    } finally { starting = false; $('startCamera').disabled = !sessionId; }
  }
  async function stopCamera() {
    if (stopping) return;
    stopping = true;
    const old = reader;
    reader = null;
    try {
      if (old) {
        if (running) await old.stop();
        await old.clear();
      }
    } catch (err) { console.warn('Camera stop:', err); }
    running = false; torch = false; capabilities = {}; zoom = null;
    $('torchBtn').setAttribute('aria-pressed', 'false');
    $('torchBtn').innerHTML = '<i data-lucide="flashlight" class="icon"></i> Light';
    cameraState(); icons();
    stopping = false;
  }
  async function toggleTorch() {
    if (!running) return;
    const setOn = !torch;
    if (await constrain('torch', setOn)) {
      torch = setOn;
      $('torchBtn').setAttribute('aria-pressed', String(torch));
      $('torchBtn').innerHTML = `<i data-lucide="${torch ? 'flashlight-off' : 'flashlight'}" class="icon"></i> ${torch ? 'Light off' : 'Light'}`;
      icons();
    } else toast('Torch control is not available on this phone.', true);
  }
  async function applyZoom(value) {
    if (!running || !capabilities.zoom) return;
    const cap = capabilities.zoom;
    const target = Math.max(cap.min, Math.min(cap.max, Number(value)));
    if (await constrain('zoom', target)) {
      zoom = target;
      $('zoomRange').value = String(target);
      $('zoomValue').textContent = target.toFixed(1) + '×';
    } else toast('Camera zoom is not available in this browser.', true);
  }
  function scheduleZoom(value) {
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => void applyZoom(value), 100);
  }
  async function refocus() {
    const supported = capabilities.focusMode || [];
    if (supported.includes('single-shot')) {
      await constrain('focusMode', 'single-shot');
      if (supported.includes('continuous')) {
        await wait(450);
        if (running) await constrain('focusMode', 'continuous');
      }
    } else if (supported.includes('continuous')) await constrain('focusMode', 'continuous');
    toast('Camera refocus requested. Hold the barcode steady.');
  }
  async function enter(u) {
    try {
      user = u;
      const {data,error} = await db.from('zf_staff').select('full_name,role').eq('user_id',u.id).maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error('This account is not registered as Zaka Fashion staff.');
      $('loginPanel').classList.add('hidden');
      $('scannerMain').classList.remove('hidden');
      $('logout').classList.remove('hidden');
      $('startCamera').disabled = true;
      void refreshCatalog();
      clearInterval(catalogTimer);
      catalogTimer = setInterval(() => { if (!document.hidden) void refreshCatalog(); }, 60000);
      await pair();
    } catch (err) { errorBox(err.message); }
  }
  async function init() {
    icons();
    const params = new URLSearchParams(location.search);
    const supplied = params.get('pair');
    if (supplied) {
      pairSecret = supplied;
      sessionStorage.setItem('zf-scanner-pair', pairSecret);
      history.replaceState({}, '', location.pathname + location.hash);
    } else pairSecret = sessionStorage.getItem('zf-scanner-pair') || '';
    if (!window.supabase) { errorBox('Supabase did not load. Check your internet connection.'); return; }
    db = window.supabase.createClient(PROJECT, KEY, {auth:{persistSession:true,autoRefreshToken:true}});
    $('loginForm').addEventListener('submit', async e => {
      e.preventDefault();
      $('loginBtn').disabled = true;
      $('loginError').classList.add('hidden');
      try {
        const {data,error} = await db.auth.signInWithPassword({email:$('email').value.trim(),password:$('password').value});
        if (error) throw new Error(error.message);
        await enter(data.user);
      } catch (err) { errorBox(err.message); }
      finally { $('loginBtn').disabled = false; }
    });
    $('logout').addEventListener('click', async () => {
      clearInterval(sessionTimer); clearInterval(catalogTimer);
      await stopCamera(); await db.auth.signOut(); location.reload();
    });
    $('startCamera').addEventListener('click', startCamera);
    $('stopCamera').addEventListener('click', stopCamera);
    $('torchBtn').addEventListener('click', toggleTorch);
    $('refocusBtn').addEventListener('click', refocus);
    $('zoomIn').addEventListener('click', () => scheduleZoom((zoom ?? 1) + (capabilities.zoom?.step || .2)));
    $('zoomOut').addEventListener('click', () => scheduleZoom((zoom ?? 1) - (capabilities.zoom?.step || .2)));
    $('zoomRange').addEventListener('input', e => scheduleZoom(e.target.value));
    $('cameraSelect').addEventListener('change', async e => { cameraId = e.target.value; await stopCamera(); await startCamera(); });
    $('soundToggle').addEventListener('click', () => {
      soundOn = !soundOn;
      $('soundToggle').setAttribute('aria-pressed', String(soundOn));
      $('soundToggle').setAttribute('aria-label', soundOn ? 'Turn scan sound off' : 'Turn scan sound on');
      if (soundOn) { unlockAudio(); void beep(); }
    });
    $('testSound').addEventListener('click', () => { void beep(true); });
    $('addAgain').addEventListener('click', () => { if (latestProduct) void sendBarcode(latestProduct.barcode, true); });
    $('manualForm').addEventListener('submit', e => {
      e.preventDefault();
      const value = $('manualCode').value.trim();
      if (value) { void sendBarcode(value, true); $('manualCode').value = ''; }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden && running) void stopCamera(); });
    const {data,error} = await db.auth.getSession();
    if (error) errorBox(error.message);
    else if (data.session) await enter(data.session.user);
  }
  window.addEventListener('DOMContentLoaded', init);
})();

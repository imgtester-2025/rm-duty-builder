/* ---------------------------------------------------------------
   SECURITY / PASSWORD LOCK / ENCRYPTION - optional password protection.
   Uses real AES-GCM encryption (Web Crypto API), not just a UI gate: the
   database is encrypted before it ever touches IndexedDB, and the same
   encrypted bytes are what get written on every save. There is no
   password recovery by design - if it's forgotten, the data is
   genuinely unreadable, which is the whole point of it being real
   encryption. This is a CORE, always-available capability (not a
   toggleable module) - a password itself is opt-in, but the ability to
   set one, and the lock screen that enforces it, are never hidden.
   --------------------------------------------------------------- */
let cryptoKey = null;   // in-memory only; never persisted
let lockSalt = null;    // persisted alongside the ciphertext (not secret)
let lockEnabled = false;

async function deriveKey(password, saltBytes){
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), {name:'PBKDF2'}, false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    // 600,000 iterations matches OWASP's current minimum recommendation for
    // PBKDF2-HMAC-SHA256 (~100ms to derive on typical hardware - imperceptible
    // to a person unlocking the app, but materially raises the cost of an
    // offline password-guessing attempt against a stolen export).
    {name:'PBKDF2', salt: saltBytes, iterations: 600000, hash:'SHA-256'},
    keyMaterial,
    {name:'AES-GCM', length:256},
    false,
    ['encrypt','decrypt']
  );
}
async function encryptBytes(key, plainBytes){
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, plainBytes));
  return {iv, ciphertext};
}
async function decryptBytes(key, iv, ciphertextBytes){
  const plain = await crypto.subtle.decrypt({name:'AES-GCM', iv: new Uint8Array(iv)}, key, new Uint8Array(ciphertextBytes));
  return new Uint8Array(plain);
}

// Chunked base64 <-> bytes (a plain String.fromCharCode(...bytes) spread can
// blow the call stack on a database of any real size).
function bytesToBase64(bytes){
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
function base64ToBytes(b64){
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function wrapEncryptedExport(salt, iv, ciphertext){
  const payload = JSON.stringify({
    format: ENCRYPTED_EXPORT_FORMAT,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext)
  });
  return new TextEncoder().encode(payload);
}

// Promise-based password prompt used by both the export (set a password for
// this backup) and import (enter the password a backup was protected with)
// flows - resolves with the entered password, or null if cancelled.
function showPasswordModal(mode, hintText){
  return new Promise(resolve => {
    const modal = document.getElementById('exportPasswordModal');
    const form = document.getElementById('exportPasswordForm');
    const confirmWrap = document.getElementById('exportPasswordConfirmWrap');
    const errEl = document.getElementById('exportPasswordError');
    const titleEl = document.getElementById('exportPasswordTitle');
    const hintEl = document.getElementById('exportPasswordHint');
    const pwInput = document.getElementById('exportPasswordInput');
    const confirmInput = document.getElementById('exportPasswordConfirmInput');
    const cancelBtn = document.getElementById('exportPasswordCancelBtn');
    const ackCheckbox = document.getElementById('exportPasswordAckCheckbox');

    titleEl.textContent = mode === 'set' ? 'Protect this backup' : 'Enter password to open this backup';
    hintEl.textContent = hintText || '';
    confirmWrap.style.display = mode === 'set' ? '' : 'none';
    errEl.textContent = '';
    pwInput.value = ''; confirmInput.value = ''; ackCheckbox.checked = false;
    modal.classList.add('open');
    setTimeout(() => pwInput.focus(), 50);

    function cleanup(){
      modal.classList.remove('open');
      form.removeEventListener('submit', onSubmit);
      cancelBtn.removeEventListener('click', onCancel);
    }
    function onSubmit(e){
      e.preventDefault();
      const pw = pwInput.value;
      if (mode === 'set') {
        if (pw.length < 10) { errEl.textContent = 'Use at least 10 characters.'; return; }
        if (pw !== confirmInput.value) { errEl.textContent = "Passwords don't match."; return; }
        if (!ackCheckbox.checked) { errEl.textContent = 'Please confirm you understand this password cannot be recovered.'; return; }
      } else if (!pw) {
        errEl.textContent = 'Enter the password.'; return;
      }
      cleanup();
      resolve(pw);
    }
    function onCancel(){ cleanup(); resolve(null); }
    form.addEventListener('submit', onSubmit);
    cancelBtn.addEventListener('click', onCancel);
  });
}

function showLockScreen(){
  document.getElementById('lockScreen').classList.add('open');
  document.getElementById('appShell').style.display = 'none';
  document.getElementById('lockPasswordInput').value = '';
  document.getElementById('lockError').textContent = '';
  setTimeout(() => document.getElementById('lockPasswordInput').focus(), 50);
}
function hideLockScreen(){
  document.getElementById('lockScreen').classList.remove('open');
  document.getElementById('appShell').style.display = '';
}

/* ---------------------------------------------------------------
   AUTO-LOCK / SESSION TIMEOUT - if a password is set, the app locks
   itself automatically after a period of no mouse/keyboard/scroll
   activity, same as a screen lock, so an unattended unlocked device
   isn't a standing access risk. Only ever active when a password is
   actually configured; otherwise there's nothing to lock back to.
   --------------------------------------------------------------- */
let autoLockTimer = null;
const AUTO_LOCK_ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'];
const DEFAULT_AUTO_LOCK_MINUTES = 10;

function getAutoLockMinutes(){
  const row = q("SELECT value FROM settings WHERE key='autoLockMinutes'")[0];
  const v = row ? Number(row.value) : DEFAULT_AUTO_LOCK_MINUTES;
  return (v && v > 0) ? v : DEFAULT_AUTO_LOCK_MINUTES;
}
function resetAutoLockTimer(){
  if (autoLockTimer) { clearTimeout(autoLockTimer); autoLockTimer = null; }
  if (!lockEnabled || !cryptoKey) return; // no password set, or already locked - nothing to arm
  autoLockTimer = setTimeout(performAutoLock, getAutoLockMinutes() * 60 * 1000);
}
function performAutoLock(){
  if (!cryptoKey) return;
  saveState();
  setTimeout(() => {
    cryptoKey = null;
    if (db) { db.close(); db = null; }
    showLockScreen();
  }, 150);
}
function startAutoLockMonitoring(){
  if (!autoLockMonitoringStarted) {
    AUTO_LOCK_ACTIVITY_EVENTS.forEach(evt => document.addEventListener(evt, resetAutoLockTimer, {passive: true}));
    autoLockMonitoringStarted = true;
  }
  resetAutoLockTimer();
}
let autoLockMonitoringStarted = false;

function wireLockScreen(){
  document.getElementById('lockUnlockForm').addEventListener('submit', async e => {
    e.preventDefault();
    const password = document.getElementById('lockPasswordInput').value;
    const errEl = document.getElementById('lockError');
    errEl.textContent = '';
    const stored = await idbLoad();
    if (!stored || stored.format !== 'encrypted') { errEl.textContent = 'No lock data found in this browser.'; return; }
    try {
      const key = await deriveKey(password, new Uint8Array(stored.salt));
      const bytes = await decryptBytes(key, stored.iv, stored.ciphertext);
      cryptoKey = key;
      lockSalt = stored.salt;
      lockEnabled = true;
      hideLockScreen();
      bootWithBytes(bytes);
    } catch (err) {
      errEl.textContent = 'Incorrect password. Try again.';
      document.getElementById('lockPasswordInput').value = '';
      document.getElementById('lockPasswordInput').focus();
    }
  });
}

function updateLockStatusUI(){
  const statusEl = document.getElementById('lockStatusText');
  const setFormEl = document.getElementById('setLockForm');
  const manageEl = document.getElementById('manageLockSection');
  const headerBtn = document.getElementById('lockNowBtn');
  if (!statusEl) return;
  if (lockEnabled) {
    statusEl.textContent = 'A password is set - this system is locked whenever it is not actively unlocked in this browser, and locks itself automatically after a period of inactivity.';
    setFormEl.style.display = 'none';
    manageEl.style.display = '';
    headerBtn.style.display = '';
    const autoLockInput = document.getElementById('autoLockMinutesInput');
    if (autoLockInput) autoLockInput.value = getAutoLockMinutes();
  } else {
    statusEl.textContent = 'No password is set - anyone with access to this browser/device can open this system and see all data in it.';
    setFormEl.style.display = '';
    manageEl.style.display = 'none';
    headerBtn.style.display = 'none';
  }
}

ModuleRegistry.register({
  id: 'security', name: 'Security, Locking & Encryption', core: true,
  description: 'Password lock, AES-GCM encryption of the stored database, auto-lock, and the anonymised demo-copy export. Always available - a password itself is optional, but the ability to set one never is.'
});

function wireLockControls(){
  document.getElementById('downloadAnonymisedBtn').addEventListener('click', () => {
    const bytes = buildAnonymisedCopy();
    const blob = new Blob([bytes], {type: 'application/x-sqlite3'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'rm-duty-builder-ANONYMISED-DEMO-' + toISO(new Date()) + '.sqlite';
    a.click();
    alert('Anonymised copy downloaded. Your data here has not been changed - only the downloaded file is anonymised.');
  });

  document.getElementById('lockNowBtn').addEventListener('click', () => {
    saveState();
    setTimeout(() => {
      cryptoKey = null;
      if (db) { db.close(); db = null; }
      showLockScreen();
      resetAutoLockTimer();
    }, 150); // let the just-triggered encrypted save finish writing first
  });

  document.getElementById('setLockForm').addEventListener('submit', async e => {
    e.preventDefault();
    const p1 = document.getElementById('newLockPassword').value;
    const p2 = document.getElementById('confirmLockPassword').value;
    const errEl = document.getElementById('setLockError');
    if (p1.length < 10) { errEl.textContent = 'Use at least 10 characters.'; return; }
    if (p1 !== p2) { errEl.textContent = "Passwords don't match."; return; }
    if (!document.getElementById('setLockAckCheckbox').checked) { errEl.textContent = 'Please confirm you understand this password cannot be recovered.'; return; }
    errEl.textContent = '';
    lockSalt = crypto.getRandomValues(new Uint8Array(16));
    cryptoKey = await deriveKey(p1, lockSalt);
    lockEnabled = true;
    saveState();
    document.getElementById('newLockPassword').value = '';
    document.getElementById('confirmLockPassword').value = '';
    document.getElementById('setLockAckCheckbox').checked = false;
    updateLockStatusUI();
    resetAutoLockTimer();
    alert('Password set. This system will now ask for it whenever it is opened or unlocked, and will lock itself automatically after ' + getAutoLockMinutes() + ' minutes of inactivity. There is no way to recover this password if it is forgotten - write it down somewhere safe.');
  });

  document.getElementById('changeLockBtn').addEventListener('click', async () => {
    const p1 = prompt('New password:');
    if (!p1) return;
    if (p1.length < 10) { alert('Use at least 10 characters.'); return; }
    const p2 = prompt('Confirm new password:');
    if (p1 !== p2) { alert("Passwords don't match - password not changed."); return; }
    lockSalt = crypto.getRandomValues(new Uint8Array(16));
    cryptoKey = await deriveKey(p1, lockSalt);
    saveState();
    resetAutoLockTimer();
    alert('Password changed.');
  });

  document.getElementById('removeLockBtn').addEventListener('click', () => {
    if (!confirm('Remove the password lock? Anyone with access to this browser will then be able to open this system freely.')) return;
    cryptoKey = null;
    lockSalt = null;
    lockEnabled = false;
    saveState();
    updateLockStatusUI();
    resetAutoLockTimer();
  });

  document.getElementById('autoLockMinutesInput').addEventListener('change', e => {
    let mins = Math.round(Number(e.target.value));
    if (!mins || mins < 1) mins = DEFAULT_AUTO_LOCK_MINUTES;
    if (mins > 240) mins = 240;
    e.target.value = mins;
    run("INSERT INTO settings (key, value) VALUES ('autoLockMinutes', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [String(mins)]);
    saveState();
    resetAutoLockTimer();
  });
}



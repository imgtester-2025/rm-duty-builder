/* ---------------------------------------------------------------
   BACKUP / DATABASE IMPORT-EXPORT - the header's "Import backup" /
   "Export backup" controls. CORE - never optional, since this is the
   only way to get data off/onto this device at the database level.
   Always produces (and requires, for a non-plaintext .sqlite file) an
   AES-GCM encrypted .rmvault file - see services/security.js.
   --------------------------------------------------------------- */
ModuleRegistry.register({
  id: 'backup', name: 'Database Backup Import/Export', core: true,
  description: 'The header\'s "Import backup" / "Export backup" controls - the encrypted, whole-database backup format. Always available.'
});

function wireBackupControls(){
  document.getElementById('exportDbBtn').addEventListener('click', async () => {
    const bytes = db.export();
    let salt, key;
    if (cryptoKey) {
      // Already locked/unlocked this session - reuse the same password, no extra prompt.
      key = cryptoKey; salt = lockSalt;
    } else {
      const pw = await showPasswordModal('set',
        "This system doesn't currently have a password set, so choose one now to protect this backup file - you'll need it to open the file again later.");
      if (pw === null) return; // cancelled - no unprotected file is ever written
      salt = crypto.getRandomValues(new Uint8Array(16));
      key = await deriveKey(pw, salt);
    }
    const {iv, ciphertext} = await encryptBytes(key, bytes);
    const outBytes = wrapEncryptedExport(salt, iv, ciphertext);
    const blob = new Blob([outBytes], {type: 'application/octet-stream'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'rm-duty-builder-' + toISO(new Date()) + '.rmvault';
    a.click();
    alert('Encrypted backup downloaded. There is no way to recover this file without its password, so keep it safe.');
  });
  document.getElementById('importDbInput').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    const buf = new Uint8Array(await file.arrayBuffer());

    const SQLITE_MAGIC = 'SQLite format 3\u0000';
    const looksLikeSqlite = buf.length > 16 && new TextDecoder().decode(buf.subarray(0, 16)) === SQLITE_MAGIC;
    const wasPlaintextImport = looksLikeSqlite;

    let finalBytes = buf;
    if (!looksLikeSqlite) {
      let parsed = null;
      try { parsed = JSON.parse(new TextDecoder().decode(buf)); } catch (err) { parsed = null; }

      if (parsed && parsed.format === ENCRYPTED_EXPORT_FORMAT) {
        const pw = await showPasswordModal('enter', 'This backup is password-protected. Enter the password it was created with.');
        if (pw === null) { e.target.value = ''; return; }
        try {
          const salt = base64ToBytes(parsed.salt);
          const iv = base64ToBytes(parsed.iv);
          const ciphertext = base64ToBytes(parsed.ciphertext);
          const key = await deriveKey(pw, salt);
          finalBytes = await decryptBytes(key, iv, ciphertext);
          // The import succeeded, proving the password is right - carry that
          // same protection forward into the live app, rather than leaving
          // this data unprotected just because it's now been imported.
          cryptoKey = key; lockSalt = salt; lockEnabled = true;
        } catch (err) {
          alert('Incorrect password, or this file is damaged - import cancelled.');
          e.target.value = '';
          return;
        }
      } else {
        alert("This doesn't look like a valid RM Duty Builder backup (.sqlite, .db, or an encrypted export from this system).");
        e.target.value = '';
        return;
      }
    }

    db = new SQL.Database(finalBytes);
    db.run(SCHEMA);
    migrateSchema();
    saveState();
    renderEverything();
    updateLockStatusUI();
    resetAutoLockTimer();
    e.target.value = '';

    if (wasPlaintextImport) {
      if (!lockEnabled) {
        alert("Imported. This was an unencrypted (.sqlite/.db) file, so the data it contained was readable as plain text - including on whatever computer or drive it came from. This system currently has no password set, so it will keep being stored unencrypted here too.\n\nGo to Settings \u2192 Security to set a password now, and consider securely deleting the plaintext file you just imported once you've confirmed everything came in correctly.");
      } else {
        alert("Imported. This was an unencrypted (.sqlite/.db) file - it will be encrypted going forward here since a password is already set, but consider securely deleting the plaintext copy you imported from, since it still contains readable data.");
      }
    }
  });
}

/* RAJ Co. on Firebase — compatibility layer.
 * The Bunwich page was written for claude.ai artifacts and talks to
 * `window.claude.use(name)`. This file provides the same interface on top of
 * Firebase (Auth + Firestore [+ Storage]) so the app code stays the same.
 * It also exposes `window.FB` with the login / user-management helpers the
 * Firebase build of the page calls.
 */
(function () {
  'use strict';
  const CFG = window.RAJCO_FIREBASE || {};
  const app = firebase.initializeApp(CFG.config);
  const auth = firebase.auth();
  const fs = firebase.firestore();
  try { fs.settings({ ignoreUndefinedProperties: true, merge: true }); } catch (e) {}
  try { fs.enablePersistence({ synchronizeTabs: true }).catch(() => {}); } catch (e) {}
  const DOMAIN = (CFG.STAFF_DOMAIN || 'rajco.app').toLowerCase();
  const OWNER_EMAIL = String(CFG.OWNER_EMAIL || '').trim().toLowerCase();

  // ---------- state ----------
  let readyResolve; const ready = new Promise(r => (readyResolve = r));
  let me = null;            // {uid, username, role}
  let members = null;       // meta/members document body
  let unsubMembers = null;

  let logins = null; // public map username -> login email (staff accounts are re-created on «كود دخول جديد»)
  async function loadLogins() { try { const d = await fs.doc('meta/logins').get(); logins = d.exists ? d.data() : {}; } catch (e) { logins = logins || {}; } return logins; }
  const emailOf = name => (name === 'owner' ? OWNER_EMAIL : ((logins && logins[name]) || (name + '@' + DOMAIN)));
  const err = (code, message) => Object.assign(new Error(message || code), { code });

  function watchMembers() {
    if (unsubMembers) return;
    unsubMembers = fs.doc('meta/members').onSnapshot(s => { members = s.exists ? s.data() : null; }, () => {});
  }
  async function loadMembers() {
    const s = await fs.doc('meta/members').get();
    members = s.exists ? s.data() : null; return members;
  }

  // ---------- login ----------
  async function needsSetup() {
    try { const s = await fs.doc('meta/public').get(); return !s.exists; }
    catch (e) { console.warn('meta/public', e); return false; }
  }
  function mapAuthError(e) {
    const c = (e && e.code) || '';
    if (/network/.test(c)) return 'network';
    if (/too-many-requests/.test(c)) return 'too_many';
    if (/user-disabled/.test(c)) return 'disabled';
    if (/weak-password/.test(c)) return 'weak';
    if (/email-already-in-use/.test(c)) return 'exists';
    if (/operation-not-allowed|configuration-not-found|admin-restricted/.test(c)) return 'auth_off';
    if (/api-key|app-not-authorized|unauthorized-domain|invalid-api-key/.test(c)) return 'bad_config';
    if (/invalid-credential|wrong-password|user-not-found|invalid-email|invalid-login/.test(c)) return 'bad_login';
    return 'other:' + c;
  }
  async function finishLogin(name, uid) {
    await loadMembers().catch(() => null);
    let role = null;
    if (members && members.owner === uid) role = 'OWNER';
    else if (members && members.users && members.users[name] && members.users[name].uid === uid) {
      const u = members.users[name];
      if (!u.active) { await auth.signOut(); return { ok: false, code: 'inactive' }; }
      role = u.role || 'TELLER';
    }
    if (!role) { await auth.signOut(); return { ok: false, code: 'not_member' }; }
    me = { uid, username: name, role };
    watchMembers();
    readyResolve();
    return { ok: true, role };
  }
  async function signIn(name, pw) {
    name = String(name || '').trim().toLowerCase();
    if (!name || !pw) return { ok: false, code: 'bad_login' };
    if (name === 'owner' && !OWNER_EMAIL) return { ok: false, code: 'no_owner_email' };
    if (name !== 'owner') await loadLogins();
    const tries = [pw]; const nc = String(pw).toUpperCase().replace(/[^A-Z0-9]/g, ''); if (nc && nc !== pw) tries.push(nc); // first login with the invite code
    let last = null;
    for (const p of tries) {
      try { const cred = await auth.signInWithEmailAndPassword(emailOf(name), p); return await finishLogin(name, cred.user.uid); }
      catch (e) { last = e; if (!/invalid-credential|wrong-password|user-not-found|invalid-login/.test(e.code || '')) break; }
    }
    return { ok: false, code: mapAuthError(last) };
  }
  async function setupOwner(pw) {
    if (!OWNER_EMAIL) return { ok: false, code: 'no_owner_email' };
    let cred;
    try { cred = await auth.createUserWithEmailAndPassword(OWNER_EMAIL, pw); }
    catch (e) {
      if (/email-already-in-use/.test(e.code || '')) {
        try { cred = await auth.signInWithEmailAndPassword(OWNER_EMAIL, pw); }
        catch (e2) { return { ok: false, code: 'exists' }; }
      } else return { ok: false, code: mapAuthError(e) };
    }
    const uid = cred.user.uid;
    try {
      // create (or, for a retried half-finished setup, keep) the members doc; another owner -> denied by the rules
      let cur = null; try { cur = await fs.doc('meta/members').get(); } catch (e) { cur = null; }
      if (cur && cur.exists && cur.data().owner !== uid) { await auth.signOut(); return { ok: false, code: 'owner_taken' }; }
      if (!cur || !cur.exists) {
        try { await fs.doc('meta/members').set({ owner: uid, ownerEmail: OWNER_EMAIL, users: {}, createdAt: Date.now() }); }
        catch (e) { await auth.signOut(); return { ok: false, code: 'owner_taken' }; }
      }
      await fs.doc('meta/public').set({ ownerUid: uid, setupAt: Date.now() });
      try { await fs.doc('meta/logins').set({}); } catch (e) {}
    } catch (e) { await auth.signOut(); return { ok: false, code: 'rules' }; }
    return await finishLogin('owner', uid);
  }
  async function signOut() { try { await auth.signOut(); } catch (e) {} }
  async function ownerReset() {
    if (!OWNER_EMAIL) throw err('no_owner_email');
    await auth.sendPasswordResetEmail(OWNER_EMAIL);
  }
  async function changePassword(oldPw, newPw) {
    const u = auth.currentUser; if (!u) throw err('signed_out');
    const c = firebase.auth.EmailAuthProvider.credential(u.email, oldPw);
    try { await u.reauthenticateWithCredential(c); } catch (e) { throw err('bad_old'); }
    try { await u.updatePassword(newPw); } catch (e) { throw err(mapAuthError(e)); }
  }

  // ---------- user management (owner) ----------
  // A second Firebase app instance creates the account without signing the owner out.
  async function provisionStaff(username, secret, role, active) {
    const sec = firebase.initializeApp(CFG.config, 'sec' + Date.now());
    const email = username + '+' + Math.random().toString(36).slice(2, 7) + '@' + DOMAIN;
    let uid;
    try { const cred = await sec.auth().createUserWithEmailAndPassword(email, secret); uid = cred.user.uid; await sec.auth().signOut(); }
    catch (e) { throw err(mapAuthError(e)); }
    finally { try { await sec.delete(); } catch (e) {} }
    const cur = (await loadMembers()) || {};
    const users = Object.assign({}, cur.users || {}); users[username] = { uid, email, role: role || 'TELLER', active: active !== false };
    await fs.doc('meta/members').update({ users, updatedAt: Date.now() });
    const lg = Object.assign({}, (await loadLogins()) || {}); lg[username] = email;
    await fs.doc('meta/logins').set(lg);
    return uid;
  }
  async function syncMembers(list) {
    if (!me || me.role !== 'OWNER') return;
    const cur = (await loadMembers()) || {};
    const users = {};
    (list || []).forEach(x => { const prev = (cur.users || {})[x.u]; if (prev && prev.uid) users[x.u] = Object.assign({}, prev, { role: x.role || 'TELLER', active: !!x.active }); });
    await fs.doc('meta/members').update({ users, updatedAt: Date.now() });
  }
  async function setPassword(pw) {
    const u = auth.currentUser; if (!u) throw err('signed_out');
    try { await u.updatePassword(pw); } catch (e) { throw err(/recent-login/.test(e.code || '') ? 'recent' : mapAuthError(e)); }
  }

  // ---------- assets (optional, needs Cloud Storage) ----------
  const bucket = CFG.config && CFG.config.storageBucket;
  const blob = id => CFG.USE_STORAGE && bucket
    ? 'https://firebasestorage.googleapis.com/v0/b/' + bucket + '/o/' + encodeURIComponent('assets/' + id) + '?alt=media'
    : '';
  const assetsApi = (CFG.USE_STORAGE && firebase.storage) ? Object.freeze({
    async upload(file) {
      if (file.size > 20 * 1024 * 1024) throw err('too_large');
      const t = file.type || '';
      if (!/^image\//.test(t) && t !== 'application/pdf') throw err('unsupported_type');
      const id = fs.collection('x').doc().id;
      await firebase.storage().ref('assets/' + id).put(file, { contentType: t });
      return { id, url: blob(id), sizeBytes: file.size, contentType: t };
    },
    async delete(id) { await firebase.storage().ref('assets/' + id).delete(); },
    async list() { return { assets: [], usage: null }; }
  }) : null;

  // ---------- downloads ----------
  const downloadsApi = Object.freeze({
    async save({ filename, data }) {
      const b = data instanceof Blob ? data : new Blob([data]);
      const u = URL.createObjectURL(b);
      const a = document.createElement('a'); a.href = u; a.download = filename || 'file';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 30000);
    }
  });

  // ---------- user capability ----------
  const userApi = Object.freeze({
    async isOwner() { return !!me && me.role === 'OWNER'; },
    async canEdit() { return !!me && (me.role === 'OWNER' || me.role === 'ADMIN'); },
    async can() { return !!me; },
    async id() { return me ? me.uid : null; },
    async me() { return { id: me ? me.uid : null, name: me ? me.username : '' }; },
    async profiles(ids) {
      const out = {}; const m = members || {};
      const byUid = {}; Object.entries(m.users || {}).forEach(([n, u]) => { if (u && u.uid) byUid[u.uid] = n; });
      if (m.owner) byUid[m.owner] = 'owner';
      (ids || []).forEach(i => { out[i] = { id: i, name: byUid[i] || '' }; });
      return out;
    },
    async search() { return []; }
  });

  // ---------- window.claude compatibility ----------
  const after = v => ready.then(() => v);
  window.claude = Object.freeze({
    use(name) {
      if (name === 'db') return after(fs);
      if (name === 'user') return after(userApi);
      if (name === 'assets') return after(assetsApi);
      if (name === 'downloads') return Promise.resolve(downloadsApi);
      return Promise.resolve(null); // mcp, sample, room… not available outside claude.ai
    }
  });

  window.FB = Object.freeze({
    ready, needsSetup, signIn, setupOwner, signOut, ownerReset, changePassword,
    provisionStaff, syncMembers, setPassword, blob,
    me: () => me, ownerEmail: OWNER_EMAIL, configured: !!(CFG.config && CFG.config.apiKey && !/^PASTE/.test(CFG.config.apiKey))
  });

  // ---------- PWA: service worker + install button ----------
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
  let deferred = null;
  function installBtn() {
    let b = document.getElementById('pwaInstall');
    if (!b) {
      b = document.createElement('button'); b.id = 'pwaInstall'; b.type = 'button';
      b.textContent = '📲 تثبيت التطبيق';
      b.style.cssText = 'position:fixed;bottom:calc(16px + env(safe-area-inset-bottom,0px));inset-inline-start:16px;z-index:9999;border:0;border-radius:999px;padding:10px 16px;font:600 14px "IBM Plex Sans Arabic",system-ui,sans-serif;background:#6B3F24;color:#fff;box-shadow:0 8px 20px #0003;cursor:pointer';
      b.onclick = async () => {
        if (deferred) { deferred.prompt(); try { await deferred.userChoice; } catch (e) {} deferred = null; b.remove(); }
        else alert('على الآيفون: دوس زرار المشاركة ⬆️ وبعدين «Add to Home Screen».');
      };
      document.body.appendChild(b);
    }
  }
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; if (!standalone()) installBtn(); });
  window.addEventListener('appinstalled', () => { const b = document.getElementById('pwaInstall'); if (b) b.remove(); });
  const iOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (iOS && !standalone()) window.addEventListener('load', installBtn);
})();

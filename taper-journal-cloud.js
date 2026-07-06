/* ============================================================
   TAPER JOURNAL CLOUD SYNC — the true fix for durability.
   Optional layer. If not configured, everything falls back to
   local-only (localStorage + IndexedDB) exactly as before.
   Load order: firebase-sdk.bundle.js -> this file -> taper-journal-core.js
   ============================================================ */

var TJCloud = (function () {
  var app = null, auth = null, db = null, uid = null, ready = null;
  var queue = []; // writes attempted while offline/not-yet-authed get queued and retried
  var configured = false;

  function init(firebaseConfig) {
    if (!firebaseConfig || !firebaseConfig.apiKey) { return Promise.resolve(false); }
    configured = true;
    var sdk = window.FirebaseSDK;
    try {
      app = sdk.initializeApp(firebaseConfig);
      auth = sdk.getAuth(app);
      db = sdk.getFirestore(app);
    } catch (e) {
      console.warn('Cloud sync unavailable, continuing local-only:', e);
      configured = false;
      return Promise.resolve(false);
    }

    ready = new Promise(function (resolve) {
      sdk.onAuthStateChanged(auth, function (user) {
        if (user) {
          uid = user.uid;
          try { localStorage.setItem('tj_uid', uid); } catch (e) {}
          flushQueue();
          resolve(true);
        }
      });
      sdk.signInAnonymously(auth).catch(function (err) {
        console.warn('Cloud sign-in failed, continuing local-only:', err);
        resolve(false);
      });
    });
    return ready;
  }

  function flushQueue() {
    if (!queue.length) return;
    var pending = queue.slice(); queue = [];
    pending.forEach(function (item) { pushDoc(item.key, item.value); });
  }

  function pushDoc(key, value) {
    if (!configured) return Promise.resolve();
    if (!uid) { queue.push({ key: key, value: value }); return Promise.resolve(); }
    var sdk = window.FirebaseSDK;
    try {
      var ref = sdk.doc(db, 'journals', uid, 'kv', key);
      return sdk.setDoc(ref, { value: value, updatedAt: sdk.serverTimestamp() })
        .catch(function (err) {
          console.warn('Cloud sync write failed (will retry next save):', err);
          queue.push({ key: key, value: value }); // retry on next successful write cycle
        });
    } catch (e) {
      queue.push({ key: key, value: value });
      return Promise.resolve();
    }
  }

  function pullAll() {
    if (!configured) return Promise.resolve({});
    return (ready || Promise.resolve(false)).then(function () {
      if (!uid) return {};
      var sdk = window.FirebaseSDK;
      return sdk.getDocs(sdk.collection(db, 'journals', uid, 'kv')).then(function (snap) {
        var out = {};
        snap.forEach(function (d) { out[d.id] = d.data().value; });
        return out;
      }).catch(function (err) {
        console.warn('Cloud restore failed, using local data:', err);
        return {};
      });
    });
  }

  return { init: init, push: pushDoc, pullAll: pullAll, isConfigured: function(){ return configured; } };
})();

/* ============================================================
   SETUP — one time, per business (not per customer):

   1. console.firebase.google.com -> Create project (free Spark plan
      is plenty for this use case).
   2. Build > Firestore Database > Create database > production mode.
   3. Build > Authentication > Sign-in method > enable "Anonymous".
   4. Firestore > Rules, paste exactly this and Publish:

      rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /journals/{uid}/kv/{doc} {
            allow read, write: if request.auth != null && request.auth.uid == uid;
          }
        }
      }

      This is what makes it secure: each customer's browser signs in
      anonymously and gets a random uid, and that rule means a customer
      can only ever read or write their own uid's folder. One customer
      can never see another's data, even though they all share one
      Firebase project.

   5. Project settings (gear icon) > General > scroll to "Your apps" >
      Add app > Web. Copy the firebaseConfig object it gives you.

   6. In each journal's index.html, near the top of the inline script,
      before anything else runs:

        TJCloud.init({
          apiKey: "...",
          authDomain: "...",
          projectId: "...",
          storageBucket: "...",
          messagingSenderId: "...",
          appId: "..."
        });

      Paste the actual values from step 5. That's the only per-deploy
      step, it's the same six values for every customer's journal since
      they all share the one project and are isolated by uid.
   ============================================================ */

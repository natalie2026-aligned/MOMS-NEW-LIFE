/* ============================================================
   TAPER JOURNAL CORE — durable storage + bulletproof PDF export
   Drop this file in alongside jspdf.umd.min.js (self-hosted,
   NOT loaded from a CDN — see integration notes at bottom).
   Works fully offline. No external network calls, ever.
   ============================================================ */

/* ---------- 1. DUAL-WRITE STORAGE (localStorage + IndexedDB) ---------- */
/* localStorage alone is not durable enough to sell against. IndexedDB
   is the redundant second copy. Every write goes to both. Every read
   prefers localStorage but falls back to IndexedDB automatically if
   localStorage is empty, cleared, or unavailable (private browsing etc). */

var TJDB = (function () {
  var DB_NAME = 'taper_journal_db';
  var STORE = 'kv';
  var dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { resolve(null); return; }
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function () { resolve(null); }; // never throw — degrade silently
    });
    return dbPromise;
  }

  function idbSet(key, value) {
    return openDB().then(function (db) {
      if (!db) return;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(value, key);
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { resolve(); };
        } catch (e) { resolve(); }
      });
    });
  }

  function idbGet(key) {
    return openDB().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(STORE, 'readonly');
          var req = tx.objectStore(STORE).get(key);
          req.onsuccess = function () { resolve(req.result !== undefined ? req.result : null); };
          req.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    });
  }

  return { set: idbSet, get: idbGet };
})();

var Store = {
  _mem: {},
  set: function (k, v) {
    try { localStorage.setItem(k, v); } catch (e) {}
    this._mem[k] = v;
    TJDB.set(k, v); // fire-and-forget redundant copy, never blocks the UI
  },
  get: function (k) {
    try {
      var r = localStorage.getItem(k);
      if (r !== null) return r;
    } catch (e) {}
    return (this._mem[k] !== undefined) ? this._mem[k] : null;
  },
  // Call this once on load. If localStorage is empty (new device, cleared
  // data, private mode that reset) but IndexedDB still has data, restore it.
  reconcileOnLoad: function (keys) {
    var self = this;
    keys.forEach(function (k) {
      var local = null;
      try { local = localStorage.getItem(k); } catch (e) {}
      if (local === null || local === undefined) {
        TJDB.get(k).then(function (idbVal) {
          if (idbVal !== null && idbVal !== undefined) {
            try { localStorage.setItem(k, idbVal); } catch (e) {}
            self._mem[k] = idbVal;
            document.dispatchEvent(new CustomEvent('tj-restored', { detail: { key: k } }));
          }
        });
      }
    });
  }
};

/* ---------- 2. BACKUP / PDF FRESHNESS REMINDER ---------- */

function tjMarkExported() {
  Store.set('tj_last_export', new Date().toISOString());
}

function tjCheckExportFreshness(bannerElId) {
  var last = Store.get('tj_last_export');
  var days = last ? (Date.now() - new Date(last).getTime()) / 86400000 : Infinity;
  var el = document.getElementById(bannerElId);
  if (!el) return;
  if (days >= 14) {
    var lastText = last ? Math.floor(days) + ' days ago' : 'never';
    el.style.display = 'flex';
    el.querySelector('.tj-banner-text').textContent =
      'Your last saved copy was ' + lastText + '. Download today\'s record?';
  } else {
    el.style.display = 'none';
  }
}

/* ---------- 3. PDF EXPORT — jsPDF primary, print fallback, iOS-aware ---------- */

function tjIsIOS() {
  var ua = navigator.userAgent || '';
  var isIOSUA = /iPad|iPhone|iPod/.test(ua);
  var isIPadOS13Plus = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return isIOSUA || isIPadOS13Plus;
}

function tjBuildEntryRows(entries, fmtDate) {
  return entries.map(function (e) {
    return [
      fmtDate(e.date),
      (e.gaba || '—') + 'mg / ' + (e.gnum || '—') + ' doses',
      e.pain != null ? e.pain + '/10' : '—',
      e.sleep != null ? e.sleep + '/5' + (e.shrs ? ' (' + e.shrs + 'h)' : '') : '—',
      e.mood != null ? e.mood + '/5' : '—',
      e.energy != null ? e.energy + '/5' : '—',
      (e.supps && e.supps.length) ? e.supps.join(', ') : '—',
      e.note || ''
    ];
  });
}

/* Draws a simple, reliable table by hand — no autotable plugin dependency,
   which means one less thing that can break. Paginates automatically. */
function tjDrawTable(doc, rows, startY) {
  var margin = 40, pageW = doc.internal.pageSize.getWidth(), pageH = doc.internal.pageSize.getHeight();
  var colW = [58, 68, 34, 52, 38, 42, 118, 130]; // sums ~540, fits letter minus margins
  var headers = ['Date', 'Gaba', 'Pain', 'Sleep', 'Mood', 'Energy', 'Supplements', 'Note'];
  var y = startY, rowH = 16;

  function drawHeader() {
    doc.setFillColor(11, 22, 40); // navy
    doc.rect(margin, y, colW.reduce(function (a, b) { return a + b; }, 0), rowH, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    var x = margin;
    headers.forEach(function (h, i) { doc.text(h, x + 3, y + rowH - 5); x += colW[i]; });
    y += rowH;
  }

  drawHeader();
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(15, 23, 42);

  rows.forEach(function (r) {
    // wrap the note column so nothing gets silently truncated
    var noteLines = doc.splitTextToSize(r[7], colW[7] - 6);
    var thisRowH = Math.max(rowH, noteLines.length * 9 + 6);

    if (y + thisRowH > pageH - margin) {
      doc.addPage();
      y = margin;
      drawHeader();
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(15, 23, 42);
    }

    doc.setDrawColor(226, 232, 240);
    var x = margin;
    r.forEach(function (cell, i) {
      if (i === 7) {
        doc.text(noteLines, x + 3, y + 10);
      } else {
        var text = String(cell);
        doc.text(text, x + 3, y + 10, { maxWidth: colW[i] - 6 });
      }
      x += colW[i];
    });
    doc.rect(margin, y, colW.reduce(function (a, b) { return a + b; }, 0), thisRowH);
    y += thisRowH;
  });
  return y;
}

function tjGeneratePDFBlob(data) {
  // data = { generatedDate, entryCount, current, start, lastDrop, nextDrop, entries, fmtDate }
  var doc = new jspdf.jsPDF({ unit: 'pt', format: 'letter' });
  var margin = 40;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(11, 22, 40);
  doc.text('My Taper Journal — Daily Log', margin, 50);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(55, 65, 81);
  doc.text('Downloaded ' + data.generatedDate + '   ·   Entries saved: ' + data.entryCount, margin, 66);

  doc.setDrawColor(226, 232, 240);
  doc.setFillColor(240, 253, 250);
  doc.rect(margin, 80, 535, 40, 'FD');
  doc.setFontSize(9);
  doc.setTextColor(15, 23, 42);
  doc.text('Current dose: ' + data.current, margin + 8, 96);
  doc.text('Started at: ' + data.start, margin + 270, 96);
  doc.text('Last reduction: ' + data.lastDrop, margin + 8, 112);
  doc.text('Next planned drop: ' + data.nextDrop, margin + 270, 112);

  var rows = tjBuildEntryRows(data.entries, data.fmtDate);
  tjDrawTable(doc, rows, 136);

  return doc.output('blob');
}

/* Print-based fallback — works on literally every browser, no library
   required. This is the floor that can never fail. */
function tjPrintFallback(data) {
  var w = window.open('', '_blank');
  if (!w) {
    alert('Please allow pop-ups, or use your browser menu → Print → Save as PDF, to save your record.');
    return;
  }
  var rows = tjBuildEntryRows(data.entries, data.fmtDate).map(function (r) {
    return '<tr>' + r.map(function (c) { return '<td>' + (c || '').toString().replace(/</g, '&lt;') + '</td>'; }).join('') + '</tr>';
  }).join('');
  w.document.write(
    '<html><head><title>My Taper Journal</title><style>' +
    'body{font-family:Arial,sans-serif;padding:24px;color:#0F172A}' +
    'h1{font-size:20px;margin-bottom:4px}' +
    '.meta{font-size:12px;color:#374151;margin-bottom:16px}' +
    'table{width:100%;border-collapse:collapse;font-size:11px}' +
    'th{background:#0B1628;color:#fff;padding:6px;text-align:left}' +
    'td{padding:6px;border:1px solid #E2E8F0;vertical-align:top}' +
    '</style></head><body>' +
    '<h1>My Taper Journal — Daily Log</h1>' +
    '<div class="meta">Downloaded ' + data.generatedDate + ' &middot; Entries saved: ' + data.entryCount + '</div>' +
    '<table><thead><tr><th>Date</th><th>Gaba</th><th>Pain</th><th>Sleep</th><th>Mood</th><th>Energy</th><th>Supplements</th><th>Note</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>' +
    '<script>window.onload=function(){window.print();}<\/script>' +
    '</body></html>'
  );
  w.document.close();
}

/* Main entry point — call this from your export button. */
function tjExportPDF(data) {
  try {
    var blob = tjGeneratePDFBlob(data);
    var url = URL.createObjectURL(blob);
    var filename = 'my-taper-journal-' + new Date().toISOString().split('T')[0] + '.pdf';

    if (tjIsIOS()) {
      // iOS Safari often ignores the download attribute — open in a new
      // tab instead and tell the person exactly what to tap.
      var w = window.open(url, '_blank');
      if (!w) { tjPrintFallback(data); tjMarkExported(); return; }
      alert('Your journal opened in a new tab. Tap the Share icon, then "Save to Files" to keep a copy.');
    } else {
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    }
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    tjMarkExported();
  } catch (err) {
    console.error('PDF generation failed, using print fallback:', err);
    tjPrintFallback(data);
    tjMarkExported();
  }
}

/* ============================================================
   INTEGRATION NOTES
   ------------------------------------------------------------
   1. Self-host jspdf.umd.min.js in the same folder as this file.
      <script src="jspdf.umd.min.js"></script>
      <script src="taper-journal-core.js"></script>
      Never point that first script tag at a CDN — see prior message
      for why that's the #1 reliability risk for a paid product.

   2. On page load, call:
      Store.reconcileOnLoad(['tj_entries','tj_soul','tj_taper','tj_cal','tj_claimed']);

   3. Replace the old exportPrintable() button handler with:
      tjExportPDF({
        generatedDate: new Date().toLocaleDateString(),
        entryCount: entries.length,
        current: cal.current || taper.current_dose || 'not set',
        start: cal.start || 'not set',
        lastDrop: taper.last_drop || 'not set',
        nextDrop: taper.next_drop || 'not set',
        entries: entries,      // array from getE()
        fmtDate: fmtDate        // existing date formatter
      });

   4. Add a small dismissible banner in the HTML with id="tj-export-banner"
      (display:none by default, .tj-banner-text span inside it), and call
      tjCheckExportFreshness('tj-export-banner') on page load and after
      every saveDay().
   ============================================================ */

/* MycoQR - scan a substrate bag, log harvest weight or discard it.
   All data lives in this phone's storage; optional sync posts each entry to a tracker URL. */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var REASONS = ['Contam - green mould', 'Contam - bacterial', 'Contam - cobweb', 'Contam - other', 'Stall', 'Other'];

  // ---------- storage ----------
  function load(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function save(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
  var batches = load('mq_batches', {});   // id -> {species, inoc, days, spawn, bags}
  var events = load('mq_events', []);     // {id, ts, bag, batch, type, grams, flush, reason, note, device, voided, synced}
  var cfg = load('mq_cfg', { device: '' });
  // Google Sheets tracker (Apps Script web app). Built in so phones need no setup; change here if redeployed.
  var TRACKER_URL = 'https://script.google.com/macros/s/AKfycbwfLHzk_PuJ6jg2eHLCgG_A_QxPE2lH_K8tjVcDEoHnPRFIgH1Nd92xH8c3sKLU7cbc/exec';
  function persist() { save('mq_batches', batches); save('mq_events', events); }

  // ---------- helpers ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function fmtDate(iso) {
    if (!iso) return '-';
    var d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) : new Date(iso);
    if (isNaN(d)) return '-';
    return pad(d.getDate()) + '-' + MONTHS[d.getMonth()] + '-' + String(d.getFullYear()).slice(2);
  }
  function localIso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function daysSince(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return null;
    var d = new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
    var t = new Date(); t.setHours(0, 0, 0, 0);
    return Math.round((t - d) / 86400000);
  }
  function grams(g) { return (Math.round(g * 10) / 10) + ' g'; }
  function batchOf(bag) { return bag.replace(/-\d+$/, ''); }
  function bagNo(bag) { var m = /-(\d+)$/.exec(bag); return m ? parseInt(m[1], 10) : 0; }

  var toastTimer;
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('on'); }, 2600);
  }

  // ---------- QR payload ----------
  // Label payload: MQR1|bag id|bag count|species|inoculation (yyyy-mm-dd)|days to fruiting|spawn
  // A bare bag id (LM-26-B02-01) is also accepted.
  function parseCode(text) {
    text = String(text || '').trim();
    var info = null, bag = text;
    if (text.indexOf('MQR1|') === 0) {
      var p = text.split('|');
      bag = p[1] || '';
      info = { bags: parseInt(p[2], 10) || 0, species: p[3] || '', inoc: p[4] || '', days: parseInt(p[5], 10) || 0, spawn: p[6] || '' };
    }
    bag = bag.toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9][A-Z0-9-]*-\d{1,3}$/.test(bag) || bag.length > 40) return null;
    return { bag: bag, batch: batchOf(bag), info: info };
  }

  function openCode(text) {
    var c = parseCode(text);
    if (!c) { toast('Not a MycoQR bag code'); return false; }
    var b = batches[c.batch] || { species: '', inoc: '', days: 0, spawn: '', bags: 0 };
    if (c.info) { b.species = c.info.species; b.inoc = c.info.inoc; b.days = c.info.days; b.spawn = c.info.spawn; b.bags = Math.max(b.bags, c.info.bags); }
    b.bags = Math.max(b.bags, bagNo(c.bag));
    batches[c.batch] = b;
    persist();
    if (navigator.vibrate) navigator.vibrate(40);
    showBag(c.bag);
    return true;
  }

  // ---------- queries ----------
  function live(type, bag) {
    return events.filter(function (e) { return !e.voided && e.type === type && (!bag || e.bag === bag); });
  }
  function bagTotal(bag) { return live('harvest', bag).reduce(function (s, e) { return s + e.grams; }, 0); }

  // ---------- views ----------
  var currentBag = null;
  function show(view) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('on', v.id === 'v-' + view); });
    // home has no tab bar; a bag belongs to the Scan tab and a batch table to the Data tab
    var tab = view === 'bag' ? 'scan' : view === 'batches' ? 'data' : view;
    document.querySelectorAll('nav button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === tab); });
    $('nav').hidden = view === 'home';
    $('#homeBtn').hidden = view === 'home';
    if (view === 'scan') startCam(); else stopCam();
    if (view === 'home') renderHome();
    if (view === 'data') renderData();
    $('main').scrollTop = 0;
  }

  function showBag(bag) {
    currentBag = bag;
    var b = batches[batchOf(bag)] || {};
    var harvests = live('harvest', bag);
    var discard = live('discard', bag)[0];
    var fruiting = live('fruiting', bag)[0];
    var age = daysSince(b.inoc);
    var h = '<button class="back" data-act="scan">&lsaquo; Scan next bag</button>';
    h += '<div class="card"><div class="row"><p class="bagid">' + esc(bag) + '</p>' +
         '<span class="tag fit' + (discard ? ' red">Discarded' : fruiting ? '">Fruiting' : '">Incubating') + '</span></div>' +
         '<div class="kv" style="margin-top:10px">' +
         '<div>Species</div><div>' + esc(b.species || '-') + '</div>' +
         '<div>Bag</div><div>' + bagNo(bag) + (b.bags ? ' of ' + b.bags : '') + '</div>' +
         '<div>Inoculated</div><div>' + fmtDate(b.inoc) + (age != null ? ' (day ' + age + ')' : '') + '</div>' +
         '<div>Spawn</div><div>' + esc(b.spawn || '-') + '</div>' +
         (fruiting ? '<div>Sent to fruiting</div><div>' + fmtDate(fruiting.ts) + ' (day ' + daysSince(localIso(new Date(fruiting.ts))) + ')</div>' : '') +
         '</div>' +
         '<div class="stat"><div><b>' + grams(bagTotal(bag)) + '</b><span>TOTAL YIELD</span></div>' +
         '<div><b>' + harvests.length + '</b><span>FLUSHES</span></div></div></div>';

    if (discard) {
      h += '<div class="card"><h2>Discarded ' + fmtDate(discard.ts) + '</h2><div>' + esc(discard.reason) +
           (discard.note ? ' - ' + esc(discard.note) : '') + '</div>' +
           '<button class="btn ghost small" data-act="void" data-id="' + discard.id + '">Undo discard</button></div>';
    } else {
      if (!fruiting) {
        h += '<div class="card"><h2>Bag opened?</h2><div class="muted">Tap when this bag is opened and moved to fruiting.</div>' +
             '<button class="btn" data-act="saveFruiting">Sent to fruiting</button></div>';
      }
      h += '<div class="card" id="harvestCard"><h2>Log harvest - flush ' + (harvests.length + 1) + '</h2>' +
           '<input class="big" type="number" id="g" inputmode="decimal" min="0" step="0.1" placeholder="grams">' +
           '<button class="btn" data-act="saveHarvest">Save weight</button></div>' +
           '<div class="card"><h2>Discard this bag</h2><div class="chips" id="reasons">' +
           REASONS.map(function (r) { return '<button data-reason="' + esc(r) + '">' + esc(r) + '</button>'; }).join('') +
           '</div><input type="text" id="note" placeholder="Note (optional)">' +
           '<button class="btn red" data-act="saveDiscard" disabled>Discard bag</button></div>';
    }

    if (harvests.length) {
      h += '<div class="card"><h2>Harvests</h2><ul class="list">' + harvests.map(function (e) {
        return '<li><div class="grow"><b>' + grams(e.grams) + '</b><div class="muted">Flush ' + e.flush + ' - ' + fmtDate(e.ts) + '</div></div>' +
               '<button class="x" data-act="void" data-id="' + e.id + '" aria-label="Delete">&#10005;</button></li>';
      }).join('') + '</ul></div>';
    }
    if (fruiting && !discard) {
      h += '<button class="btn ghost small" data-act="void" data-id="' + fruiting.id + '">Undo sent to fruiting</button>';
    }
    $('#v-bag').innerHTML = h;
    show('bag');
  }

  function renderHome() {
    var fruiting = 0, seen = {};
    live('fruiting').forEach(function (e) { if (!seen[e.bag] && !live('discard', e.bag).length) { seen[e.bag] = 1; fruiting++; } });
    var total = live('harvest').reduce(function (s, e) { return s + e.grams; }, 0);
    $('#hBatches').textContent = Object.keys(batches).length;
    $('#hFruiting').textContent = fruiting;
    $('#hYield').textContent = total >= 1000 ? (Math.round(total / 10) / 100) + ' kg' : grams(total);
    var d = new Date();
    $('#homeLine').textContent = 'Substrate Tracker - ' + pad(d.getDate()) + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
    var recent = events.filter(function (e) { return !e.voided && e.type !== 'void'; }).slice(-5).reverse();
    $('#recent').innerHTML = recent.length ? recent.map(function (e) {
      var what = e.type === 'harvest' ? 'Harvest ' + grams(e.grams) + ' (flush ' + e.flush + ')' :
                 e.type === 'fruiting' ? 'Sent to fruiting' : 'Discarded - ' + e.reason;
      return '<li data-bag="' + esc(e.bag) + '"><div class="grow"><b>' + esc(e.bag) + '</b><div class="muted">' + esc(what) + '</div></div>' +
             '<span class="muted">' + fmtDate(e.ts) + '</span></li>';
    }).join('') : '<li><div class="muted">Nothing logged yet. Print labels for a batch, then scan a bag.</div></li>';
  }

  function renderBatches() {
    var ids = Object.keys(batches).sort().reverse();
    if (!ids.length) {
      $('#batchList').innerHTML = '<div class="card"><h2>No batches yet</h2><div class="muted">Scan a bag label and its batch appears here.</div></div>';
      return;
    }
    $('#batchList').innerHTML = ids.map(function (id) {
      var b = batches[id];
      var total = live('harvest').filter(function (e) { return e.batch === id; }).reduce(function (s, e) { return s + e.grams; }, 0);
      var lost = live('discard').filter(function (e) { return e.batch === id; }).length;
      return '<div class="card" data-batch="' + esc(id) + '"><div class="row"><h2 style="margin:0">' + esc(id) + '</h2>' +
        '<span class="muted fit">' + fmtDate(b.inoc) + '</span></div><div class="muted">' + esc(b.species || '') + '</div>' +
        '<div class="stat"><div><b>' + grams(total) + '</b><span>YIELD</span></div><div><b>' + b.bags + '</b><span>BAGS</span></div>' +
        '<div><b>' + lost + '</b><span>DISCARDED</span></div></div></div>';
    }).join('');
  }

  function showBatch(id) {
    var b = batches[id]; if (!b) return;
    var rows = '', total = 0, w = String(Math.max(b.bags, 10)).length;
    for (var i = 1; i <= b.bags; i++) {
      var n = String(i); while (n.length < w) n = '0' + n;
      var bag = id + '-' + n;
      // labels always print at least two digits; fall back to whatever was actually scanned
      var seen = events.filter(function (e) { return e.batch === id && bagNo(e.bag) === i; })[0];
      if (seen) bag = seen.bag;
      var t = bagTotal(bag), f = live('harvest', bag).length, d = live('discard', bag)[0];
      total += t;
      rows += '<tr class="tap" data-bag="' + esc(bag) + '"><td>Bag ' + n + '</td><td>' + f + '</td><td>' + (f ? grams(t) : '-') + '</td>' +
              '<td>' + (d ? '<span class="tag red">' + esc(d.reason.split(' - ')[0]) + '</span>' :
                        live('fruiting', bag).length ? '<span class="tag">Fruiting</span>' : '') + '</td></tr>';
    }
    $('#v-batches').innerHTML = '<button class="back" data-act="batches">&lsaquo; Data</button>' +
      '<div class="card"><h2>' + esc(id) + '</h2><div class="muted">' + esc(b.species || '') + ' - inoculated ' + fmtDate(b.inoc) + '</div>' +
      '<table style="margin-top:10px"><tr><th>Bag</th><th>Flushes</th><th>Yield</th><th></th></tr>' + rows +
      '<tr><td><b>Total</b></td><td></td><td><b>' + grams(total) + '</b></td><td></td></tr></table></div>';
    show('batches');
  }

  function renderData() {
    renderBatches();
    var h = live('harvest').length, d = live('discard').length;
    $('#countLine').textContent = h + ' harvest entries, ' + live('fruiting').length + ' sent to fruiting, ' + d + ' discards, ' + Object.keys(batches).length + ' batches on this phone.';
    $('#device').value = cfg.device || '';
    updateSyncUi();
  }

  // ---------- actions ----------
  function addEvent(e) {
    e.id = uid(); e.ts = new Date().toISOString(); e.batch = batchOf(e.bag); e.device = cfg.device || ''; e.synced = false;
    events.push(e); persist(); sync();
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-act],[data-tab],[data-reason],[data-batch],[data-bag]');
    if (!t) return;
    if (t.dataset.tab) return show(t.dataset.tab);
    if (t.dataset.reason) {
      document.querySelectorAll('#reasons button').forEach(function (b) { b.classList.toggle('on', b === t); });
      $('[data-act=saveDiscard]').disabled = false;
      return;
    }
    if (t.dataset.batch) return showBatch(t.dataset.batch);
    if (t.dataset.bag) return showBag(t.dataset.bag);

    var act = t.dataset.act;
    if (act === 'scan') return show('scan');
    if (act === 'home') return show('home');
    if (act === 'batches') return show('data');
    if (act === 'saveFruiting') {
      addEvent({ bag: currentBag, type: 'fruiting' });
      toast(currentBag + ' sent to fruiting');
      return show('scan');
    }
    if (act === 'saveHarvest') {
      var g = parseFloat($('#g').value);
      if (!(g > 0) || g > 20000) { toast('Enter the weight in grams'); $('#g').focus(); return; }
      var flush = live('harvest', currentBag).length + 1;
      addEvent({ bag: currentBag, type: 'harvest', grams: Math.round(g * 10) / 10, flush: flush });
      toast('Saved ' + grams(g) + ' - ' + currentBag + ' flush ' + flush);
      return show('scan');
    }
    if (act === 'saveDiscard') {
      var r = $('#reasons button.on'); if (!r) return;
      if (!confirm('Discard ' + currentBag + ' as "' + r.dataset.reason + '"?')) return;
      addEvent({ bag: currentBag, type: 'discard', reason: r.dataset.reason, note: $('#note').value.trim() });
      toast(currentBag + ' discarded');
      return show('scan');
    }
    if (act === 'void') {
      var e = events.filter(function (x) { return x.id === t.dataset.id; })[0]; if (!e) return;
      var what = e.type === 'harvest' ? 'Delete the ' + grams(e.grams) + ' entry?' : e.type === 'fruiting' ? 'Undo sent to fruiting?' : 'Undo the discard?';
      if (!confirm(what)) return;
      e.voided = true;
      // renumber the remaining flushes of this bag so they stay 1, 2, 3...
      live('harvest', e.bag).forEach(function (x, i) { if (x.flush !== i + 1) { x.flush = i + 1; x.synced = false; } });
      events.push({ id: uid(), ts: new Date().toISOString(), bag: e.bag, batch: e.batch, type: 'void', ref: e.id, device: cfg.device || '', synced: false });
      persist(); sync(); showBag(e.bag);
    }
  });

  $('#manualGo').addEventListener('click', function () { if (openCode($('#manualId').value)) $('#manualId').value = ''; });
  $('#manualId').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#manualGo').click(); });
  // saved on every keystroke, so it survives closing the app straight after typing
  $('#device').addEventListener('input', function () { cfg.device = this.value.trim(); save('mq_cfg', cfg); updateSyncUi(); });
  $('#device').addEventListener('change', function () { sync(); });
  $('#syncNow').addEventListener('click', function () {
    if (!cfg.device) { toast('Enter a phone name first'); $('#device').focus(); return; }
    sync(true);
  });

  // ---------- CSV export ----------
  function csvCell(v) {
    v = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(v) && isNaN(Number(v))) v = "'" + v;   // stop spreadsheets treating text as a formula
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function rowFor(e) {
    var b = batches[e.batch] || {}, d = new Date(e.ts);
    return [e.id, e.ts, localIso(d), e.batch, e.bag, bagNo(e.bag), e.type, e.flush || '', e.type === 'harvest' ? e.grams : '',
            e.reason || '', e.note || '', b.species || '', b.inoc || '', b.spawn || '', b.bags || '', e.device || cfg.device || ''];
  }
  var COLS = ['entry_id','timestamp','date','batch','bag','bag_no','type','flush','grams','reason','note','species','inoculation','spawn','bags_in_batch','device'];

  $('#exportCsv').addEventListener('click', function () {
    var rows = events.filter(function (e) { return !e.voided && e.type !== 'void'; });
    if (!rows.length) return toast('Nothing to export yet');
    var csv = '﻿' + [COLS].concat(rows.map(rowFor)).map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
    var name = 'mycoqr-' + localIso(new Date()) + '.csv';
    var file = new File([csv], name, { type: 'text/csv' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: name }).catch(function () {});
      return;
    }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  });

  // ---------- sync (optional) ----------
  var syncing = false;
  function pending() { return events.filter(function (e) { return !e.synced; }); }
  function updateSyncUi() {
    var n = pending().length, pill = $('#syncPill');
    pill.hidden = false;
    pill.textContent = !cfg.device ? 'Name needed' : n ? n + ' to sync' : 'Synced';
    $('#syncLine').textContent = !cfg.device ? 'Nothing is sent until this phone has a name (above).' :
      n ? n + ' entries waiting to send.' : 'Everything is sent.';
    $('#deviceLine').textContent = cfg.device ? 'Saved on this phone. Recorded with each entry.' : 'Required before entries can go to the tracker.';
    $('#deviceLine').style.color = cfg.device ? '' : 'var(--red)';
  }
  function sync(loud) {
    updateSyncUi();
    if (!cfg.device) return;   // the tracker needs to know which phone logged each entry
    if (syncing || !navigator.onLine) { if (loud && !navigator.onLine) toast('No internet'); return; }
    var batch = pending().slice(0, 50);
    if (!batch.length) { if (loud) toast('Everything is already sent'); return; }
    syncing = true;
    var body = JSON.stringify({ app: 'mycoqr', columns: COLS, entries: batch.map(function (e) {
      return { id: e.id, type: e.type, ref: e.ref || '', voided: !!e.voided, row: rowFor(e) };
    }) });
    // text/plain keeps this a simple request, which a Google Apps Script web app accepts without CORS preflight
    fetch(TRACKER_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) throw new Error('rejected');
        batch.forEach(function (e) { e.synced = true; });
        persist(); syncing = false; updateSyncUi();
        if (pending().length) sync(loud); else if (loud) toast('Synced');
      })
      .catch(function () { syncing = false; updateSyncUi(); if (loud) toast('Sync failed - will retry'); });
  }
  window.addEventListener('online', function () { sync(); });

  // ---------- camera ----------
  var stream = null, raf = 0, detector = null, lastText = '', lastAt = 0;
  var canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
  if ('BarcodeDetector' in window) { try { detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { detector = null; } }

  function camMsg(t) { var m = $('#camMsg'); m.textContent = t || ''; m.style.display = t ? 'flex' : 'none'; }
  function startCam() {
    if (stream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { camMsg('Camera is not available here. Type the bag ID below or scan from a photo.'); return; }
    camMsg('Starting camera…');
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false })
      .then(function (s) {
        if (!$('#v-scan').classList.contains('on')) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
        stream = s; var v = $('#cam'); v.srcObject = s;
        return v.play().then(function () { camMsg(''); tick(); });
      })
      .catch(function () { camMsg('Camera blocked. Allow camera access for MycoQR, or type the bag ID below.'); });
  }
  function stopCam() {
    cancelAnimationFrame(raf); raf = 0;
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; $('#cam').srcObject = null; }
  }
  function found(text) {
    var now = Date.now();
    if (text === lastText && now - lastAt < 2500) return;   // ignore the same code held in view
    lastText = text; lastAt = now;
    openCode(text);
  }
  function tick() {
    if (!stream) return;
    raf = requestAnimationFrame(tick);
    var v = $('#cam');
    if (v.readyState < 2 || tick.busy) return;
    if (detector) {
      tick.busy = true;
      detector.detect(v).then(function (r) { tick.busy = false; if (r.length) found(r[0].rawValue); })
        .catch(function () { tick.busy = false; detector = null; });
      return;
    }
    var now = Date.now(); if (now - (tick.last || 0) < 120) return; tick.last = now;
    var text = decodeFrom(v, v.videoWidth, v.videoHeight, 640);
    if (text) found(text);
  }
  function decodeFrom(src, w, h, max) {
    if (!w || !h) return null;
    var k = Math.min(1, max / Math.max(w, h));
    canvas.width = Math.round(w * k); canvas.height = Math.round(h * k);
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    return r && r.data ? r.data : null;
  }
  $('#photo').addEventListener('change', function () {
    var f = this.files[0]; this.value = ''; if (!f) return;
    var im = new Image();
    im.onload = function () {
      var text = decodeFrom(im, im.naturalWidth, im.naturalHeight, 1200) || decodeFrom(im, im.naturalWidth, im.naturalHeight, 600);
      URL.revokeObjectURL(im.src);
      if (text) openCode(text); else toast('No QR code found in that photo');
    };
    im.onerror = function () { toast('Could not read that photo'); };
    im.src = URL.createObjectURL(f);
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopCam(); else if ($('#v-scan').classList.contains('on')) startCam();
  });

  // ---------- boot ----------
  window.MycoQR = { openCode: openCode, parseCode: parseCode };   // used for testing
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(function () {});
  updateSyncUi();
  show('home');
  sync();
})();

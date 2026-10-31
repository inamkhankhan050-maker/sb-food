/* ============================================================
   Billing calculation engine — pure functions, no DOM.
   All money is handled in INTEGER PAISE to avoid float errors.
   Weight is handled in integer GRAMS (up to 3 decimals of kg).
   ============================================================ */
(function (root) {
  'use strict';

  var LABOUR_PAISE_X10_PER_PIECE = 625; // ₹0.625 = 62.5 paise  -> stored x10
  var SAMITI_PERCENT = 1;                // 1%, floored to whole rupee
  var ROUND_TO_PAISE = 1000;             // final must be a multiple of ₹10
  var MAX_ADJUSTMENT_PAISE = 999;        // ₹9.99

  var OPS = /[+\-*\/x×÷−]/i;
  /** Evaluate a simple sum like "50+60.5+94" or "20×4.5" exactly. Returns {n,d} (fraction) or null. */
  function evalFrac(str) {
    var s = String(str).replace(/[\s,]/g, '').replace(/−/g, '-').replace(/[x×]/gi, '*').replace(/÷/g, '/');
    if (!s || !/^[\d.+\-*\/]+$/.test(s)) return null;
    var i = 0;
    function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { var t = a % b; a = b; b = t; } return a || 1; }
    function mk(n, d) { if (d < 0) { n = -n; d = -d; } var g = gcd(n, d); return { n: n / g, d: d / g }; }
    function num() {
      var m = /^\d*\.?\d+|^\d+\.?/.exec(s.slice(i)); if (!m) return null;
      i += m[0].length; var t = m[0].split('.'), f = t[1] || '';
      return mk(parseInt((t[0] || '0') + f, 10), Math.pow(10, f.length));
    }
    function factor() { if (s[i] === '-') { i++; var f = factor(); return f && mk(-f.n, f.d); } return num(); }
    function term() {
      var a = factor(); if (!a) return null;
      while (s[i] === '*' || s[i] === '/') {
        var op = s[i++], b = factor(); if (!b) return null;
        if (op === '*') a = mk(a.n * b.n, a.d * b.d); else { if (b.n === 0) return null; a = mk(a.n * b.d, a.d * b.n); }
      }
      return a;
    }
    var a = term(); if (!a) return null;
    while (s[i] === '+' || s[i] === '-') {
      var op = s[i++], b = term(); if (!b) return null;
      a = mk(op === '+' ? a.n * b.d + b.n * a.d : a.n * b.d - b.n * a.d, a.d * b.d);
    }
    if (i !== s.length || !Number.isSafeInteger(a.n) || !Number.isSafeInteger(a.d)) return null;
    return a;
  }
  /** Expression -> plain decimal string rounded half-up to `places` (trailing zeros trimmed), or null. */
  function evalExpr(str, places) {
    var f = evalFrac(str); if (!f) return null;
    var sc = Math.pow(10, places == null ? 3 : places), neg = f.n < 0, n = Math.abs(f.n);
    var v = Math.floor((n * sc * 2 + f.d) / (2 * f.d));
    var w = Math.floor(v / sc), fr = String(v % sc); while (fr.length < String(sc).length - 1) fr = '0' + fr;
    fr = fr.replace(/0+$/, '');
    return (neg ? '-' : '') + w + (fr ? '.' + fr : '');
  }
  function hasExpr(s) { s = String(s == null ? '' : s).trim(); return OPS.test(s.replace(/^[-−]/, '')) ; }

  /** Parse a decimal string into an integer scaled by 10^places. Returns null if invalid. */
  function parseScaled(input, places) {
    if (input === null || input === undefined) return null;
    var s = String(input).trim().replace(/,/g, '');
    if (s === '') return null;
    if (hasExpr(s)) { var e = evalExpr(s, places); if (e === null || e[0] === '-') return NaN; s = e; }
    if (!/^\d*\.?\d*$/.test(s) || s === '.') return NaN; // rejects negatives, letters
    var parts = s.split('.');
    var whole = parts[0] || '0';
    var frac = parts[1] || '';
    if (frac.length > places) return NaN; // too many decimals
    while (frac.length < places) frac += '0';
    var n = parseInt(whole, 10) * Math.pow(10, places) + (frac ? parseInt(frac, 10) : 0);
    return Number.isSafeInteger(n) ? n : NaN;
  }

  /** Validate raw row inputs. Returns {ok, status, errors, pieces, grams, ratePaise}. */
  function validateRow(row) {
    var errors = {};
    var name = (row.name || '').trim();
    var piecesRaw = String(row.pieces == null ? '' : row.pieces).trim();
    if (hasExpr(piecesRaw)) { var pe = evalExpr(piecesRaw, 3); piecesRaw = pe === null ? 'x' : pe; }
    var pieces = piecesRaw === '' ? null : (/^\d+$/.test(piecesRaw) ? parseInt(piecesRaw, 10) : NaN);
    var grams = parseScaled(row.kg, 3);
    var ratePaise = parseScaled(row.rate, 2);
    var jaalRaw = parseScaled(row.jaal, 3);
    var jaalGrams = jaalRaw === null ? 0 : jaalRaw;

    if (pieces !== null && (isNaN(pieces) || pieces < 0 || pieces > 1000000)) errors.pieces = 'Whole number of pieces, 0 or more';
    if (grams !== null && (isNaN(grams) || grams <= 0)) errors.kg = 'Weight must be more than 0 (max 3 decimals)';
    if (ratePaise !== null && (isNaN(ratePaise) || ratePaise <= 0)) errors.rate = 'Rate must be more than 0 (max 2 decimals)';
    if (isNaN(jaalGrams) || jaalGrams < 0) errors.jaal = 'Jaal weight must be 0 or more (max 3 decimals)';
    else if (grams > 0 && jaalGrams >= grams) errors.jaal = 'Jaal weight must be less than Total KG';

    var isEmpty = !name && pieces === null && grams === null && ratePaise === null;
    var hasErrors = Object.keys(errors).length > 0;
    var complete = !!name && pieces !== null && grams !== null && ratePaise !== null;

    var status = isEmpty ? 'empty' : hasErrors ? 'invalid' : complete ? 'valid' : 'incomplete';
    var netGrams = (grams > 0 && !errors.jaal) ? grams - jaalGrams : null;
    return { ok: status === 'valid', status: status, errors: errors, pieces: pieces, grams: grams, jaalGrams: isNaN(jaalGrams) ? 0 : jaalGrams, netGrams: netGrams, ratePaise: ratePaise };
  }

  /** Core formula. Inputs are already-validated integers. Returns all figures in paise. */
  function calculate(pieces, grams, ratePaise) {
    // Basic = kg × rate. grams*ratePaise/1000, rounded half-up to the paisa.
    var basicNum = grams * ratePaise;
    var basic = Math.floor((basicNum + 500) / 1000);

    // Samiti = FLOOR(basic × 1%) to the whole rupee.
    var samiti = Math.floor(basic * SAMITI_PERCENT / 100 / 100) * 100;

    // Original labour = pieces × ₹0.625, kept to paise (half-up).
    var labourOriginal = Math.floor((pieces * LABOUR_PAISE_X10_PER_PIECE + 5) / 10);

    var beforeAdj = basic + samiti + labourOriginal;
    var adjustment = (ROUND_TO_PAISE - (beforeAdj % ROUND_TO_PAISE)) % ROUND_TO_PAISE;

    var warning = null;
    if (adjustment < 0 || adjustment > MAX_ADJUSTMENT_PAISE) {
      warning = 'Labour adjustment out of range (₹0.00–₹9.99). Final amount not calculated.';
    }
    var labourAdjusted = labourOriginal + adjustment;
    var final = basic + samiti + labourAdjusted;
    if (!warning && final % ROUND_TO_PAISE !== 0) warning = 'Final amount is not a multiple of ₹10.';

    return {
      basic: basic,
      samiti: samiti,
      labourOriginal: labourOriginal,
      beforeAdjustment: beforeAdj,
      adjustment: adjustment,
      labourAdjusted: labourAdjusted,
      final: warning ? null : final,
      warning: warning
    };
  }

  /** Validate + calculate one row. */
  function computeRow(row) {
    var v = validateRow(row);
    if (!v.ok) return { status: v.status, errors: v.errors, result: null };
    var r = calculate(v.pieces, v.netGrams, v.ratePaise);
    return { status: r.warning ? 'warning' : 'valid', errors: v.errors, result: r, pieces: v.pieces, grams: v.grams, jaalGrams: v.jaalGrams, netGrams: v.netGrams, ratePaise: v.ratePaise };
  }

  /** Grand totals from all valid rows. Grand total = sum of row finals, always. */
  function computeTotals(rows) {
    var t = { customers: 0, pieces: 0, grams: 0, jaal: 0, net: 0, basic: 0, samiti: 0, labour: 0, grand: 0, incomplete: 0, invalid: 0 };
    rows.forEach(function (row) {
      var c = computeRow(row);
      if (c.status === 'valid') {
        t.customers += 1;
        t.pieces += c.pieces;
        t.grams += c.grams;
        t.jaal += c.jaalGrams;
        t.net += c.netGrams;
        t.basic += c.result.basic;
        t.samiti += c.result.samiti;
        t.labour += c.result.labourAdjusted;
        t.grand += c.result.final;
      } else if (c.status === 'incomplete') t.incomplete += 1;
      else if (c.status === 'invalid' || c.status === 'warning') t.invalid += 1;
    });
    return t;
  }

  /** Average bird size: kg per piece, 2 decimals (half-up). null when not computable. */
  function averageKg(grams, pieces) {
    if (!(pieces > 0) || !(grams > 0)) return null;
    var hund = Math.floor((grams * 100 + pieces * 500) / (pieces * 1000));
    return (Math.floor(hund / 100)) + '.' + ('0' + (hund % 100)).slice(-2);
  }

  /** Customer ledger: previous balance + today's bill − cash − online. All paise. */
  function ledger(row, finalPaise) {
    var errors = {}, out = {};
    ['oldBal', 'cash', 'online'].forEach(function (f) {
      var v = parseScaled(row[f], 2);
      if (v === null) v = 0;
      if (isNaN(v) || v < 0) { errors[f] = 'Amount must be 0 or more (max 2 decimals)'; v = 0; }
      out[f] = v;
    });
    var received = out.cash + out.online;
    var due = out.oldBal + (finalPaise || 0) - received;
    var any = ['oldBal', 'cash', 'online'].some(function (f) { return String(row[f] == null ? '' : row[f]).trim() !== ''; });
    return { oldBal: out.oldBal, cash: out.cash, online: out.online, received: received, due: due, any: any, errors: errors, ok: Object.keys(errors).length === 0 };
  }

  // ---------- Formatting (Indian system) ----------
  function groupIndian(intStr) {
    if (intStr.length <= 3) return intStr;
    var last3 = intStr.slice(-3);
    var rest = intStr.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    return rest + ',' + last3;
  }
  /** ₹ format from paise. opts.decimals: 'auto' (show paise only if non-zero) | 2 */
  function formatINR(paise, opts) {
    if (paise === null || paise === undefined) return '—';
    opts = opts || {};
    var neg = paise < 0; var p = Math.abs(paise);
    var rupees = Math.floor(p / 100); var ps = p % 100;
    var showDec = opts.decimals === 2 || (opts.decimals !== 0 && ps !== 0);
    var s = '₹' + groupIndian(String(rupees)) + (showDec ? '.' + (ps < 10 ? '0' : '') + ps : '');
    return (neg ? '−' : '') + s;
  }
  function formatKg(grams) {
    if (grams === null || grams === undefined) return '—';
    var whole = Math.floor(grams / 1000); var g = grams % 1000;
    var dec = g ? ('.' + String(g + 1000).slice(1)).replace(/0+$/, '') : '';
    return groupIndian(String(whole)) + dec;
  }
  function formatInt(n) { return groupIndian(String(n)); }
  function paiseToPlain(paise) { // for CSV/Excel: 17580.00
    var neg = paise < 0; var p = Math.abs(paise);
    return (neg ? '-' : '') + Math.floor(p / 100) + '.' + String(p % 100 + 100).slice(1);
  }

  // ---------- Amount in words (Indian) ----------
  var ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  var TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  function two(n) { return n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''); }
  function three(n) { var h = Math.floor(n / 100), r = n % 100; return (h ? ONES[h] + ' Hundred' + (r ? ' ' : '') : '') + (r ? two(r) : ''); }
  function numberToWordsIndian(n) {
    if (n === 0) return 'Zero';
    var parts = [];
    var crore = Math.floor(n / 10000000); n %= 10000000;
    var lakh = Math.floor(n / 100000); n %= 100000;
    var thousand = Math.floor(n / 1000); n %= 1000;
    if (crore) parts.push((crore > 999 ? numberToWordsIndian(crore) : three(crore)) + ' Crore');
    if (lakh) parts.push(two(lakh) + ' Lakh');
    if (thousand) parts.push(two(thousand) + ' Thousand');
    if (n) parts.push(three(n));
    return parts.join(' ');
  }
  function amountInWords(paise) {
    var r = Math.floor(paise / 100), p = paise % 100;
    return numberToWordsIndian(r) + ' Rupees' + (p ? ' and ' + two(p) + ' Paise' : '') + ' Only';
  }

  var api = {
    parseScaled: parseScaled, evalExpr: evalExpr, hasExpr: hasExpr, validateRow: validateRow, calculate: calculate,
    computeRow: computeRow, computeTotals: computeTotals, averageKg: averageKg, ledger: ledger,
    formatINR: formatINR, formatKg: formatKg, formatInt: formatInt, paiseToPlain: paiseToPlain,
    amountInWords: amountInWords, groupIndian: groupIndian
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BillingCalc = api;
})(typeof window !== 'undefined' ? window : this);

;
(function () {
  'use strict';
  var C = window.BillingCalc;
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- Fixed shop details ---------- */
  var SHOP = {
    company: 'SB FOOD',
    contact: 'NUNTUN: 8178357317, 7011155231',
    address1: 'Shop No. 48, SB Food',
    address2: 'Poultry Market Ghazipur Delhi 110096'
  };

  var KEY = 'sbfood-bill-v1', SET_KEY = 'sbfood-settings-v1', DEF_ROWS = 4;
  var storage = null;
  try { storage = window.localStorage; storage.setItem('__t', '1'); storage.removeItem('__t'); } catch (e) { storage = null; }

  function todayISO() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function blankRow() { return { qty: '', wt: '', part: '', rate: '' }; }
  function blankBill() { var r = []; for (var i = 0; i < DEF_ROWS; i++) r.push(blankRow()); return { name: '', date: todayISO(), rows: r, bal: '', rec: '' }; }

  var bill = blankBill();
  var set = { labour: '0.625', samiti: '1', round: true };
  try {
    if (storage) {
      var b = JSON.parse(storage.getItem(KEY) || 'null'); if (b && b.rows) bill = b;
      var s = JSON.parse(storage.getItem(SET_KEY) || 'null'); if (s) set = Object.assign(set, s);
    }
  } catch (e) {}
  function save() { if (!storage) return; try { storage.setItem(KEY, JSON.stringify(bill)); storage.setItem(SET_KEY, JSON.stringify(set)); } catch (e) {} }

  /* ---------- Formatting ---------- */
  function money(p) { if (p === null || p === undefined) return ''; return C.formatINR(p).replace('₹', ''); }
  function dateText(iso) {
    var p = String(iso || todayISO()).split('-'); var d = new Date(+p[0], +p[1] - 1, +p[2]);
    var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return ('0' + d.getDate()).slice(-2) + '-' + M[d.getMonth()] + '-' + String(d.getFullYear()).slice(-2);
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]; }); }

  /* ---------- Calculation ---------- */
  function num(v, places) { var n = C.parseScaled(v, places); return n === null ? 0 : n; }
  function qtyOf(v) {
    var s = String(v == null ? '' : v).trim(); if (!s) return 0;
    if (C.hasExpr(s)) { var e = C.evalExpr(s, 0); s = e === null ? 'x' : e; }
    return /^\d+$/.test(s) ? parseInt(s, 10) : NaN;
  }
  /* Labour rule by average size (kg per piece) of each line:
     below 2.5 kg → Qty ÷ 9 × 5 · 2.5 to below 3 kg → Qty ÷ 8 × 5 · 3 kg and above → Qty ÷ 7 × 5
     No weight on the line → ÷ 8 × 5. */
  function labDiv(q, g) {
    if (!(q > 0)) return 0;
    if (!(g > 0)) return 8;
    if (g < q * 2500) return 9;
    if (g < q * 3000) return 8;
    return 7;
  }
  function compute() {
    var m = { rows: [], qty: 0, grams: 0, total: 0, labourOrig: 0, bad: false };
    bill.rows.forEach(function (r) {
      var q = qtyOf(r.qty), g = num(r.wt, 3), rt = num(r.rate, 2), amt = null;
      var bad = isNaN(q) || isNaN(g) || isNaN(rt);
      if (!bad && g > 0 && rt > 0) amt = Math.floor((g * rt + 500) / 1000);
      var div = labDiv(q, g), lab = (!bad && q > 0 && div) ? Math.floor((q * 1000 / div + 1) / 2) : 0; // q×5/div rupees → paise, half-up
      if (!bad) { m.qty += q; m.grams += g; if (amt) m.total += amt; m.labourOrig += lab; }
      if (bad) m.bad = true;
      m.rows.push({ q: q, g: g, rt: rt, amt: amt, bad: bad, div: div, lab: lab });
    });
    var pct = num(set.samiti, 2); if (isNaN(pct)) pct = 0;           // percent ×100
    m.samiti = Math.floor(m.total * pct / 10000 / 100) * 100;
    var before = m.total + m.samiti + m.labourOrig;
    m.adj = (set.round && m.total > 0) ? (1000 - before % 1000) % 1000 : 0;
    m.labour = m.labourOrig + m.adj;
    m.totalBill = m.total > 0 ? before + m.adj : 0;
    var bal = num(bill.bal, 2), rec = num(bill.rec, 2);
    m.bal = isNaN(bal) ? 0 : bal; m.rec = isNaN(rec) ? 0 : rec;
    m.grand = m.totalBill + m.bal - m.rec;
    return m;
  }

  /* ---------- Render editable bill ---------- */
  function inp(i, f, mode, cls) {
    var v = bill.rows[i][f] || '';
    var lbl = { qty: 'Qty', wt: 'Weight', part: 'Particulars', rate: 'Rate' }[f] + ' · line ' + (i + 1);
    return '<input class="ci ' + (cls || '') + '" data-i="' + i + '" data-f="' + f + '" value="' + esc(v) + '"' +
      (mode ? ' inputmode="' + mode + '"' : '') + ' autocomplete="off" aria-label="' + lbl + '">';
  }
  function renderRows() {
    var h = '';
    bill.rows.forEach(function (r, i) {
      h += '<tr class="ln"><td class="c-q">' + inp(i, 'qty', 'numeric', 'n') + '</td><td class="c-w">' + inp(i, 'wt', 'decimal', 'n') + '</td>' +
        '<td class="c-p">' + inp(i, 'part', '', '') + '</td><td class="c-r">' + inp(i, 'rate', 'decimal', 'n') + '</td>' +
        '<td class="c-a"><span class="amt" id="amt' + i + '"></span><span class="avg" id="avg' + i + '"></span></td></tr>';
    });
    $('rows').innerHTML = h;
  }
  function update() {
    var m = compute();
    m.rows.forEach(function (r, i) {
      var el = $('amt' + i); if (!el) return;
      el.textContent = r.bad ? '?' : (r.amt ? money(r.amt) : '');
      el.parentNode.classList.toggle('err', r.bad);
    });
    $('tQty').textContent = m.qty ? C.formatInt(m.qty) : '';
    $('tWt').textContent = m.grams ? C.formatKg(m.grams) : '';
    $('tAmt').textContent = m.total ? money(m.total) : '';
    $('tAvg').textContent = (m.qty && m.grams) ? C.averageKg(m.grams, m.qty) + ' kg' : '';
    $('tSam').textContent = m.total ? money(m.samiti) : '';
    $('tLab').textContent = m.total ? money(m.labour) : '';
    $('tBill').textContent = m.totalBill ? money(m.totalBill) : '';
    $('tGrand').textContent = (m.totalBill || m.bal || m.rec) ? (m.grand < 0 ? '−' + money(-m.grand) : money(m.grand)) : '';
    var parts = []; m.rows.forEach(function (r) { if (r.lab) parts.push(C.formatInt(r.q) + '÷' + r.div + '×5'); });
    $('labNote').textContent = parts.length ? parts.join(' + ') + (m.adj ? ' + round ' + C.formatINR(m.adj, { decimals: 2 }) : '') : '';
    m.rows.forEach(function (r, i) { var el = $('avg' + i); if (el) el.textContent = (r.q > 0 && r.g > 0 && !r.bad) ? 'avg ' + C.averageKg(r.g, r.q) + ' · ÷' + r.div : ''; });
    $('words').textContent = m.grand > 0 ? C.amountInWords(m.grand) : '';
    $('dateTxt').textContent = dateText(bill.date);
    placeStamp(m);
    save();
    return m;
  }


  /* ---------- Rubber stamp (SB FOOD · SHOP NO 48 · NUNTUN) ---------- */
  function billCode(m) {
    var str = bill.date + '|' + (bill.name || '').trim().toUpperCase() + '|' + m.grand + '|' + m.total + '|' + m.qty + '|' + m.grams, h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    var d = (bill.date || '').split('-');
    return 'SB' + (d[2] || '') + (d[1] || '') + '-' + h.toString(36).toUpperCase().slice(-5);
  }
  function makeStamp(code, px) {
    var cv = document.createElement('canvas'), R = px / 2; cv.width = cv.height = px;
    var g = cv.getContext('2d'), INK = '#1C3FAA', F = '"Arial Black","Segoe UI",Arial,sans-serif';
    g.translate(R, R); g.rotate(-0.21);
    g.strokeStyle = g.fillStyle = INK;
    g.lineWidth = R * 0.07; g.beginPath(); g.arc(0, 0, R * 0.92, 0, 7); g.stroke();
    g.lineWidth = R * 0.025; g.beginPath(); g.arc(0, 0, R * 0.70, 0, 7); g.stroke();
    function arc(txt, rad, size, top) {
      g.font = '900 ' + size + 'px ' + F; g.textAlign = 'center'; g.textBaseline = 'middle';
      var ws = txt.split('').map(function (c) { return g.measureText(c).width * 1.08; }), tot = ws.reduce(function (a, b) { return a + b; }, 0) / rad;
      var a = top ? -Math.PI / 2 - tot / 2 : Math.PI / 2 + tot / 2;
      txt.split('').forEach(function (c, i) {
        var da = ws[i] / rad, m = top ? a + da / 2 : a - da / 2;
        g.save(); g.translate(Math.cos(m) * rad, Math.sin(m) * rad); g.rotate(top ? m + Math.PI / 2 : m - Math.PI / 2); g.fillText(c, 0, 0); g.restore();
        a = top ? a + da : a - da;
      });
    }
    arc('SB FOOD ★ SHOP NO. 48', R * 0.81, R * 0.17, true);
    arc('★ GHAZIPUR DELHI ★', R * 0.81, R * 0.14, false);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '900 ' + (R * 0.29) + 'px ' + F; g.fillText('NUNTUN', 0, -R * 0.06, R * 1.25);
    g.lineWidth = R * 0.03; g.beginPath(); g.moveTo(-R * 0.55, -R * 0.26); g.lineTo(R * 0.55, -R * 0.26); g.moveTo(-R * 0.55, R * 0.14); g.lineTo(R * 0.55, R * 0.14); g.stroke();
    g.font = '800 ' + (R * 0.11) + 'px ' + F; g.fillText('ORIGINAL BILL', 0, -R * 0.38);
    g.font = '700 ' + (R * 0.105) + 'px "Courier New",monospace'; g.fillText(code, 0, R * 0.27);
    // rubber-ink texture: knock out tiny specks (same pattern for the same bill)
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'destination-out';
    var seed = 0; for (var i = 0; i < code.length; i++) seed = (seed * 31 + code.charCodeAt(i)) >>> 0;
    function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
    for (var k = 0; k < px * 1.1; k++) { g.globalAlpha = 0.3 + rnd() * 0.5; g.beginPath(); g.arc(rnd() * px, rnd() * px, rnd() * px * 0.012 + 0.4, 0, 7); g.fill(); }
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    return cv;
  }
  var stampKey = '';
  function placeStamp(m) {
    var el = $('stamp');
    if (!(m.grand > 0)) { if (el) el.style.display = 'none'; return; }
    if (!el) {
      var cell = $('tGrand').parentNode;
      el = document.createElement('img'); el.id = 'stamp'; el.className = 'stamp'; el.alt = 'SB FOOD stamp'; cell.appendChild(el);
    }
    var code = billCode(m);
    if (code !== stampKey) { try { el.src = makeStamp(code, 360).toDataURL('image/png'); } catch (e) {} stampKey = code; el.title = 'Bill code ' + code; }
    el.style.display = '';
  }

  /* ---------- Canvas (for WhatsApp PDF) — same look as the printed bill ---------- */
  var HEN = new Image(); HEN.src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjAgMTIwIj48Y2lyY2xlIGN4PSI2MCIgY3k9IjYwIiByPSI1NyIgZmlsbD0iI0ZGRjhFNyIgc3Ryb2tlPSIjQTMwRTBFIiBzdHJva2Utd2lkdGg9IjQiLz48cGF0aCBkPSJNNDQgOTYgbC00IDEyIE00MCAxMDggaC03IE00MCAxMDggaDYgTTY0IDk2IGwyIDEyIE02NiAxMDggaC03IE02NiAxMDggaDciIHN0cm9rZT0iI0UwOEEwMCIgc3Ryb2tlLXdpZHRoPSIzLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgZmlsbD0ibm9uZSIvPjxwYXRoIGQ9Ik0yMiA1MiBDMTQgNDAgMTggMjYgMjggMzAgQzI2IDM4IDMwIDQ0IDM0IDQ2IFoiIGZpbGw9IiM4QjNBMEUiLz48cGF0aCBkPSJNMjAgNjAgQzE2IDQ2IDI0IDM2IDMyIDQwIEMzMCA0OCAzNCA1NCAzOCA1NiBaIiBmaWxsPSIjQjU1MzFBIi8+PGVsbGlwc2UgY3g9IjU0IiBjeT0iNzAiIHJ4PSIzMiIgcnk9IjI2IiBmaWxsPSIjQzg2NTFFIi8+PHBhdGggZD0iTTM2IDY2IEM0NiA4NCA3MCA4OCA4MiA3NCBDNzYgOTIgNTAgOTYgMzggODIgWiIgZmlsbD0iIzlDNEExNCIvPjxwYXRoIGQ9Ik00NCA2MiBDNTIgNTQgNjYgNTYgNzAgNjYgQzYyIDYyIDUyIDYyIDQ0IDcwIFoiIGZpbGw9IiNFNzg4M0EiLz48cGF0aCBkPSJNNzAgNjAgQzcwIDQwIDc4IDI2IDkwIDI2IEMxMDAgMjYgMTA0IDM2IDEwMCA0NiBDOTYgNTYgODggNjIgODQgNzIgWiIgZmlsbD0iI0Q5N0EyQiIvPjxwYXRoIGQ9Ik04NCAyMiBDODIgMTQgODggMTAgOTEgMTYgQzkyIDkgOTkgOSA5OCAxNyBDMTAyIDEzIDEwNyAxNyAxMDIgMjMgWiIgZmlsbD0iI0UxMUQyRSIvPjxwYXRoIGQ9Ik0xMDAgMzQgbDEyIDQgLTEyIDUgWiIgZmlsbD0iI0Y1QjMwMSIvPjxwYXRoIGQ9Ik05OCA0NiBDMTAyIDQ4IDEwNCA1NCA5OSA1NyBDOTUgNTUgOTUgNDkgOTggNDYgWiIgZmlsbD0iI0UxMUQyRSIvPjxjaXJjbGUgY3g9IjkyIiBjeT0iMzMiIHI9IjMuNCIgZmlsbD0iIzExMSIvPjxjaXJjbGUgY3g9IjkzIiBjeT0iMzIiIHI9IjEuMSIgZmlsbD0iI2ZmZiIvPjwvc3ZnPg==';
  var COL = { green: '#FDE68A', light: '#FFFDF7', grey: '#9A3412', red: '#FFFFFF', red2: '#FDE68A', ink: '#431407', cream: '#FFF7ED', line: '#D9B98A', dark: '#7C2D12' };
  function billCanvas() {
    var m = compute();
    var used = [];
    bill.rows.forEach(function (r, i) { if (r.qty || r.wt || r.part || r.rate) used.push(i); });
    var nLines = Math.max(used.length, 6);
    var F = '"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';
    var W = 900, X = 40, IW = W - 2 * X, RH = 56, S = 2;
    var cw = [0.123, 0.145, 0.326, 0.191, 0.215].map(function (f) { return f * IW; });
    var cx = [X]; for (var k = 0; k < 5; k++) cx.push(cx[k] + cw[k]);
    var addr = [SHOP.address1, SHOP.address2].filter(Boolean);
    var headH = 250 + addr.length * 10;
    var H = 40 + headH + RH * 2 + RH * nLines + RH * 9 + 200;
    var cv = document.createElement('canvas'); cv.width = W * S; cv.height = H * S;
    var g = cv.getContext('2d'); g.scale(S, S);
    g.fillStyle = '#FFFBEB'; g.fillRect(0, 0, W, H);
    function t(s, x, y, size, color, weight, align) { g.font = (weight || 600) + ' ' + size + 'px ' + F; g.fillStyle = color || COL.ink; g.textAlign = align || 'left'; g.textBaseline = 'middle'; g.fillText(s, x, y); }
    function box(x, y, w, h, fill) { if (fill) { g.fillStyle = fill; g.fillRect(x, y, w, h); } g.strokeStyle = COL.line; g.lineWidth = 1.2; g.strokeRect(x, y, w, h); }
    function fit(s, size, maxW, weight) { g.font = (weight || 600) + ' ' + size + 'px ' + F; while (size > 12 && g.measureText(s).width > maxW) { size -= 1; g.font = (weight || 600) + ' ' + size + 'px ' + F; } return size; }
    var y = 40;
    // Header
    box(X, y, IW, headH, COL.dark);
    t(SHOP.contact, W / 2, y + 30, fit(SHOP.contact, 24, IW - 30, 700), COL.red2, 700, 'center');
    t(SHOP.company, W / 2, y + 100, 84, COL.red, 800, 'center');
    try { if (HEN.complete && HEN.naturalWidth !== 0) g.drawImage(HEN, X + 14, y + 52, 110, 110); else if (HEN.complete) g.drawImage(HEN, X + 14, y + 52, 110, 110); } catch (e) {}
    var dy = y + 160;
    box(cx[3], dy, cw[3], RH, COL.green); t('Date', cx[3] + cw[3] / 2, dy + RH / 2, 26, COL.ink, 700, 'center');
    box(cx[4], dy, cw[4], RH, COL.cream); t(dateText(bill.date), cx[4] + cw[4] / 2, dy + RH / 2, 24, COL.ink, 600, 'center');
    if (addr[0]) t(addr[0], (X + cx[3]) / 2, dy + RH / 2, fit(addr[0], 28, cx[3] - X - 20, 600), COL.red2, 600, 'center');
    if (addr[1]) t(addr[1], W / 2, dy + RH + 26, fit(addr[1], 28, IW - 20, 600), COL.red2, 600, 'center');
    y += headH;
    // Name
    box(X, y, cw[0], RH, COL.green); t('Name', X + cw[0] / 2, y + RH / 2, 24, COL.ink, 700, 'center');
    var nm = bill.name.trim() || ' ';
    box(cx[1], y, IW - cw[0], RH, '#E8E8E8'); t(nm, cx[1] + (IW - cw[0]) / 2, y + RH / 2, fit(nm, 32, IW - cw[0] - 20, 700), COL.ink, 700, 'center');
    y += RH;
    // Column heads
    ['Qty', 'Weight', 'Particulars', 'Rate', 'Amount'].forEach(function (h, i) { box(cx[i], y, cw[i], RH, COL.grey); t(h, cx[i] + cw[i] / 2, y + RH / 2, 23, '#fff', 700, 'center'); });
    y += RH;
    // Lines
    for (var n = 0; n < nLines; n++) {
      var i = used[n], r = i === undefined ? null : bill.rows[i], c = i === undefined ? null : m.rows[i];
      for (var k2 = 0; k2 < 5; k2++) box(cx[k2], y, cw[k2], RH, COL.light);
      if (r) {
        if (c.q) t(C.formatInt(c.q), cx[0] + cw[0] / 2, y + RH / 2, 26, COL.ink, 700, 'center');
        if (c.g) t(C.formatKg(c.g), cx[1] + cw[1] / 2, y + RH / 2, 26, COL.ink, 700, 'center');
        if (r.part) t(r.part, cx[2] + 10, y + RH / 2, fit(r.part, 24, cw[2] - 20, 600), COL.ink, 600, 'left');
        if (c.rt) t(C.formatINR(c.rt).replace('₹', ''), cx[3] + cw[3] / 2, y + RH / 2, 26, COL.ink, 700, 'center');
        if (c.amt) t(money(c.amt), cx[5] - 10, y + RH / 2, 26, COL.ink, 700, 'right');
      }
      y += RH;
    }
    // Totals
    function sumRow(label, val, fill, left) {
      if (left) { box(cx[0], y, cw[0], RH, fill); box(cx[1], y, cw[1], RH, fill); if (left[0]) t(left[0], cx[0] + cw[0] / 2, y + RH / 2, 26, COL.ink, 700, 'center'); if (left[1]) t(left[1], cx[1] + cw[1] / 2, y + RH / 2, 26, COL.ink, 700, 'center'); }
      else box(cx[0], y, cw[0] + cw[1], RH, COL.light);
      box(cx[2], y, cw[2], RH, fill || COL.light); t(label, cx[2] + 10, y + RH / 2, 26, fill === COL.dark ? '#fff' : COL.ink, 700, 'left');
      box(cx[3], y, cw[3], RH, COL.light);
      box(cx[4], y, cw[4], RH, fill || COL.light); if (val) t(val, cx[5] - 10, y + RH / 2, 27, fill === COL.dark ? '#FACC15' : COL.ink, 700, 'right');
      y += RH;
    }
    sumRow('Total', m.total ? money(m.total) : '', COL.green, [m.qty ? C.formatInt(m.qty) : '', m.grams ? C.formatKg(m.grams) : '']);
    sumRow('Average', (m.qty && m.grams) ? C.averageKg(m.grams, m.qty) + ' kg' : '');
    sumRow('Samiti', m.total ? money(m.samiti) : '');
    sumRow('Labour', m.total ? money(m.labour) : '');
    sumRow('Total Bill', m.totalBill ? money(m.totalBill) : '', COL.green);
    sumRow('Last Balance', m.bal ? money(m.bal) : '');
    sumRow('Received', m.rec ? money(m.rec) : '—');
    var gt = (m.totalBill || m.bal || m.rec) ? (m.grand < 0 ? '−' + money(-m.grand) : money(m.grand)) : '';
    sumRow('G. TOTAL', gt, COL.dark);
    if (m.grand > 0) { var sp = 170; try { g.drawImage(makeStamp(billCode(m), sp * 2), cx[4] + cw[4] * 0.4 - sp / 2, y - 12, sp, sp); } catch (e) {} }
    if (m.grand > 0) { var w = C.amountInWords(m.grand); t(w, cx[5], y + 30, fit(w, 18, IW, 500), '#444', 500, 'right'); }
    return cv;
  }

    function jpegPdf(dataUrl, pw, ph) {
    var bin = atob(dataUrl.split(',')[1]), img = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) img[i] = bin.charCodeAt(i);
    var PW = Math.max(595.28, Math.round(pw / 2 * 0.46)), PH = Math.round(PW * ph / pw * 100) / 100;
    var content = 'q ' + PW + ' 0 0 ' + PH + ' 0 0 cm /Im0 Do Q';
    var parts = [], off = [], len = 0;
    var add = function (x) { if (typeof x === 'string') { var b = new Uint8Array(x.length); for (var j = 0; j < x.length; j++) b[j] = x.charCodeAt(j) & 255; x = b; } parts.push(x); len += x.length; };
    add('%PDF-1.4\n');
    var obj = function (n, body) { off[n] = len; add(n + ' 0 obj\n'); body(); add('\nendobj\n'); };
    obj(1, function () { add('<< /Type /Catalog /Pages 2 0 R >>'); });
    obj(2, function () { add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'); });
    obj(3, function () { add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + PW + ' ' + PH + '] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'); });
    obj(4, function () { add('<< /Type /XObject /Subtype /Image /Width ' + pw + ' /Height ' + ph + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + img.length + ' >>\nstream\n'); add(img); add('\nendstream'); });
    obj(5, function () { add('<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream'); });
    var xref = len, x = 'xref\n0 6\n0000000000 65535 f \n';
    for (var k = 1; k <= 5; k++) x += ('0000000000' + off[k]).slice(-10) + ' 00000 n \n';
    add(x + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF');
    return new Blob(parts, { type: 'application/pdf' });
  }
  function sharePdf(blob, fname, msg, kind) {
    kind = kind || 'PDF';
    var file = null; try { file = new File([blob], fname, { type: blob.type || 'application/pdf' }); } catch (e) {}
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], text: msg }).catch(function (e) { if (e && e.name !== 'AbortError') fallback(); });
      return;
    }
    fallback();
    function fallback() {
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
      try { window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank'); } catch (e) {}
      toast(kind + ' download ho gayi. WhatsApp mein 📎 se attach karke bhejiye');
    }
  }


  function makePdf() {
    var m = compute();
    if (!m.total && !m.bal) { toast('Pehle Qty, Weight aur Rate bhariye'); return null; }
    var cv = billCanvas(), blob = jpegPdf(cv.toDataURL('image/jpeg', 0.92), cv.width, cv.height);
    var nm = bill.name.trim() || 'Customer';
    var fname = ('SB FOOD ' + nm + ' ' + dateText(bill.date)).replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-') + '.pdf';
    return { blob: blob, fname: fname, msg: 'SB FOOD · ' + nm + ' · ' + dateText(bill.date) + ' · G. Total ' + C.formatINR(m.grand) };
  }
  function sharePdfBill() { closeShare(); var p = makePdf(); if (p) sharePdf(p.blob, p.fname, p.msg, 'PDF'); }
  function sharePhotoBill() {
    closeShare();
    var m = compute();
    if (!m.total && !m.bal) { toast('Pehle Qty, Weight aur Rate bhariye'); return; }
    var url = billCanvas().toDataURL('image/jpeg', 0.92), bin = atob(url.split(',')[1]), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    var blob = new Blob([u], { type: 'image/jpeg' }), nm = bill.name.trim() || 'Customer';
    var fname = ('SB FOOD ' + nm + ' ' + dateText(bill.date)).replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-') + '.jpg';
    sharePdf(blob, fname, 'SB FOOD · ' + nm + ' · ' + dateText(bill.date) + ' · G. Total ' + C.formatINR(m.grand), 'Photo');
  }
  function openShare() { $('shareMenu').classList.add('show'); }
  function closeShare() { var e = $('shareMenu'); if (e) e.classList.remove('show'); }
  function downloadPdf() {
    var p = makePdf(); if (!p) return;
    var a = document.createElement('a'); a.href = URL.createObjectURL(p.blob); a.download = p.fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
    toast('PDF download ho gayi');
  }

  var toastT;
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 2600); }

  function newBill() {
    if (!confirm('Clear All? Naam, saari lines, Last Balance aur Received sab mit jayenge.')) return;
    try { if (storage) storage.removeItem(KEY); } catch (e) {}
    bill = blankBill(); stampKey = ''; fill(); toast('Sab clear ho gaya');
  }
  function isBlank(r) { return !(r.qty || r.wt || r.part || r.rate); }
  function fill() {
    while (bill.rows.length > DEF_ROWS && isBlank(bill.rows[bill.rows.length - 1])) bill.rows.pop();
    while (bill.rows.length < DEF_ROWS) bill.rows.push(blankRow());
    $('name').value = bill.name; $('date').value = bill.date; $('bal').value = bill.bal; $('rec').value = bill.rec;
    $('setSam').value = set.samiti; $('setRound').checked = !!set.round;
    renderRows(); update();
  }

  function bind() {
    $('rows').addEventListener('input', function (e) {
      var el = e.target; if (!el.dataset.f) return;
      bill.rows[+el.dataset.i][el.dataset.f] = el.value; update();
    });
    $('rows').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || C.hasExpr(e.target.value)) return;
      var all = Array.prototype.slice.call(document.querySelectorAll('#rows input')), i = all.indexOf(e.target);
      if (i >= 0 && all[i + 1]) { e.preventDefault(); all[i + 1].focus(); }
    });
    $('name').addEventListener('input', function () { bill.name = this.value; update(); });
    $('date').addEventListener('change', function () { bill.date = this.value || todayISO(); update(); });
    $('bal').addEventListener('input', function () { bill.bal = this.value; update(); });
    $('rec').addEventListener('input', function () { bill.rec = this.value; update(); });
    $('setSam').addEventListener('input', function () { set.samiti = this.value.trim() || '0'; update(); });
    $('setRound').addEventListener('change', function () { set.round = this.checked; update(); });
    $('btnNew').addEventListener('click', newBill);
    $('btnRow').addEventListener('click', function () { bill.rows.push(blankRow()); renderRows(); update(); var l = document.querySelectorAll('#rows tr'); l[l.length - 1].querySelector('input').focus(); });
    $('btnPrint').addEventListener('click', function () { document.activeElement && document.activeElement.blur(); setTimeout(function () { window.print(); }, 50); });
    $('btnWa').addEventListener('click', openShare);
    $('shPdf').addEventListener('click', sharePdfBill);
    $('shImg').addEventListener('click', sharePhotoBill);
    $('shX').addEventListener('click', closeShare);
    $('shareMenu').addEventListener('click', function (e) { if (e.target === this) closeShare(); });
    $('btnPdf').addEventListener('click', downloadPdf);
    $('btnSet').addEventListener('click', function () { $('settings').classList.toggle('show'); });
  }

    /* ---- Number keypad with + − × ÷ (replaces phone keyboard on touch screens) ---- */
  function imOf(el) { return el.getAttribute('data-im') || el.getAttribute('inputmode') || ''; }
  function isNumIn(el) { return el && el.tagName === 'INPUT' && /^(decimal|numeric)$/.test(imOf(el)); }
  var touchPad = false;
  function initCalcBar() {
    try { touchPad = window.matchMedia && window.matchMedia('(pointer: coarse)').matches; } catch (e) {}
    var bar = document.createElement('div'); bar.id = 'calcBar'; bar.className = 'calc-bar' + (touchPad ? ' pad' : '');
    var K = function (k, cls, lbl) { return '<button type="button" data-op="' + k + '"' + (cls ? ' class="' + cls + '"' : '') + '>' + (lbl || k) + '</button>'; };
    bar.innerHTML = '<div class="cb-top"><span class="cb-lbl" id="cbLbl"></span><span class="cb-res" id="cbRes"></span></div>' +
      (touchPad
        ? '<div class="cb-keys pad">' +
          K('7') + K('8') + K('9') + K('÷', 'op') + K('⌫', 'cb-del') +
          K('4') + K('5') + K('6') + K('×', 'op') + K('C', 'cb-clr') +
          K('1') + K('2') + K('3') + K('−', 'op') + K('next', 'cb-next', 'Next ›') +
          K('.') + K('0') + K('=', 'cb-eq') + K('+', 'op') + K('done', 'cb-done', 'Done') + '</div>'
        : '<div class="cb-keys">' + K('+', 'op') + K('−', 'op') + K('×', 'op') + K('÷', 'op') + K('⌫', 'cb-del') + K('=', 'cb-eq') + '</div>');
    document.body.appendChild(bar);
    var cur = null;
    function places(el) { return imOf(el) === 'numeric' ? 0 : (/rate|cash|online|old|amt/i.test((el.id || '') + (el.dataset.f || '')) ? 2 : 3); }
    function fire(el) { el.dispatchEvent(new Event('input', { bubbles: true })); }
    function label(el) {
      var l = el.closest('label'); if (l && l.querySelector('span')) return l.querySelector('span').textContent;
      return el.getAttribute('aria-label') || el.placeholder || '';
    }
    function show() {
      if (!cur) return;
      var v = cur.value, e = C.hasExpr(v), r = e ? C.evalExpr(v, places(cur)) : null;
      $('cbLbl').textContent = label(cur);
      $('cbRes').textContent = r !== null ? v + ' = ' + r : (e ? v + ' = ?' : (v || '+ − × ÷ se jodo, ghatao'));
      bar.classList.toggle('has', r !== null);
    }
    function settle(el) {
      if (!el || !C.hasExpr(el.value)) return;
      var r = C.evalExpr(el.value, places(el));
      if (r !== null) { el.title = el.value + ' = ' + r; el.value = r; fire(el); }
    }
    function open(el) {
      cur = el; bar.classList.add('show'); document.body.classList.add('calc-on'); show();
      if (touchPad) setTimeout(function () {
        var rb = el.getBoundingClientRect(), top = window.innerHeight - bar.offsetHeight - 12;
        if (rb.bottom > top) window.scrollBy({ top: rb.bottom - top, behavior: 'smooth' });
      }, 30);
    }
    function close() { bar.classList.remove('show'); document.body.classList.remove('calc-on'); cur = null; }
    function numInputs() { return Array.prototype.filter.call(document.querySelectorAll('input'), function (i) { return isNumIn(i) && i.offsetParent !== null && !i.disabled; }); }
    function prep(el) { if (touchPad && isNumIn(el) && el.getAttribute('inputmode') !== 'none') { el.setAttribute('data-im', el.getAttribute('inputmode')); el.setAttribute('inputmode', 'none'); } }
    if (touchPad) {
      document.addEventListener('pointerdown', function (e) { if (e.target.tagName === 'INPUT') prep(e.target); }, true);
      document.addEventListener('touchstart', function (e) { if (e.target.tagName === 'INPUT') prep(e.target); }, { capture: true, passive: true });
    }
    document.addEventListener('focusin', function (e) { if (isNumIn(e.target)) { prep(e.target); open(e.target); } });
    document.addEventListener('focusout', function (e) {
      if (e.target !== cur) return; var el = cur;
      setTimeout(function () { if (document.activeElement !== el) { settle(el); if (!isNumIn(document.activeElement)) close(); } }, 0);
    });
    document.addEventListener('input', function (e) { if (e.target === cur) show(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Enter' && cur && e.target === cur && C.hasExpr(cur.value)) { e.preventDefault(); settle(cur); show(); } });
    bar.addEventListener('pointerdown', function (e) { e.preventDefault(); });
    bar.addEventListener('mousedown', function (e) { e.preventDefault(); });
    bar.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b || !cur) return;
      var op = b.dataset.op, v = cur.value, len = v.length,
        st = cur.selectionStart == null ? len : cur.selectionStart, en = cur.selectionEnd == null ? len : cur.selectionEnd;
      if (touchPad && document.activeElement !== cur) { st = en = len; }
      if (op === '=') { settle(cur); show(); cur.focus(); return; }
      if (op === 'done') { settle(cur); cur.blur(); close(); return; }
      if (op === 'next') {
        settle(cur); var list = numInputs(), i = list.indexOf(cur), nx = list[i + 1];
        if (nx) { prep(nx); nx.focus(); try { nx.setSelectionRange(nx.value.length, nx.value.length); } catch (x) {} } else { cur.blur(); close(); }
        return;
      }
      if (op === 'C') { cur.value = ''; st = 0; }
      else if (op === '⌫') { if (st === en && st > 0) st--; cur.value = v.slice(0, st) + v.slice(en); }
      else { cur.value = v.slice(0, st) + op + v.slice(en); st += op.length; }
      try { cur.setSelectionRange(st, st); } catch (x) {}
      fire(cur); cur.focus();
    });
  }


  bind(); fill(); initCalcBar();
  if (!storage) $('notice').style.display = 'block';

  window.__sb = { bill: bill, compute: compute, billCanvas: billCanvas, set: function (b) { bill = b; fill(); } };
})();

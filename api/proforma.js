// ============ API : Génération de facture PROFORMA Échange (PDF) ============
// Génère un PDF (pdf-lib, pur JS) à partir des lignes cochées de la révision Échange.
// La proforma reprend EXACTEMENT les lignes reçues dans p.lines.
const { isLicenseActive } = require('./license.js');

function num(v){ var n = parseFloat(String(v == null ? '' : v).replace(/[^\d.\-]/g, '')); return isNaN(n) ? 0 : n; }
function money(n){ n = Math.round(Number(n) || 0); var neg = n < 0; var s = String(Math.abs(n)); var out = ''; while (s.length > 3){ out = ' ' + s.slice(-3) + out; s = s.slice(0, -3); } return (neg ? '-' : '') + s + out; }
function pdfSafe(s){
  return String(s == null ? '' : s)
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/[^\x00-\xFF]/g, '?');
}
function wrap(str, maxW, f, size){
  str = pdfSafe(str); var words = str.split(/\s+/); var lines = []; var cur = '';
  words.forEach(function(w){
    var t = cur ? cur + ' ' + w : w;
    if (f.widthOfTextAtSize(t, size) <= maxW) { cur = t; return; }
    if (cur) lines.push(cur);
    if (f.widthOfTextAtSize(w, size) > maxW){ var s = w; while (s.length){ var k = s.length; while (k > 1 && f.widthOfTextAtSize(s.slice(0, k), size) > maxW) k--; lines.push(s.slice(0, k)); s = s.slice(k); } cur = ''; }
    else cur = w;
  });
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

async function buildProformaPdf(p){
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const blue = rgb(0, 112/255, 192/255);
  const dark = rgb(0.13, 0.13, 0.13);
  const gray = rgb(0.42, 0.42, 0.42);
  const grayFill = rgb(0.93, 0.95, 0.98);
  const lineCol = rgb(0.75, 0.78, 0.82);
  const white = rgb(1, 1, 1);
  const W = 595.28, H = 841.89, ML = 40, MR = 555;
  let page = doc.addPage([W, H]);
  let y = H - 42;

  function T(str, x, yy, size, f, color){ page.drawText(pdfSafe(str), { x: x, y: yy, size: size, font: f || font, color: color || dark }); }
  function TR(str, xr, yy, size, f, color){ str = pdfSafe(str); var w = (f || font).widthOfTextAtSize(str, size); page.drawText(str, { x: xr - w, y: yy, size: size, font: f || font, color: color || dark }); }
  function TC(str, cx, yy, size, f, color){ str = pdfSafe(str); var w = (f || font).widthOfTextAtSize(str, size); page.drawText(str, { x: cx - w / 2, y: yy, size: size, font: f || font, color: color || dark }); }

  T("MAERSK COTE D'IVOIRE", ML, y, 9, bold, blue);
  TR('FACTURE PROFORMA ' + (p.type || 'ECHANGE'), MR, y, 13, bold, blue);
  y -= 7; page.drawLine({ start: { x: ML, y: y }, end: { x: MR, y: y }, thickness: 1.2, color: blue }); y -= 20;
  T(p.transitaire || '', ML, y, 12, bold, dark); y -= 19;

  var colR = 312, lh = 14;
  function row2(l1, v1, l2, v2){
    T(l1, ML, y, 8, bold, gray); T(v1 || '', ML + 95, y, 9, font, dark);
    if (l2){ T(l2, colR, y, 8, bold, gray); T(v2 || '', colR + 78, y, 9, font, dark); }
    y -= lh;
  }
  function rowFull(l1, v1){ T(l1, ML, y, 8, bold, gray); T(v1 || '', ML + 95, y, 9, font, dark); y -= lh; }
  row2('Business Partner', p.bp, 'Client', p.client);
  row2('Contract Account', p.contractAcc, 'UBLI', p.ubli);
  row2('Company code', p.companyCode || 'CI12', 'Type', p.type || 'ECHANGE');
  row2('Vessel', p.vessel, 'Voyage', p.voyage);
  row2('Zone de livraison', p.deliveryZone, 'Date', new Date().toLocaleDateString('fr-FR'));
  var conteneurs = (num(p.c40frigo)) + " x 40' Frigo    " + (num(p.c20sec)) + " x 20' Sec    " + (num(p.c40sec)) + " x 40' Sec";
  rowFull('Conteneurs', conteneurs);
  rowFull('Marchandise', (p.commodityName || '') + (p.commodityCode ? '  (' + p.commodityCode + ')' : ''));
  y -= 6;

  var cols = [
    { t: 'Description', x: ML,        w: 200, a: 'l' },
    { t: 'Base',        x: ML + 200,  w: 38,  a: 'c' },
    { t: 'Qte',         x: ML + 238,  w: 42,  a: 'r' },
    { t: 'Taux',        x: ML + 280,  w: 63,  a: 'r' },
    { t: 'Montant HT',  x: ML + 343,  w: 62,  a: 'r' },
    { t: 'TVA',         x: ML + 405,  w: 45,  a: 'r' },
    { t: 'Montant TTC', x: ML + 450,  w: 65,  a: 'r' }
  ];
  function drawVerticals(topY, botY){
    page.drawLine({ start: { x: ML, y: topY }, end: { x: ML, y: botY }, thickness: 0.5, color: lineCol });
    cols.forEach(function(c){ page.drawLine({ start: { x: c.x + c.w, y: topY }, end: { x: c.x + c.w, y: botY }, thickness: 0.5, color: lineCol }); });
  }
  var thH = 18, tableTop = y;
  page.drawRectangle({ x: ML, y: y - thH, width: 515, height: thH, color: blue });
  cols.forEach(function(c){
    if (c.a === 'r') TR(c.t, c.x + c.w - 4, y - 12.5, 8, bold, white);
    else if (c.a === 'c') TC(c.t, c.x + c.w / 2, y - 12.5, 8, bold, white);
    else T(c.t, c.x + 4, y - 12.5, 8, bold, white);
  });
  y -= thH;
  page.drawLine({ start: { x: ML, y: y }, end: { x: MR, y: y }, thickness: 0.5, color: lineCol });

  var lines = Array.isArray(p.lines) ? p.lines : [];
  var total = 0, secTop = tableTop;
  for (var i = 0; i < lines.length; i++){
    var l = lines[i] || {};
    var qty = num(l.qty), rate = num(l.rate), vat = (l.vat ? 1 : 0);
    var ht = qty * rate, tva = vat ? Math.round(ht * 0.18) : 0, ttc = ht + tva;
    total += ttc;
    var descLines = wrap(l.desc || '', cols[0].w - 8, font, 8.5);
    var rowH = Math.max(15, descLines.length * 10 + 5);
    if (y - rowH < 55){ drawVerticals(secTop, y); page = doc.addPage([W, H]); y = H - 42; secTop = y; }
    var ty = y - 11;
    descLines.forEach(function(dl){ T(dl, cols[0].x + 4, ty, 8.5, font, dark); ty -= 10; });
    TC(l.unit || '', cols[1].x + cols[1].w / 2, y - 11, 8.5);
    TR(String(qty), cols[2].x + cols[2].w - 4, y - 11, 8.5);
    TR(money(rate), cols[3].x + cols[3].w - 4, y - 11, 8.5);
    TR(money(ht), cols[4].x + cols[4].w - 4, y - 11, 8.5);
    TR(vat ? '18%' : '-', cols[5].x + cols[5].w - 4, y - 11, 8.5);
    TR(money(ttc), cols[6].x + cols[6].w - 4, y - 11, 8.5);
    y -= rowH;
    page.drawLine({ start: { x: ML, y: y }, end: { x: MR, y: y }, thickness: 0.5, color: lineCol });
  }
  drawVerticals(secTop, y);

  if (y - 24 < 55){ page = doc.addPage([W, H]); y = H - 42; }
  page.drawRectangle({ x: ML, y: y - 20, width: 515, height: 20, color: grayFill });
  T('TOTAL TTC', cols[4].x + 2, y - 14, 10, bold, blue);
  TR(money(total) + ' XOF', MR - 4, y - 14, 11, bold, blue);
  y -= 34;

  if (p.footer){
    if (y - 30 < 55){ page = doc.addPage([W, H]); y = H - 42; }
    T('External billing footer :', ML, y, 8, bold, gray); y -= 12;
    wrap(p.footer, 515, font, 8).forEach(function(fl){ T(fl, ML, y, 8, font, dark); y -= 10; });
  }

  return await doc.save();
}

function safeName(s){ return String(s || '').replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 40); }

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (req.method === 'GET') {
    var diag = { ok: true, node: process.version, format: 'pdf' };
    try { require('pdf-lib'); diag.pdflib = true; } catch (e) { diag.pdflib = false; diag.pdflibErr = e.message; }
    res.status(200).json(diag); return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'POST uniquement' }); return; }

  var active = false;
  try { active = await isLicenseActive(); } catch (e) { active = false; }
  if (!active) { res.status(403).json({ ok: false, blocked: true, error: 'Licence inactive' }); return; }

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const p = (body && body.proforma) || body || {};
    const bytes = await buildProformaPdf(p);
    const b64 = Buffer.from(bytes).toString('base64');
    const fname = 'Proforma_' + (safeName(p.bl) || safeName(p.ubli) || safeName(p.client) || 'echange') + '.pdf';
    res.status(200).json({ ok: true, b64: b64, filename: fname, mime: 'application/pdf' });
  } catch (e) {
    res.status(200).json({ ok: false, error: 'Erreur génération proforma : ' + e.message });
  }
};

// ============ API : Génération de facture PROFORMA Échange ============
// Remplit le VRAI template Excel (TEMPLATE_ECHANGE) : on n'écrit QUE les cellules
// d'entrée, tout le reste (montants, redevances, total) est recalculé par les
// formules du template à l'ouverture dans Excel. Style, fusions et feuille "Data"
// (taux par marchandise) sont préservés à l'identique.
const { isLicenseActive } = require('./license.js');

const SHEET = 'ECHANGE LIV ou PM';
function num(v) { var n = parseFloat(String(v == null ? '' : v).replace(/[^\d.\-]/g, '')); return isNaN(n) ? 0 : n; }

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // Diagnostic (GET) : vérifie dans le navigateur que la fonction charge bien exceljs + le template.
  if (req.method === 'GET') {
    var diag = { ok: true, node: process.version };
    try { require('exceljs'); diag.exceljs = true; } catch (e) { diag.exceljs = false; diag.exceljsErr = e.message; }
    try { var t = require('../lib/tpl_echange_b64.js'); diag.tpl = !!(t && t.length); diag.tplLen = t ? t.length : 0; } catch (e) { diag.tpl = false; diag.tplErr = e.message; }
    res.status(200).json(diag); return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'POST uniquement' }); return; }

  var active = false;
  try { active = await isLicenseActive(); } catch (e) { active = false; }
  if (!active) { res.status(403).json({ ok: false, blocked: true, error: 'Licence inactive' }); return; }

  try {
    // require « paresseux » : si exceljs ou le template manque, on renvoie une erreur JSON lisible (pas un HTTP 500).
    const ExcelJS = require('exceljs');
    const TPL_B64 = require('../lib/tpl_echange_b64.js');

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const p = (body && body.proforma) || body || {};

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(TPL_B64, 'base64'));
    const ws = wb.getWorksheet(SHEET) || wb.worksheets[0];

    // --- Cellules d'ENTRÉE uniquement (le template calcule le reste) ---
    ws.getCell('D5').value  = p.transitaire || '';                       // Nom du transitaire (= libellé du BP)
    ws.getCell('F6').value  = p.payerCode || '';                         // Code client Maersk (payeur)
    ws.getCell('F7').value  = p.companyCode || 'CI01';                   // Company code
    ws.getCell('C10').value = p.vessel || '';                            // Vessel name
    ws.getCell('C11').value = p.voyage || '';                            // Voyage number
    ws.getCell('C16').value = num(p.c40frigo);                           // Qté 40' Frigo
    ws.getCell('D16').value = num(p.c20sec);                             // Qté 20' Sec
    ws.getCell('E16').value = num(p.c40sec);                             // Qté 40' Sec
    ws.getCell('G18').value = (p.commodityCode == null ? '' : String(p.commodityCode)); // Code marchandise (Data!U)
    ws.getCell('C19').value = p.deliveryZone || 'ABIDJAN';               // Zone : ABIDJAN / HORS_ABIDJAN / PROPRE_MOYEN
    ws.getCell('I20').value = p.facturier || '';                         // Code facturier
    ws.getCell('C23').value = p.bl || '';                                // N° BL
    ws.getCell('E23').value = p.client || '';                            // Nom du client
    ws.getCell('D33').value = num(p.weight);                             // Poids conteneur (tonnes)

    // D34/D35 (=D33) traînent une valeur en cache (texte) du template -> réécriture pour forcer le recalcul partout
    ws.getCell('D34').value = { formula: 'D33' };
    ws.getCell('D35').value = { formula: 'D33' };

    // External billing footer (B20) : "transitaire P/C client//LIVRAISON ...// Frais de EIR-CH"
    if (p.footer) ws.getCell('B20').value = String(p.footer);

    // COMPATIBILITÉ : le template utilise XLOOKUP (Excel 365 uniquement) pour Red Mun / Red Port.
    // Remplacés par des VLOOKUP équivalents -> calcul correct dans TOUTES les versions Excel + LibreOffice.
    ws.getCell('E34').value = { formula: 'IFERROR(VLOOKUP($C$18,Data!$V:$Y,4,0),0)' };   // Red Mun (Data!Y)
    ws.getCell('E35').value = { formula: 'IFERROR(VLOOKUP($C$18,Data!$V:$X,3,0),0)' };   // Red Port (Data!X)

    // Forcer Excel à TOUT recalculer à l'ouverture
    try { wb.calcProperties = wb.calcProperties || {}; wb.calcProperties.fullCalcOnLoad = true; } catch (e) {}

    const buf = await wb.xlsx.writeBuffer();
    const b64 = Buffer.from(buf).toString('base64');
    const safe = function (s) { return String(s || '').replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 40); };
    const fname = 'Proforma_Echange_' + (safe(p.bl) || safe(p.client) || 'sans_ref') + '.xlsx';
    res.status(200).json({ ok: true, b64: b64, filename: fname });
  } catch (e) {
    res.status(200).json({ ok: false, error: 'Erreur génération proforma : ' + e.message });
  }
};

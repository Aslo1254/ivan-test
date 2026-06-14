// ============ API CACHÉE : Génération du CSV format SAP S/4HANA ============
// Ce code tourne sur le serveur Vercel. Le client ne le voit JAMAIS.
// Il reçoit les données du formulaire, fabrique le CSV, et renvoie le résultat.

const fs = require('fs');
const path = require('path');
const { isLicenseActive } = require('./license.js');

// Load the hidden headers (212 IT cols, 59 TT cols)
const IT_HDR = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'it_hdr.json'), 'utf8'));
const TT_HDR = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'tt_hdr.json'), 'utf8'));
const N_IT = IT_HDR.length;
const N_TT = TT_HDR.length;
const ECH_TPL = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'echange_templates.json'), 'utf8'));
const COMMODITIES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'commodities.json'), 'utf8'));
const COMM_MAP = {};
COMMODITIES.forEach(function(c){ COMM_MAP[c.c] = c; });

function resolveEchCode(code, io){
  if(code && typeof code === 'object'){ return io==='I' ? code.imp : code.exp; }
  return code;
}

// Build échange charge lines server-side (rates hidden). Handles multiple commodities (éclatement).
// params: {port, subtype, io, cnt, teu, weight, commodities:[{code, weight}]}
function buildEchangeCharges(params){
  const port = params.port || 'abidjan';
  const sub = params.subtype || (port==='sanpedro' ? 'standard' : 'echange');
  const io = params.io || 'I';
  const cnt = parseInt(params.cnt) || 1;
  const teu = parseInt(params.teu) || 1;
  const totalWeight = parseFloat(params.weight) || 0;
  const commodities = params.commodities || [];
  if(!ECH_TPL[port] || !ECH_TPL[port].subtypes[sub]) return [];
  const template = ECH_TPL[port].subtypes[sub].charges;
  const lines = [];

  template.forEach(function(ch){
    const code = resolveEchCode(ch.code, io);
    // Commodity-driven charges: Redevance Portuaire / Municipale / Communale (base TO with commodity rate)
    const isPort = /portuaire|red port(?! transit)/i.test(ch.d) && ch.base==='TO';
    const isMun = /municipale|red mun/i.test(ch.d);
    const isCom = /communale|red com/i.test(ch.d);

    // "Redevance" lines are visible by default in the review; others are masked
    const isRedevance = isPort || isMun || isCom || /portuaire|s\u00e9curit|security|isps|communaut/i.test(ch.d);

    if((isPort || isMun || isCom) && commodities.length > 0){
      // One line per commodity
      commodities.forEach(function(cm){
        const comm = COMM_MAP[cm.code];
        const w = parseFloat(cm.weight) || 0;
        if(w <= 0) return;
        let rate;
        if(isPort) rate = comm ? comm.p : ch.rate;
        else if(isMun) rate = comm ? comm.m : ch.rate;
        else rate = ch.rate; // communale flat (e.g. 20)
        const commName = comm ? comm.d.substring(0,30) : 'divers';
        lines.push({code:code, desc:ch.d+' ('+commName+')', bit:'COFR', qty:w, rate:rate, unit:'TO', vat:ch.vat, redevance:true});
      });
    } else {
      // Standard charge
      let qty;
      if(ch.base==='DOC') qty = (typeof ch.qty==='number') ? ch.qty : 1;
      else if(ch.base==='CNT') qty = cnt;
      else if(ch.base==='TEU') qty = teu;
      else if(ch.base==='TO') qty = totalWeight;
      else qty = 1;
      lines.push({code:code, desc:ch.d, bit:'COFR', qty:qty, rate:ch.rate, unit:(ch.base==='TO'?'TO':'EA'), vat:ch.vat, redevance:isRedevance});
    }
  });
  return lines;
}

const CREDIT_SUBS = {"MCMN":1,"MCVS":1,"MCVP":1,"MCCC":1,"IMCC":1,"IMEC":1,"MCCG":1};
function isCredit(inv){ return !!CREDIT_SUBS[inv.subprocess]; }

function buildItRow(inv, line, seq, txtGroup, firstBooking){
  const row = new Array(N_IT + 1).fill("");
  const unit = line.unit || "EA";
  // CORRECTIF MULTI-LIGNES : TXT_GROUP doit etre CONSTANT pour toutes les lignes d'une meme
  // facture (TEXT1, TEXT2... par facture, JAMAIS par ligne). Avec l'ancien "TEXT"+seq, les
  // lignes recevaient TEXT1/TEXT2/TEXT3 -> SAP n'arrivait plus a les regrouper dans un seul
  // document de facturation -> erreur "Dependency is not assigned" / BITPACK_SET.
  row[0]="IT"; row[1]="ZSMMI"; row[3]=inv.contractAcc; row[4]=txtGroup;
  row[6]=inv.subprocess; row[7]=line.bit; row[8]=String(line.amount); row[9]=inv.currency;
  row[10]="S";
  // Date : IMPORT -> arrival date, EXPORT -> sailing date.
  // Override PAR LIGNE possible (line.date) pour les factures multi-BL ou chaque ligne a sa propre date.
  var theDate = line.date || ((inv.expImp==="I") ? (inv.arrivalDate||"") : (inv.sailingDate||""));
  row[15]=theDate;   // BITDATE_TO (le fichier SAP valid\u00e9 place la date ici, pas en BITDATE_FROM)
  row[19]=unit; row[20]=String(line.qty);
  row[22]=inv.companyCode; row[28]=inv.bp; row[29]=inv.businessArea; row[43]="X";
  row[44]=line.profitCenter || inv.profitCenter; row[46]="X"; row[63]="03"; row[64]="01"; row[71]=unit;  // PRCTR : override par ligne (ML01, ML02...)
  row[82]=String(line.amount); row[84]=String(seq); row[85]=inv.expImp;
  var lineUbli = line.ubli || inv.ubli;
  if(lineUbli) row[94]=lineUbli;                       // ZZBLUBLI = MAEU+BL (override par ligne)
  row[97]=inv.bp;
  row[106]="CI";                                        // ZZCOUNTRYCODE
  var lineCbu = line.cbu || inv.cbu;
  if(lineCbu) row[101]=lineCbu;                        // ZZCBU (Collection Business Unit) - override par ligne
  row[102]=String(line.code).substring(0,8);
  row[108]=inv.currency; row[109]=inv.currency;
  row[115]="3"; row[116]="2"; row[117]="1"; row[118]="1";
  if(inv.extFooter) row[129]=inv.extFooter;            // ZZFOOTERNOTE = external billing footer (SAP header text)
  var lineBooking = line.booking || inv.bl;
  if(lineBooking) row[120]=lineBooking;                // ZZEQBOOKNO = booking PAR LIGNE (chaque BL a le sien)
  row[138]=inv.invGrouping;
  if(firstBooking) row[155]=firstBooking;              // ZZPO_NO = booking d'ancrage de la facture (1ere ligne), identique sur toutes les lignes
  row[158]="X"; row[159]=String(line.rate); row[160]="1"; row[161]="X";
  if(firstBooking) row[164]=firstBooking;              // ZZREF  = booking d'ancrage de la facture (1ere ligne), identique sur toutes les lignes
  row[168]=inv.salesOffice; row[172]=inv.bp; row[173]="I"; row[176]="0";
  row[195]=theDate; // ZZDIS_ARR_DATFB (date c\u00f4t\u00e9 SAP valid\u00e9, pas ZZLOA_SAI_DATFB)
  return row;
}
function buildTtRow(recordType, seq, email, name){
  const row = new Array(N_TT + 1).fill("");
  row[0]="TT"; row[1]="ZSMMI";
  if(email) row[7]=email;
  if(name) row[8]=name;
  row[28]="3"; row[29]="2"; row[30]="1"; row[31]="1";
  row[42]=recordType;
  if(recordType==="CNT") row[56]=String(seq);
  return row;
}
function buildExtractCSV(invoices, opts){
  opts = opts || {};
  const out = [];
  out.push("400;SMMI;");
  out.push(IT_HDR.join(";"));
  out.push(TT_HDR.join(";"));
  invoices.forEach(function(inv, invIdx){
    // BULK mode: assign Invoice Grouping 1, 2, 3... per invoice in the file
    if(opts.bulk){ inv = Object.assign({}, inv, {invGrouping: String(invIdx + 1)}); }
    // Groupe de texte CONSTANT pour toutes les lignes de CETTE facture (TEXT1, TEXT2... par facture)
    var txtGroup = "TEXT" + (invIdx + 1);
    // Booking d'ancrage = booking de la 1ere ligne (sinon inv.bl). ZZPO_NO / ZZREF identiques sur toutes les lignes.
    var firstBooking = (inv.lines[0] && inv.lines[0].booking) || inv.bl;
    const credit = isCredit(inv);
    inv.lines.forEach(function(line, li){
      const raw = line.qty * line.rate;
      // CREDIT types: amounts become negative
      line.amount = credit ? -Math.abs(raw) : raw;
      out.push(buildItRow(inv, line, li+1, txtGroup, firstBooking).join(";"));
    });
  });
  // UN SEUL bloc de fin pour TOUT le fichier (1 en-tete + items groupes par ZZINV_GROUPING + 1 bloc de fin).
  // Plusieurs blocs CLK/CNT intercales font echouer l'import SAP S/4HANA. Le compteur CNT = nombre de factures.
  // (1 seule facture => seq=1, identique au fichier valide ; en bloc => seq=N.)
  var firstInv = invoices[0] || {};
  out.push(buildTtRow("CLK", invoices.length, "", "").join(";"));
  out.push(buildTtRow("CNT", invoices.length, firstInv.clerkEmail, firstInv.clerkName||"").join(";"));
  return out.join("\r\n");
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS'){ res.status(200).end(); return; }
  if(req.method !== 'POST'){ res.status(405).json({error:'Method not allowed'}); return; }

  // KILL SWITCH: server refuses to generate if license inactive
  const active = await isLicenseActive();
  if(!active){ res.status(403).json({error:'Licence inactive', blocked:true}); return; }

  try{
    // Échange charge computation (returns editable lines for the review step)
    if(req.body && req.body.echangeCharges){
      const lines = buildEchangeCharges(req.body.echangeCharges);
      res.status(200).json({ ok:true, lines: lines });
      return;
    }
    const body = req.body;
    const invoices = body.invoices || [body];
    // Basic validation
    for(const inv of invoices){
      var hasDate = inv.sailingDate || inv.arrivalDate || ((inv.lines||[]).some(function(l){ return l && l.date; }));
      if(!inv.bp || !inv.contractAcc || !hasDate || !inv.lines || !inv.lines.length){
        res.status(400).json({error:'Données de facture incomplètes'});
        return;
      }
    }
    const bulk = !!(body && body.bulk);
    const csv = buildExtractCSV(invoices, {bulk: bulk});
    res.status(200).json({ ok:true, csv: csv });
  }catch(err){
    res.status(500).json({error: 'Erreur génération: ' + err.message});
  }
};

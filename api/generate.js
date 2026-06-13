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

function buildItRow(inv, line, seq){
  const row = new Array(N_IT + 1).fill("");
  const unit = line.unit || "EA";
  row[0]="IT"; row[1]="ZSMMI"; row[3]=inv.contractAcc; row[4]="TEXT"+seq;
  row[6]=inv.subprocess; row[7]=line.bit; row[8]=String(line.amount); row[9]=inv.currency;
  row[10]="S";
  // Date logic: IMPORT -> arrival date (BITDATE_FROM idx14 stays empty for sailing),
  //             EXPORT -> sailing date. We store the relevant date in idx14 + idx194.
  var theDate = (inv.expImp==="I") ? (inv.arrivalDate||"") : (inv.sailingDate||"");
  row[15]=theDate;   // BITDATE_TO (le fichier SAP valid\u00e9 place la date ici, pas en BITDATE_FROM)
  row[19]=unit; row[20]=String(line.qty);
  row[22]=inv.companyCode; row[28]=inv.bp; row[29]=inv.businessArea; row[43]="X";
  row[44]=inv.profitCenter; row[46]="X"; row[63]="03"; row[64]="01"; row[71]=unit;
  row[82]=String(line.amount); row[84]=String(seq); row[85]=inv.expImp;
  if(inv.ubli) row[94]=inv.ubli;                       // ZZBLUBLI = MAEU+BL
  row[97]=inv.bp;
  row[106]="CI";                                        // ZZCOUNTRYCODE
  if(inv.cbu) row[101]=inv.cbu;                        // ZZCBU (Collection Business Unit)
  row[102]=String(line.code).substring(0,8);
  row[108]=inv.currency; row[109]=inv.currency;
  row[115]="3"; row[116]="2"; row[117]="1"; row[118]="1";
  if(inv.extFooter) row[129]=inv.extFooter;            // ZZFOOTERNOTE = external billing footer (SAP header text)
  if(inv.bl) row[120]=inv.bl;                          // ZZEQBOOKNO = booking (requis par SAP pour la d\u00e9pendance)
  row[138]=inv.invGrouping;
  if(inv.bl) row[155]=inv.bl;                          // ZZPO_NO = BL
  row[158]="X"; row[159]=String(line.rate); row[160]="1"; row[161]="X";
  if(inv.bl) row[164]=inv.bl;                          // ZZREF = BL
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
    const credit = isCredit(inv);
    inv.lines.forEach(function(line, li){
      const raw = line.qty * line.rate;
      // CREDIT types: amounts become negative
      line.amount = credit ? -Math.abs(raw) : raw;
      out.push(buildItRow(inv, line, li+1).join(";"));
    });
    out.push(buildTtRow("CLK", 1, "", "").join(";"));
    out.push(buildTtRow("CNT", 1, inv.clerkEmail, inv.clerkName||"").join(";"));
  });
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
      var hasDate = inv.sailingDate || inv.arrivalDate;
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

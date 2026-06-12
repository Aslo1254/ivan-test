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

function buildItRow(inv, line, seq){
  const row = new Array(N_IT + 1).fill("");
  row[0]="IT"; row[1]="ZSMMI"; row[3]=inv.contractAcc; row[4]="TEXT"+seq;
  row[6]=inv.subprocess; row[7]=line.bit; row[8]=String(line.amount); row[9]=inv.currency;
  row[10]="S"; row[14]=inv.sailingDate; row[19]="EA"; row[20]=String(line.qty);
  row[22]=inv.companyCode; row[28]=inv.bp; row[29]=inv.businessArea; row[43]="X";
  row[44]=inv.profitCenter; row[46]="X"; row[63]="03"; row[64]="01"; row[71]="EA";
  row[82]=String(line.amount); row[84]=String(seq); row[85]=inv.expImp;
  if(inv.ubli) row[94]=inv.ubli;
  row[97]=inv.bp;
  if(inv.cbu) row[101]=inv.cbu;
  row[102]=String(line.code).substring(0,8);
  row[108]=inv.currency; row[109]=inv.currency;
  row[115]="3"; row[116]="2"; row[117]="1"; row[118]="1";
  row[138]=inv.invGrouping; row[158]="X"; row[159]=String(line.rate); row[160]="1"; row[161]="X";
  row[168]=inv.salesOffice; row[172]=inv.bp; row[173]="I"; row[176]="0"; row[194]=inv.sailingDate;
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
function buildExtractCSV(invoices){
  const out = [];
  out.push("400;SMMI;");
  out.push(IT_HDR.join(";"));
  out.push(TT_HDR.join(";"));
  invoices.forEach(function(inv){
    inv.lines.forEach(function(line, li){
      line.amount = line.qty * line.rate;
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
    const body = req.body;
    const invoices = body.invoices || [body];
    // Basic validation
    for(const inv of invoices){
      if(!inv.bp || !inv.contractAcc || !inv.sailingDate || !inv.lines || !inv.lines.length){
        res.status(400).json({error:'Données de facture incomplètes'});
        return;
      }
    }
    const csv = buildExtractCSV(invoices);
    res.status(200).json({ ok:true, csv: csv });
  }catch(err){
    res.status(500).json({error: 'Erreur génération: ' + err.message});
  }
};

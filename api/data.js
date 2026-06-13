// ============ API CACHÉE : Données de référence (BP, charges, types) ============
// La base des 2891 Business Partners et les 1568 charge codes vivent ICI, sur le serveur.
// Le client ne reçoit que les résultats de recherche, jamais la base complète.

const fs = require('fs');
const path = require('path');

const BP_DB = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'bp_data.json'), 'utf8'));
const CHARGES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'charges.json'), 'utf8'));
const INV_TYPES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'inv_types.json'), 'utf8'));
const COMMODITIES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'commodities.json'), 'utf8'));
const { isLicenseActive } = require('./license.js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS'){ res.status(200).end(); return; }

  // KILL SWITCH: server refuses data if license inactive
  const active = await isLicenseActive();
  if(!active){ res.status(403).json({error:'Licence inactive', blocked:true}); return; }

  const action = (req.query && req.query.action) || (req.body && req.body.action);

  try{
    // Invoice types (small list, OK to send all)
    if(action === 'invtypes'){
      res.status(200).json({ ok:true, types: INV_TYPES });
      return;
    }

    // BP search - returns only matches, never the full DB
    if(action === 'bp'){
      const q = String((req.query.q || (req.body && req.body.q) || "")).trim().toUpperCase();
      if(q.length < 2){ res.status(200).json({ ok:true, results: [] }); return; }
      const matches = [];
      // Search by ECC code
      for(const ecc in BP_DB){
        if(ecc.toUpperCase().indexOf(q) >= 0){
          const parts = BP_DB[ecc].split("|");
          matches.push({ ecc:ecc, bp:parts[0], name:parts[1]||"" });
          if(matches.length >= 30) break;
        }
      }
      // If none, search by name
      if(matches.length === 0){
        for(const ecc in BP_DB){
          const parts = BP_DB[ecc].split("|");
          if((parts[1]||"").toUpperCase().indexOf(q) >= 0){
            matches.push({ ecc:ecc, bp:parts[0], name:parts[1]||"" });
            if(matches.length >= 30) break;
          }
        }
      }
      res.status(200).json({ ok:true, results: matches });
      return;
    }

    // Charge code search - returns only matches
    if(action === 'charges'){
      const q = String((req.query.q || (req.body && req.body.q) || "")).trim().toUpperCase();
      if(q.length < 2){ res.status(200).json({ ok:true, results: [] }); return; }
      const matches = [];
      for(let i=0;i<CHARGES.length;i++){
        const c = CHARGES[i];
        if(c.t.toUpperCase().indexOf(q)>=0 || c.c.indexOf(q)>=0){
          matches.push(c);
          if(matches.length>=25) break;
        }
      }
      res.status(200).json({ ok:true, results: matches });
      return;
    }

    // BP count (for display)
    if(action === 'bpcount'){
      res.status(200).json({ ok:true, count: Object.keys(BP_DB).length });
      return;
    }

    // Look up a single charge code's BIT type (for batch)
    if(action === 'bitfor'){
      const code = String((req.query.code || (req.body && req.body.code) || "")).trim();
      let bit = "";
      for(let i=0;i<CHARGES.length;i++){ if(CHARGES[i].c===code){ bit=CHARGES[i].b; break; } }
      res.status(200).json({ ok:true, bit: bit });
      return;
    }

    // Commodity search (returns matches; rates kept but client needs them only for display selection)
    if(action === 'commodity'){
      const q = String((req.query.q || (req.body && req.body.q) || "")).trim().toUpperCase();
      if(q.length < 2){ res.status(200).json({ ok:true, results: [] }); return; }
      const matches = [];
      for(let i=0;i<COMMODITIES.length;i++){
        const c = COMMODITIES[i];
        if(c.d.toUpperCase().indexOf(q)>=0 || c.c.indexOf(q)>=0){
          matches.push(c);
          if(matches.length>=25) break;
        }
      }
      res.status(200).json({ ok:true, results: matches });
      return;
    }

    res.status(400).json({error:'Action inconnue'});
  }catch(err){
    res.status(500).json({error: 'Erreur data: ' + err.message});
  }
};

// ============ API : Stockage partagé (comptes, brouillons, file) via Upstash Redis ============
// Centralise comptes/brouillons/file pour que TOUS les postes voient les mêmes données.
// Les clés env UPSTASH_REDIS_REST_URL / _TOKEN sont injectées automatiquement par Vercel.

const { Redis } = require('@upstash/redis');
const { isLicenseActive } = require('./license.js');
const fs = require('fs');
const path = require('path');

// Default CHB (Échange) templates - shipped with the app.
// Chargement TOLÉRANT : plusieurs noms possibles, jamais d'exception au démarrage
// (un fichier lib renommé à l'upload ne doit JAMAIS casser /store : login, comptes, BP, CA).
function loadLibJson(candidates, fallback){
  for(let i=0;i<candidates.length;i++){
    try{
      const p = path.join(__dirname, '..', 'lib', candidates[i]);
      if(fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    }catch(e){ /* nom suivant */ }
  }
  return (fallback !== undefined) ? fallback : {};
}
const CHB_DEFAULTS = loadLibJson(['chb_templates.json', 'chb templates.json'], {});
const ECH_DEFAULTS = loadLibJson(['echange_templates.json', 'echange templates.json', 'echangetemplates.json'], {});
const CBU_LIST = loadLibJson(['cbu_list.json', 'cbu list.json'], []);
// Contract-account defaults: PLUS UTILISES (les comptes proviennent desormais uniquement de l'import manager).
let CA_MAP_DEFAULT = loadLibJson(['ca_map.json', 'ca map.json'], {});

const redis = Redis.fromEnv();

// Keys in Redis
const K_USERS = "ivan:users";
const K_DRAFTS = "ivan:drafts";
const K_QUEUE = "ivan:queue";
const K_CHB = "ivan:chb_templates";
const K_ECHT = "ivan:echange_templates";
const K_ECH_OV = "ivan:ech_charge_ov";  // overrides codes/libellés de charges par port/sous-type (managé)
const K_HISTORY = "ivan:history";
const K_CBU = "ivan:cbu_list";
const K_CA_OVERRIDES = "ivan:ca_overrides";  // manager edits per BP: {bp: [{ca,name}]}
const K_FNE = "ivan:fnebatch";  // batch FNE partage (queue + config + etat) - lu par le bookmarklet cross-origin

// Default manager account (guaranteed to always exist)
const DEFAULT_USER = { user:"ivan", pass:"ivan2026", role:"manager", email:"ivan.assani@maersk.com", name:"Ivan ASSANI" };

// Permissions effectives d'un utilisateur (objet { section: bool }).
// Migration : si l'ancienne option booléenne `fne` existe sans `perms`, on la reporte sur perms.fne.
function effPerms(u){
  const p = (u && u.perms && typeof u.perms === "object") ? Object.assign({}, u.perms) : {};
  if(p.fne === undefined && u && u.fne !== undefined) p.fne = !!u.fne;
  return p;
}

async function getUsers(){
  let users = await redis.get(K_USERS);
  if(!users || !Array.isArray(users) || users.length===0){
    users = [DEFAULT_USER];
    await redis.set(K_USERS, users);
  }
  // Always guarantee the default manager exists and clean null entries
  users = users.filter(function(u){ return u && u.user && u.pass; });
  if(!users.some(function(u){ return u.user==="ivan"; })){
    users.unshift(DEFAULT_USER);
  }
  return users;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS'){ res.status(200).end(); return; }

  // Kill switch
  const active = await isLicenseActive();
  if(!active){ res.status(403).json({error:'Licence inactive', blocked:true}); return; }

  const action = (req.query && req.query.action) || (req.body && req.body.action);

  try{
    // ===== LOGIN =====
    if(action === 'login'){
      const u = (req.body && req.body.user || "").trim();
      const p = (req.body && req.body.pass || "");
      const users = await getUsers();
      const found = users.find(function(x){ return x.user.toLowerCase()===u.toLowerCase() && x.pass===p; });
      if(found){ res.status(200).json({ ok:true, user:{user:found.user, role:found.role, email:found.email||"", name:found.name||"", fne: !!found.fne, perms: effPerms(found)} }); }
      else { res.status(200).json({ ok:false, error:"Nom d'utilisateur ou mot de passe incorrect" }); }
      return;
    }

    // ===== LIST USERS (manager) =====
    if(action === 'users'){
      const users = await getUsers();
      // never send passwords to the client
      res.status(200).json({ ok:true, users: users.map(function(u){ return {user:u.user, role:u.role, fne: !!u.fne, perms: effPerms(u)}; }) });
      return;
    }

    // ===== ADD USER =====
    if(action === 'adduser'){
      const u = (req.body && req.body.user || "").trim();
      const p = (req.body && req.body.pass || "");
      const role = (req.body && req.body.role) === "manager" ? "manager" : "agent";
      const email = (req.body && req.body.email || "").trim();
      const name = (req.body && req.body.name || "").trim();
      if(!u || !p){ res.status(200).json({ ok:false, error:"Nom et mot de passe requis" }); return; }
      const users = await getUsers();
      if(users.some(function(x){ return x.user.toLowerCase()===u.toLowerCase(); })){
        res.status(200).json({ ok:false, error:"Ce nom d'utilisateur existe déjà" }); return;
      }
      users.push({ user:u, pass:p, role:role, email:email, name:name, fne: !!(req.body && req.body.fne), perms: (req.body && req.body.perms && typeof req.body.perms==="object") ? req.body.perms : {} });
      await redis.set(K_USERS, users);
      res.status(200).json({ ok:true, users: users.map(function(x){ return {user:x.user, role:x.role, fne: !!x.fne, perms: effPerms(x)}; }) });
      return;
    }

    // ===== SET FNE ACCESS (compat) — repointé sur perms.fne =====
    if(action === 'setuserfne'){
      const u = (req.body && req.body.user || "").trim();
      const val = !!(req.body && req.body.fne);
      const users = await getUsers();
      const idx = users.findIndex(function(x){ return x.user.toLowerCase()===u.toLowerCase(); });
      if(idx < 0){ res.status(200).json({ ok:false, error:"Utilisateur introuvable" }); return; }
      users[idx].fne = val;
      users[idx].perms = Object.assign({}, users[idx].perms, { fne: val });
      await redis.set(K_USERS, users);
      res.status(200).json({ ok:true, users: users.map(function(x){ return {user:x.user, role:x.role, fne: !!x.fne, perms: effPerms(x)}; }) });
      return;
    }

    // ===== SET PERMISSIONS (manager) — accès par module pour un agent =====
    // body: { user, perms:{ invoice:bool, echange:bool, fne:bool, history:bool, queue:bool, bp:bool, upload:bool } }
    if(action === 'setperms'){
      const u = (req.body && req.body.user || "").trim();
      const raw = (req.body && req.body.perms && typeof req.body.perms === "object") ? req.body.perms : {};
      const clean = {};
      Object.keys(raw).forEach(function(k){ clean[k] = !!raw[k]; });
      const users = await getUsers();
      const idx = users.findIndex(function(x){ return x.user.toLowerCase()===u.toLowerCase(); });
      if(idx < 0){ res.status(200).json({ ok:false, error:"Utilisateur introuvable" }); return; }
      users[idx].perms = clean;
      if(clean.fne !== undefined) users[idx].fne = clean.fne; // garde l'ancien champ cohérent
      await redis.set(K_USERS, users);
      res.status(200).json({ ok:true, users: users.map(function(x){ return {user:x.user, role:x.role, fne: !!x.fne, perms: effPerms(x)}; }) });
      return;
    }

    // ===== UPDATE OWN PROFILE (email, name, password) =====
    if(action === 'updateprofile'){
      const u = (req.body && req.body.user || "").trim();
      const users = await getUsers();
      const idx = users.findIndex(function(x){ return x.user.toLowerCase()===u.toLowerCase(); });
      if(idx < 0){ res.status(200).json({ ok:false, error:"Utilisateur introuvable" }); return; }
      if(req.body.email !== undefined) users[idx].email = String(req.body.email).trim();
      if(req.body.name !== undefined) users[idx].name = String(req.body.name).trim();
      if(req.body.newpass) users[idx].pass = String(req.body.newpass);
      await redis.set(K_USERS, users);
      res.status(200).json({ ok:true, user:{user:users[idx].user, role:users[idx].role, email:users[idx].email||"", name:users[idx].name||""} });
      return;
    }

    // ===== DELETE USER =====
    if(action === 'deluser'){
      const u = (req.body && req.body.user || "").trim();
      if(u.toLowerCase()==="ivan"){ res.status(200).json({ ok:false, error:"Impossible de supprimer le compte principal" }); return; }
      let users = await getUsers();
      users = users.filter(function(x){ return x.user.toLowerCase()!==u.toLowerCase(); });
      await redis.set(K_USERS, users);
      res.status(200).json({ ok:true, users: users.map(function(x){ return {user:x.user, role:x.role}; }) });
      return;
    }

    // ===== DRAFTS =====
    if(action === 'getdrafts'){
      const drafts = await redis.get(K_DRAFTS);
      res.status(200).json({ ok:true, drafts: drafts || [] });
      return;
    }
    if(action === 'setdrafts'){
      const drafts = (req.body && req.body.drafts) || [];
      await redis.set(K_DRAFTS, drafts);
      res.status(200).json({ ok:true });
      return;
    }

    // ===== QUEUE =====
    if(action === 'getqueue'){
      const queue = await redis.get(K_QUEUE);
      res.status(200).json({ ok:true, queue: queue || [] });
      return;
    }
    if(action === 'setqueue'){
      const queue = (req.body && req.body.queue) || [];
      await redis.set(K_QUEUE, queue);
      res.status(200).json({ ok:true });
      return;
    }

    // ===== CHB TEMPLATES (Échange) =====
    if(action === 'getchb'){
      // Return manager-corrected templates if they exist, else defaults
      let tpl = await redis.get(K_CHB);
      if(!tpl){ tpl = CHB_DEFAULTS; }
      res.status(200).json({ ok:true, templates: tpl });
      return;
    }
    if(action === 'setchb'){
      // Manager saves corrected templates (codes, rates, etc.)
      const templates = (req.body && req.body.templates);
      if(!templates){ res.status(200).json({ ok:false, error:"Templates manquants" }); return; }
      await redis.set(K_CHB, templates);
      res.status(200).json({ ok:true });
      return;
    }
    if(action === 'resetchb'){
      // Reset to factory defaults
      await redis.set(K_CHB, CHB_DEFAULTS);
      res.status(200).json({ ok:true, templates: CHB_DEFAULTS });
      return;
    }

    // ===== ÉCHANGE TEMPLATES (v2) =====
    if(action === 'getecht'){
      let tpl = await redis.get(K_ECHT);
      if(!tpl){ tpl = ECH_DEFAULTS; }
      res.status(200).json({ ok:true, templates: tpl });
      return;
    }
    if(action === 'setecht'){
      const templates = (req.body && req.body.templates);
      if(!templates){ res.status(200).json({ ok:false, error:"Templates manquants" }); return; }
      await redis.set(K_ECHT, templates);
      res.status(200).json({ ok:true });
      return;
    }
    if(action === 'resetecht'){
      await redis.set(K_ECHT, ECH_DEFAULTS);
      res.status(200).json({ ok:true, templates: ECH_DEFAULTS });
      return;
    }

    // ===== PARAMÉTRAGE CODES/LIBELLÉS DES CHARGES (managé, partagé équipe) =====
    if(action === 'getchargeov'){
      let ov = await redis.get(K_ECH_OV);
      res.status(200).json({ ok:true, overrides: ov || {} });
      return;
    }
    if(action === 'setchargeov'){
      const ov = (req.body && req.body.overrides);
      if(ov === undefined || ov === null){ res.status(200).json({ ok:false, error:"overrides manquants" }); return; }
      await redis.set(K_ECH_OV, ov);
      res.status(200).json({ ok:true });
      return;
    }
    if(action === 'resetchargeov'){
      await redis.set(K_ECH_OV, {});
      res.status(200).json({ ok:true, overrides: {} });
      return;
    }

    // ===== HISTORY (emitted invoices) =====
    if(action === 'addhistory'){
      const entry = (req.body && req.body.entry);
      if(!entry){ res.status(200).json({ ok:false, error:"Entr\u00e9e manquante" }); return; }
      let hist = await redis.get(K_HISTORY);
      if(!hist || !Array.isArray(hist)) hist = [];
      entry.ts = Date.now();
      entry.id = "INV" + entry.ts;
      hist.unshift(entry);
      // keep last 1000 entries
      if(hist.length > 1000) hist = hist.slice(0, 1000);
      await redis.set(K_HISTORY, hist);
      res.status(200).json({ ok:true, id: entry.id });
      return;
    }
    if(action === 'gethistory'){
      let hist = await redis.get(K_HISTORY);
      res.status(200).json({ ok:true, history: hist || [] });
      return;
    }
    if(action === 'clearhistory'){
      // manager only - clear all history
      await redis.set(K_HISTORY, []);
      res.status(200).json({ ok:true });
      return;
    }

    // ===== CBU BA LIST =====
    if(action === 'getcbu'){
      let cbu = await redis.get(K_CBU);
      if(!cbu) cbu = CBU_LIST;
      res.status(200).json({ ok:true, cbu: cbu });
      return;
    }
    if(action === 'setcbu'){
      const cbu = (req.body && req.body.cbu);
      if(!cbu){ res.status(200).json({ ok:false, error:"Donn\u00e9es manquantes" }); return; }
      await redis.set(K_CBU, cbu);
      res.status(200).json({ ok:true });
      return;
    }

    // ===== BATCH FNE (partage cross-origin avec le bookmarklet sur le portail DGI) =====
    // Le bookmarklet tourne sur services.fne.dgi.gouv.ci (autre origine) : il NE PEUT PAS lire le
    // localStorage du domaine IVAN. On stocke donc le batch ici (Redis) et il le recupere par fetch.
    if(action === 'getfnebatch'){
      let fne = await redis.get(K_FNE);
      if(!fne) fne = { queue: [], config: {}, state: "idle" };
      res.status(200).json({ ok:true, fne: fne });
      return;
    }
    if(action === 'setfnebatch'){
      const fne = (req.body && req.body.fne);
      if(!fne){ res.status(200).json({ ok:false, error:"Donn\u00e9es manquantes" }); return; }
      await redis.set(K_FNE, fne);
      res.status(200).json({ ok:true });
      return;
    }

    // ===== CONTRACT ACCOUNTS (par BP) — source unique = ce que le manager importe/saisit =====
    if(action === 'getca'){
      const bp = String((req.body && req.body.bp) || (req.query && req.query.bp) || "").trim();
      if(!bp){ res.status(200).json({ ok:true, accounts: [] }); return; }
      const overrides = (await redis.get(K_CA_OVERRIDES)) || {};
      // Plus de defaut code en dur : on ne renvoie que ce qui a ete importe/saisi pour ce BP.
      const list = Array.isArray(overrides[bp]) ? overrides[bp] : [];
      res.status(200).json({ ok:true, accounts: list });
      return;
    }
    if(action === 'setca'){
      // Manager sets the full list of accounts for a BP
      const bp = String((req.body && req.body.bp) || "").trim();
      const accounts = (req.body && req.body.accounts);
      if(!bp || !Array.isArray(accounts)){ res.status(200).json({ ok:false, error:"BP et comptes requis" }); return; }
      const overrides = (await redis.get(K_CA_OVERRIDES)) || {};
      overrides[bp] = accounts;
      await redis.set(K_CA_OVERRIDES, overrides);
      res.status(200).json({ ok:true, accounts: accounts });
      return;
    }
    if(action === 'setcabulk'){
      // Import en masse : map = { bp: [{ca,name}, ...], ... }. Par defaut FUSIONNE ; replace:true pour tout remplacer.
      const map = (req.body && req.body.map);
      const replace = !!(req.body && req.body.replace);
      if(!map || typeof map !== "object"){ res.status(200).json({ ok:false, error:"map requise" }); return; }
      let overrides = replace ? {} : ((await redis.get(K_CA_OVERRIDES)) || {});
      let nbBp = 0, nbCa = 0;
      Object.keys(map).forEach(function(bp){
        const arr = Array.isArray(map[bp]) ? map[bp].filter(function(a){ return a && a.ca; }) : [];
        if(!arr.length) return;
        overrides[bp] = arr; nbBp++; nbCa += arr.length;
      });
      await redis.set(K_CA_OVERRIDES, overrides);
      res.status(200).json({ ok:true, bp: nbBp, ca: nbCa });
      return;
    }
    if(action === 'clearallca'){
      // Supprime TOUS les contract accounts (remet la base a vide)
      await redis.set(K_CA_OVERRIDES, {});
      res.status(200).json({ ok:true });
      return;
    }
    if(action === 'resetca'){
      // Retire l'override d'un BP (=> plus aucun compte pour ce BP tant qu'il n'est pas re-importe)
      const bp = String((req.body && req.body.bp) || "").trim();
      const overrides = (await redis.get(K_CA_OVERRIDES)) || {};
      delete overrides[bp];
      await redis.set(K_CA_OVERRIDES, overrides);
      res.status(200).json({ ok:true, accounts: [] });
      return;
    }

    res.status(400).json({error:'Action inconnue'});
  }catch(err){
    res.status(500).json({error: 'Erreur store: ' + err.message});
  }
};

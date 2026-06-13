// ============ API : Stockage partagé (comptes, brouillons, file) via Upstash Redis ============
// Centralise comptes/brouillons/file pour que TOUS les postes voient les mêmes données.
// Les clés env UPSTASH_REDIS_REST_URL / _TOKEN sont injectées automatiquement par Vercel.

const { Redis } = require('@upstash/redis');
const { isLicenseActive } = require('./license.js');
const fs = require('fs');
const path = require('path');

// Default CHB (Échange) templates - shipped with the app
const CHB_DEFAULTS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'chb_templates.json'), 'utf8'));
const ECH_DEFAULTS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'echange_templates.json'), 'utf8'));

const redis = Redis.fromEnv();

// Keys in Redis
const K_USERS = "ivan:users";
const K_DRAFTS = "ivan:drafts";
const K_QUEUE = "ivan:queue";
const K_CHB = "ivan:chb_templates";
const K_ECHT = "ivan:echange_templates";  // manager-corrected échange templates

// Default manager account (guaranteed to always exist)
const DEFAULT_USER = { user:"ivan", pass:"ivan2026", role:"manager", email:"ivan.assani@maersk.com", name:"Ivan ASSANI" };

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
      if(found){ res.status(200).json({ ok:true, user:{user:found.user, role:found.role, email:found.email||"", name:found.name||""} }); }
      else { res.status(200).json({ ok:false, error:"Nom d'utilisateur ou mot de passe incorrect" }); }
      return;
    }

    // ===== LIST USERS (manager) =====
    if(action === 'users'){
      const users = await getUsers();
      // never send passwords to the client
      res.status(200).json({ ok:true, users: users.map(function(u){ return {user:u.user, role:u.role}; }) });
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
      users.push({ user:u, pass:p, role:role, email:email, name:name });
      await redis.set(K_USERS, users);
      res.status(200).json({ ok:true, users: users.map(function(x){ return {user:x.user, role:x.role}; }) });
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

    res.status(400).json({error:'Action inconnue'});
  }catch(err){
    res.status(500).json({error: 'Erreur store: ' + err.message});
  }
};

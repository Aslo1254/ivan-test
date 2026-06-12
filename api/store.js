// ============ API : Stockage partagé (comptes, brouillons, file) via Upstash Redis ============
// Centralise comptes/brouillons/file pour que TOUS les postes voient les mêmes données.
// Les clés env UPSTASH_REDIS_REST_URL / _TOKEN sont injectées automatiquement par Vercel.

const { Redis } = require('@upstash/redis');
const { isLicenseActive } = require('./license.js');

const redis = Redis.fromEnv();

// Keys in Redis
const K_USERS = "ivan:users";
const K_DRAFTS = "ivan:drafts";
const K_QUEUE = "ivan:queue";

// Default manager account (guaranteed to always exist)
const DEFAULT_USER = { user:"ivan", pass:"ivan2026", role:"manager" };

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
      if(found){ res.status(200).json({ ok:true, user:{user:found.user, role:found.role} }); }
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
      if(!u || !p){ res.status(200).json({ ok:false, error:"Nom et mot de passe requis" }); return; }
      const users = await getUsers();
      if(users.some(function(x){ return x.user.toLowerCase()===u.toLowerCase(); })){
        res.status(200).json({ ok:false, error:"Ce nom d'utilisateur existe déjà" }); return;
      }
      users.push({ user:u, pass:p, role:role });
      await redis.set(K_USERS, users);
      res.status(200).json({ ok:true, users: users.map(function(x){ return {user:x.user, role:x.role}; }) });
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

    res.status(400).json({error:'Action inconnue'});
  }catch(err){
    res.status(500).json({error: 'Erreur store: ' + err.message});
  }
};

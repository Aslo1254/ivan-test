// ============ API CACHÉE : Vérification de licence (kill switch) ============
// La vérification se fait côté serveur. Si tu mets la licence sur "inactive",
// le serveur refuse de répondre aux autres API → l'app entière se bloque,
// et le client ne peut PAS contourner en modifiant son navigateur.

const LICENSE_GIST = "https://gist.githubusercontent.com/Aslo1254/b5c2771e603ff33e6413b360e39a476e/raw/license.json";

// Shared helper other APIs can call
async function isLicenseActive(){
  try{
    const r = await fetch(LICENSE_GIST + "?t=" + Date.now(), { cache:"no-store" });
    if(!r.ok) return false;
    const lic = await r.json();
    return lic && String(lic.status).toLowerCase() === "active";
  }catch(e){
    return false;  // No access = blocked (no bypass)
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if(req.method === 'OPTIONS'){ res.status(200).end(); return; }
  const active = await isLicenseActive();
  res.status(200).json({ active: active });
};

module.exports.isLicenseActive = isLicenseActive;

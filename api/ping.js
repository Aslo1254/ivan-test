// Serverless function on Vercel. The client never sees this code.
// It just confirms the server is reachable and can talk to the browser.
module.exports = (req, res) => {
  // Allow the page to call this API
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.status(200).json({
    ok: true,
    message: "Le serveur Vercel repond correctement",
    time: new Date().toISOString(),
    // Simulate the kind of secret logic that would be hidden server-side
    secretComputation: 11000 * 2  // e.g. a rate calculation done on the server
  });
};

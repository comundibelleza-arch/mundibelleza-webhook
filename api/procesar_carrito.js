module.exports = async function handler(req, res) {

  console.log("HEADERS:");
  console.log(req.headers);

  console.log("BODY:");
  console.log(JSON.stringify(req.body, null, 2));

  return res.status(200).json({
    ok: true
  });

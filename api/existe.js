export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { chat_id } = req.query;
  if (!chat_id) return res.status(400).json({ error: 'Falta chat_id' });

  try {
    const appsScriptUrl = process.env.APPS_SCRIPT_URL;
    const url = `${appsScriptUrl}?chat_id=${encodeURIComponent(chat_id)}`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

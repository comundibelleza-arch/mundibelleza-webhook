export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Acepta messageId (v2) o chat_id (v1) para compatibilidad
  const messageId = req.query.messageId || req.query.chat_id;
  if (!messageId) return res.status(400).json({ error: 'Falta messageId' });

  try {
    const appsScriptUrl = process.env.APPS_SCRIPT_URL;
    const url = `${appsScriptUrl}?messageId=${encodeURIComponent(messageId)}`;
    const response = await fetch(url);
    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    const body = req.body;

    // Ping de prueba
    if (body?.test === true) {
      return res.status(200).json({ ok: true, message: 'Conexión exitosa' });
    }

    // Validar campos mínimos
    if (!body?.leadId || !Array.isArray(body?.products) || body.products.length === 0) {
      return res.status(400).json({ error: 'Payload inválido', received: body });
    }

    const payload = {
      lead_id:   body.leadId,
      chat_id:   body.messageId ?? body.chat_id ?? '',
      cliente:   body.cliente  ?? '',
      telefono:  body.telefono ?? '',
      productos: body.products.map(p => ({
        sku:      String(p.sku      ?? ''),
        cantidad: p.quantity ?? 1,
        precio:   p.price    ?? 0,
        moneda:   p.currency ?? 'COP',
      }))
    };

    const appsScriptUrl = process.env.APPS_SCRIPT_URL;
    if (!appsScriptUrl) {
      return res.status(500).json({ error: 'APPS_SCRIPT_URL no configurada' });
    }

    const response = await fetch(appsScriptUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });

    const text = await response.text();
    if (text === 'OK') {
      return res.status(200).json({ ok: true, leadId: body.leadId });
    } else {
      return res.status(500).json({ error: 'Apps Script error', detail: text });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

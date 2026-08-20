/**
 * api/extraer_campaña_kommo_whatsapp.js
 *
 * Endpoint NUEVO e independiente, solo para probar si el webhook nativo
 * de Kommo (evento "Mensaje agregado") ya trae el objeto `referral`
 * del anuncio de Meta, sin depender de la extensión ni de que alguien
 * abra la conversación manualmente.
 *
 * No toca ni interfiere con webhook-carrito.js.
 *
 * Requiere la misma variable de entorno en Vercel:
 *  - KOMMO_API_TOKEN
 */

const KOMMO_SUBDOMAIN = 'comundibelleza';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    const body = req.body;
    const messages = body?.message?.add;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(200).json({ ok: true, skipped: 'sin mensajes en el payload' });
    }

    const results = [];

    for (const msg of messages) {
      const leadId = msg?.entity_type === 'lead' ? msg?.entity_id : null;
      if (!leadId) continue;

      const debugTexto = '🔍 DEBUG referral payload:\n' + JSON.stringify(msg, null, 2).slice(0, 4000);
      const result = await enviarNotaInterna(leadId, debugTexto);
      results.push({ leadId, notaEnviada: result.ok });
    }

    return res.status(200).json({ ok: true, procesados: results });
  } catch (err) {
    console.error('Error en extraer_campaña_kommo_whatsapp:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function enviarNotaInterna(leadId, mensaje) {
  const token = process.env.KOMMO_API_TOKEN;
  if (!token) return { ok: false, error: 'KOMMO_API_TOKEN no configurada' };

  try {
    const response = await fetch(
      `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/leads/${leadId}/notes`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([{ note_type: 'common', params: { text: mensaje } }]),
      }
    );
    if (!response.ok) {
      const errText = await response.text();
      return { ok: false, error: `HTTP ${response.status}: ${errText}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

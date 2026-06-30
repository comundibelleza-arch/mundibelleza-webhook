/**
 * api/webhook-carrito.js
 *
 * Recibe el webhook NATIVO de Kommo (evento "Mensaje agregado"),
 * configurado directamente en Configuración → Integraciones → Webhooks.
 * NO requiere Salesbot.
 *
 * Filtra por el texto del mensaje: solo si contiene "🛒 Sent cart"
 * envía una nota interna inmediata avisando al equipo.
 *
 * El agente ve la nota → abre la conversación manualmente →
 * la extensión capturadora (existente, sin tocar) hace el resto.
 *
 * Requiere variable de entorno en Vercel:
 *  - KOMMO_API_TOKEN
 *
 * Formato del webhook nativo de Kommo (form-urlencoded, Vercel lo parsea
 * automáticamente a body.message.add[0]):
 * {
 *   "message": {
 *     "add": [{
 *       "id": "...",
 *       "chat_id": "...",
 *       "text": "🛒 Sent cart",
 *       "entity_id": "25780788",
 *       "entity_type": "lead",
 *       ...
 *     }]
 *   }
 * }
 */

const KOMMO_SUBDOMAIN = 'comundibelleza';
const NOTA_TEXTO = '🛒 Llegó un carrito insumos uñas';
const CART_TEXT_MARKER = '🛒 Sent cart';

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
      const text   = msg?.text || '';
      const leadId = msg?.entity_type === 'lead' ? msg?.entity_id : null;

      // Filtro clave: solo actuar si el mensaje es el aviso de carrito de WhatsApp
      if (!leadId || !text.includes(CART_TEXT_MARKER)) {
        continue;
      }

      const notaResult = await enviarNotaInterna(leadId, NOTA_TEXTO);
      if (!notaResult.ok) {
        console.error('No se pudo enviar nota interna:', notaResult.error);
      }
      results.push({ leadId, notaEnviada: notaResult.ok });
    }

    return res.status(200).json({ ok: true, procesados: results });
  } catch (err) {
    console.error('Error en webhook-carrito:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * Envía una nota interna a un lead en Kommo usando la API v4.
 * @param {string|number} leadId
 * @param {string} mensaje
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function enviarNotaInterna(leadId, mensaje) {
  const token = process.env.KOMMO_API_TOKEN;
  if (!token) {
    return { ok: false, error: 'KOMMO_API_TOKEN no configurada' };
  }

  try {
    const response = await fetch(
      `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/leads/${leadId}/notes`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([
          {
            note_type: 'common',
            params: { text: mensaje },
          },
        ]),
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

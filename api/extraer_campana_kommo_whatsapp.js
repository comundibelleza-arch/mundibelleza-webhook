/**
 * api/extraer_campana_kommo_whatsapp.js
 *
 * VERSIÓN DE DIAGNÓSTICO: imprime el body crudo tal cual llega,
 * sin ninguna suposición sobre su forma, para confirmar la
 * estructura real que manda el webhook de Kommo/amoCRM.
 *
 * Requiere en Vercel:
 *  - KOMMO_API_TOKEN
 */

const KOMMO_SUBDOMAIN = 'comundibelleza';
const CAMPO_CAMPANA_ID = 1289174;      // field_id del campo "Campaña"
const CAMPANA_1_ENUM_ID = 935786;      // enum_id de "Campaña 1" (placeholder de prueba)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  // --- DEBUG: imprimir el body crudo tal cual llega ---
  console.log('BODY CRUDO:', JSON.stringify(req.body));
  console.log('CONTENT-TYPE:', req.headers['content-type']);
  // --- fin del bloque de debug ---

  try {
    const body = req.body;
    const messages = body?.message?.add;

    if (!Array.isArray(messages) || messages.length === 0) {
      console.log('SKIP: no se encontró body.message.add como arreglo válido');
      return res.status(200).json({ ok: true, skipped: 'sin mensajes en el payload' });
    }

    const results = [];

    for (const msg of messages) {
      const leadId = msg?.entity_type === 'lead' ? msg?.entity_id : null;
      if (!leadId) {
        console.log('SKIP mensaje sin leadId:', JSON.stringify(msg));
        continue;
      }

      const referral = buscarReferral(msg);

      if (referral) {
        const debugTexto = '🔍 REFERRAL encontrado:\n' + JSON.stringify(referral, null, 2).slice(0, 3000);
        await enviarNotaInterna(leadId, debugTexto);

        const patchResult = await llenarCampoCampana(leadId, CAMPANA_1_ENUM_ID);
        results.push({ leadId, referralEncontrado: true, campoLlenado: patchResult.ok });
      } else {
        const debugTexto = '🔍 Sin referral. Payload completo:\n' + JSON.stringify(msg, null, 2).slice(0, 3000);
        await enviarNotaInterna(leadId, debugTexto);
        results.push({ leadId, referralEncontrado: false });
      }
    }

    return res.status(200).json({ ok: true, procesados: results });
  } catch (err) {
    console.log('ERROR:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * Busca recursivamente una clave "referral" en cualquier parte del objeto.
 */
function buscarReferral(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  if (obj.referral) return obj.referral;
  for (const key of Object.keys(obj)) {
    const found = buscarReferral(obj[key], depth + 1);
    if (found) return found;
  }
  return null;
}

async function enviarNotaInterna(leadId, mensaje) {
  const token = process.env.KOMMO_API_TOKEN;
  if (!token) return { ok: false, error: 'KOMMO_API_TOKEN no configurada' };
  try {
    const response = await fetch(
      `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/leads/${leadId}/notes`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ note_type: 'common', params: { text: mensaje } }]),
      }
    );
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function llenarCampoCampana(leadId, enumId) {
  const token = process.env.KOMMO_API_TOKEN;
  if (!token) return { ok: false, error: 'KOMMO_API_TOKEN no configurada' };
  try {
    const response = await fetch(
      `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/leads/${leadId}`,
      {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          custom_fields_values: [
            { field_id: CAMPO_CAMPANA_ID, values: [{ enum_id: enumId }] }
          ]
        }),
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

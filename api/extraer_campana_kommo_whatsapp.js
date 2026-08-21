/**
 * api/extraer_campana_kommo_whatsapp.js
 *
 * Procesa dos tipos de evento del webhook nativo de Kommo:
 *  - unsorted[add]: lead entrante nuevo, trae el ad_id real del anuncio (ref)
 *  - message[add]: mensaje agregado (se mantiene por si acaso)
 *
 * Requiere en Vercel:
 *  - KOMMO_API_TOKEN
 */

const KOMMO_SUBDOMAIN = 'comundibelleza';
const CAMPO_CAMPANA_ID = 1289174;
const CAMPANA_1_ENUM_ID = 935786;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  console.log('BODY CRUDO:', JSON.stringify(req.body));

  try {
    const body = req.body;
    const results = [];

    // --- Evento: lead entrante nuevo (trae el ad_id) ---
    const unsortedAdd = body?.unsorted?.add;
    if (Array.isArray(unsortedAdd)) {
      for (const item of unsortedAdd) {
        const leadId = item?.lead_id;
        if (!leadId) continue;

        const refString = item?.data?.contacts?.[0]?.profiles?.waba?.profile_data?.ref || '';
        const match = refString.match(/^ad:(\d+):/);
        const adId = match ? match[1] : null;
        const texto = item?.source_data?.data?.[0]?.text || '(sin texto)';

        const notaTexto = adId
          ? `📌 AD_ID: ${adId}\nMensaje: ${texto}`
          : `⚠️ Sin ad_id en ref.\nref crudo: ${refString}\nMensaje: ${texto}`;

        await enviarNotaInterna(leadId, notaTexto);
        results.push({ leadId, evento: 'unsorted.add', adId });
      }
    }

    // --- Evento: mensaje agregado (se mantiene la lógica anterior) ---
    const messages = body?.message?.add;
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        const leadId = msg?.entity_type === 'lead' ? msg?.entity_id : null;
        if (!leadId) continue;
        const referral = buscarReferral(msg);
        if (referral) {
          const debugTexto = '🔍 REFERRAL (message.add):\n' + JSON.stringify(referral, null, 2).slice(0, 2000);
          await enviarNotaInterna(leadId, debugTexto);
        }
        results.push({ leadId, evento: 'message.add', referralEncontrado: !!referral });
      }
    }

    if (results.length === 0) {
      return res.status(200).json({ ok: true, skipped: 'sin eventos reconocidos' });
    }

    return res.status(200).json({ ok: true, procesados: results });
  } catch (err) {
    console.log('ERROR:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

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

const KOMMO_SUBDOMAIN = 'comundibelleza';
const CAMPO_CAMPANA_ID = 1289174;
const CAMPANA_ENUM_BASE = 935786; // enum_id de "Campaña 1"
const CAMPANA_ENUM_STEP = 2;      // cada opción siguiente suma 2
const CAMPANA_MAX = 50;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  console.log('BODY CRUDO:', JSON.stringify(req.body));

  try {
    const body = desanidar(req.body);
    console.log('BODY DESANIDADO:', JSON.stringify(body));
    const results = [];

    // Único evento que nos interesa: lead nuevo entrante (trae el ad_id)
    const unsortedAdd = body?.unsorted?.add;
    if (Array.isArray(unsortedAdd)) {
      for (const item of unsortedAdd) {
        const leadId = item?.lead_id;
        if (!leadId) continue;

        const refString = item?.data?.contacts?.[0]?.profiles?.waba?.profile_data?.ref || '';
        const match = refString.match(/^ad:(\d+):/);
        const adId = match ? match[1] : null;

        if (!adId) {
          results.push({ leadId, evento: 'unsorted.add', adId: null, skip: 'sin ad_id' });
          continue;
        }

        const numeroCampana = await buscarCampanaPorAdId(adId);

        if (numeroCampana) {
          const enumId = CAMPANA_ENUM_BASE + (numeroCampana - 1) * CAMPANA_ENUM_STEP;
          await asignarCampoCampana(leadId, enumId);
          await enviarNotaInterna(
            leadId,
            `✅ Campaña asignada automáticamente: Campaña ${numeroCampana}\nad_id: ${adId}`
          );
          results.push({ leadId, evento: 'unsorted.add', adId, numeroCampana, ok: true });
        } else {
          await enviarNotaInterna(
            leadId,
            `⚠️ ad_id ${adId} no encontrado en la hoja de mapeo.\nAgrégalo a la hoja de cálculo para que se asigne automáticamente la próxima vez.`
          );
          results.push({ leadId, evento: 'unsorted.add', adId, numeroCampana: null, ok: false });
        }
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

/**
 * Kommo manda el body como application/x-www-form-urlencoded con claves
 * "planas" al estilo PHP: "unsorted[add][0][lead_id]": "26151642".
 * El parser por defecto de Vercel NO las anida automáticamente.
 * Esta función reconstruye la estructura anidada real (objetos y arrays)
 * a partir de esas claves.
 */
function desanidar(flat) {
  const resultado = {};
  if (!flat || typeof flat !== 'object') return resultado;

  for (const [claveFlat, valor] of Object.entries(flat)) {
    const partes = claveFlat.match(/[^\[\]]+/g);
    if (!partes) continue;

    let nodo = resultado;
    for (let i = 0; i < partes.length; i++) {
      const parte = partes[i];
      const esUltima = i === partes.length - 1;

      if (esUltima) {
        nodo[parte] = valor;
      } else {
        const siguienteEsIndice = /^\d+$/.test(partes[i + 1]);
        if (nodo[parte] == null) nodo[parte] = siguienteEsIndice ? [] : {};
        nodo = nodo[parte];
      }
    }
  }
  return resultado;
}

/**
 * Busca el ad_id en la hoja de cálculo publicada como CSV y devuelve
 * el número de campaña (1-50) si lo encuentra, o null si no está mapeado.
 */
async function buscarCampanaPorAdId(adId) {
  const sheetId = process.env.GOOGLE_SHEET_CAPTURA_ANUNCIO_ID;
  const gid = process.env.GOOGLE_SHEET_CAPTURA_ANUNCIO_GID || '0';
  if (!sheetId) return null;

  try {
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const csv = await response.text();
    const lineas = csv.split('\n').map((l) => l.trim()).filter(Boolean);

    for (const linea of lineas) {
      const partes = linea.split(',').map((p) => p.trim().replace(/^"|"$/g, ''));
      const [filaAdId, filaCampana] = partes;
      if (filaAdId === adId) {
        const numero = parseInt(filaCampana, 10);
        if (numero >= 1 && numero <= CAMPANA_MAX) return numero;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function asignarCampoCampana(leadId, enumId) {
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
            { field_id: CAMPO_CAMPANA_ID, values: [{ enum_id: enumId }] },
          ],
        }),
      }
    );
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
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

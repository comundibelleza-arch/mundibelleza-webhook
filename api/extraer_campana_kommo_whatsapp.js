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
          const patchResult = await asignarCampoCampana(leadId, enumId);

          // QUITADO (21-ago-2026): antes aquí se llamaba a enviarNotaInterna()
          // para dejar un aviso escrito en el lead. Esa nota estaba
          // reactivando el paso nativo "Pausa: Hasta recibir mensaje" del
          // Salesbot de agente-ventas-blackhair.js, que la tomaba como si
          // fuera actividad nueva del cliente: el bot de ventas se disparaba
          // sin que el cliente hubiera escrito nada, con mensaje vacío, y
          // por eso respondía "no puedo escuchar audios ni ver archivos"
          // sin que existiera ningún audio/archivo real. La lógica de
          // detectar la campaña y guardar el campo sigue exactamente igual;
          // solo se quitó el aviso dentro del lead. Se deja igual logueado
          // por consola para poder revisarlo en Vercel si hace falta.
          if (!patchResult.ok) {
            console.error(
              `Campaña ${numeroCampana} detectada para lead ${leadId} (ad_id ${adId}) pero falló al guardar el campo:`,
              patchResult.error
            );
          } else {
            console.log(
              `Campaña ${numeroCampana} asignada automáticamente al lead ${leadId} (ad_id ${adId}, enum_id ${enumId}).`
            );
          }

          results.push({
            leadId,
            evento: 'unsorted.add',
            adId,
            numeroCampana,
            enumId,
            patchOk: patchResult.ok,
            patchError: patchResult.error || null,
          });
        } else {
          // QUITADO (21-ago-2026): mismo motivo que arriba — ya no se manda
          // la nota de "ad_id no encontrado en la hoja de mapeo", solo se
          // deja logueado por consola.
          console.log(`ad_id ${adId} no encontrado en la hoja de mapeo para lead ${leadId}.`);
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
 * Arma el texto de la nota interna con formato consistente, mostrando
 * siempre el ad_id y el enum_id (o "N/A" si no se identificó campaña),
 * para poder comparar contra la hoja de mapeo aunque no se haya asignado nada.
 */
function construirNota({ encabezado, adId, enumId, error }) {
  let texto = `${encabezado}\nad_id: ${adId}\nenum_id: ${enumId ?? 'N/A'}`;
  if (error) texto += `\nError: ${error}`;
  return texto;
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
  const token = process.env.KOMMO_TOKEN;
  if (!token) return { ok: false, error: 'KOMMO_TOKEN no configurada' };
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
    if (!response.ok) {
      const detalle = await response.text().catch(() => '');
      return { ok: false, error: `HTTP ${response.status}: ${detalle.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// NOTA (21-ago-2026): ya no se llama desde el flujo principal (ver el
// comentario donde antes se usaba, más arriba) porque esa nota estaba
// disparando por error al bot de ventas de agente-ventas-blackhair.js. Se
// deja la función definida por si en el futuro se necesita mandar avisos
// por otro canal (Slack, email) en vez de una nota dentro del lead.
async function enviarNotaInterna(leadId, mensaje) {
  const token = process.env.KOMMO_TOKEN;
  if (!token) return { ok: false, error: 'KOMMO_TOKEN no configurada' };
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

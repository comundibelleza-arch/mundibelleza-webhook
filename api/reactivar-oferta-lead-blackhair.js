// api/reactivar-oferta-lead-blackhair.js
//
// SEGUNDO NIVEL de reactivación (22-ago-2026), a pedido del negocio. Se
// conecta a la salida de "tiempo agotado" de un SEGUNDO paso de Pausa,
// dibujado en el editor visual DESPUÉS del primer recordatorio (ver
// api/reactivar-lead-blackhair.js): si un lead ya vio los 3 combos con
// precio, recibió el primer recordatorio ("¿cómo quieres hacer la
// compra?") y quedó marcado como "supercalificado", pero sigue sin
// comprar 6 horas MÁS (12 horas en total desde que dejó de contestar),
// este archivo le manda la oferta de rebaja: el Combo 3 (3 cajas) a
// $69.999 en vez de $99.999, como últimas unidades / selección limitada.
//
// ALCANCE A PROPÓSITO LIMITADO, igual que el primer nivel: solo actúa
// sobre un lead que (a) todavía no tiene combo elegido, (b) no está ya con
// un asesor humano, y (c) SÍ está marcado como "supercalificado" (lo pone
// api/reactivar-lead-blackhair.js). Si falta la marca —por ejemplo, porque
// CAMPO_SUPERCALIFICADO_ID todavía no se configuró en
// agenteventasblackhair.js, o porque este webhook se disparó sin pasar
// antes por el primer nivel— no manda la oferta: mejor omitir que ofrecer
// un precio especial a quien no debía verlo.
//
// DECISIÓN (22-ago-2026): al mandar esta oferta, el lead también se
// escala a un asesor humano (fase="asesor_humano", igual que cuando el
// cliente elige un combo normal) y se deja una nota interna. Se tomó este
// default porque es un precio fuera de catálogo (excepción, no el precio
// de lista) — conviene que una persona confirme el pedido si el cliente
// acepta, en vez de que el bot intente cerrarlo solo. El negocio no tuvo
// preferencia específica sobre esto quedando así de momento: si prefieres
// que el bot SIGA conversando después de mandar la oferta (sin escalar
// todavía), avísame y quito esas dos líneas.
//
// Requiere las MISMAS variables de entorno que agenteventasblackhair.js
// (KOMMO_TOKEN, y opcionalmente UPSTASH_REDIS_REST_URL/TOKEN).

const {
  leerEstadoDelLead,
  avisarAKommoQueContinue,
  actualizarLeadEnKommo,
  formatoPrecio,
  COMBOS,
  KOMMO_SUBDOMAIN,
  KOMMO_TOKEN,
} = require("./agenteventasblackhair");

// Precio de excepción para esta oferta puntual — NO toca COMBOS[3].precio
// (el precio de catálogo normal sigue siendo $99.999 en todo el resto del
// bot). Si el negocio cambia el número de la promo, solo hay que editar
// esta constante.
const PRECIO_OFERTA_LIMITADA = 69999;

function mensajeDeOferta() {
  return (
    `¿Sigues ahí? 👋 Como agradecimiento por tu interés, te dejamos las ` +
    `últimas unidades del ${COMBOS[3].nombre} en ${formatoPrecio(PRECIO_OFERTA_LIMITADA)} ` +
    `(antes ${formatoPrecio(COMBOS[3].precio)}) — las estamos rematando y fue una ` +
    `selección para pocos clientes. ¿La aprovechas? 🔥`
  );
}

// Nota interna para el asesor humano: a diferencia de
// agregarNotaDeEscaladoHumano() (en agenteventasblackhair.js), esta nota es
// específica de esta oferta puntual — deja clarísimo que el precio que se
// le ofreció al cliente es una EXCEPCIÓN fuera de catálogo, para que quien
// tome la conversación no se confunda con el precio de lista.
async function agregarNotaDeOfertaEnviada(leadId) {
  const texto =
    `🔥 Oferta de rebaja enviada automáticamente — requiere seguimiento humano\n` +
    `Se le ofreció el ${COMBOS[3].nombre} en ${formatoPrecio(PRECIO_OFERTA_LIMITADA)} ` +
    `(precio de excepción, NO el de catálogo — el de catálogo sigue siendo ` +
    `${formatoPrecio(COMBOS[3].precio)}).\n` +
    `El bot ya NO va a seguir esta conversación. Si el cliente acepta, un ` +
    `asesor debe confirmar el pedido, recolectar sus datos y respetar este ` +
    `precio especial al cerrarlo.`;
  const resp = await fetch(
    `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/leads/${leadId}/notes`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KOMMO_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([{ note_type: "common", params: { text: texto } }]),
    }
  );
  if (!resp.ok) {
    console.error("Error agregando nota de oferta enviada en Kommo:", resp.status, await resp.text());
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido, usa POST" });
  }

  let leadId = null;
  let returnUrl = null;
  try {
    leadId =
      (req.body && (req.body.lead_id || req.body["data[lead_id]"])) || null;
    if (!leadId && req.body && req.body.token) {
      try {
        const payloadBase64 = req.body.token.split(".")[1];
        const payload = JSON.parse(Buffer.from(payloadBase64, "base64").toString("utf8"));
        leadId = payload.entity_id || null;
      } catch (e) {
        console.error("No se pudo decodificar el token JWT:", e.message);
      }
    }
    returnUrl = req.body && req.body.return_url;

    console.log("BODY CRUDO (reactivar oferta lead blackhair):", JSON.stringify(req.body));

    if (!leadId) {
      console.error("No se recibió lead_id en reactivar-oferta-lead-blackhair. Body:", JSON.stringify(req.body));
      return res.status(400).json({ error: "No se recibió lead_id", body_recibido: req.body });
    }

    const estado = await leerEstadoDelLead(leadId);

    // No manda la oferta si: ya está con un asesor humano, ya eligió
    // combo, o todavía no pasó por el primer nivel de reactivación (no
    // está marcado como "supercalificado" — ver reactivar-lead-blackhair.js).
    if (estado.fase === "asesor_humano" || estado.combo || !estado.superCalificado) {
      console.log(
        `Lead ${leadId}: no se manda la oferta (fase="${estado.fase}", combo=${estado.combo}, supercalificado=${estado.superCalificado}).`
      );
      return res.status(200).json({
        ok: true,
        accion: "omitido",
        mensaje: null,
        nota: "Lead ya escalado, ya con combo, o todavía no marcado como supercalificado; no se manda la oferta.",
      });
    }

    const mensaje = mensajeDeOferta();

    // Escala a asesor humano y deja la nota ANTES de avisarle a Kommo que
    // continúe — así, si el cliente contesta casi de inmediato, ya
    // encuentra fase="asesor_humano" y el bot principal se queda callado
    // (ver el bloque `estado.fase === "asesor_humano"` al inicio del
    // handler de agenteventasblackhair.js).
    estado.fase = "asesor_humano";
    await actualizarLeadEnKommo(leadId, estado, "reactivado");
    await agregarNotaDeOfertaEnviada(leadId);

    await avisarAKommoQueContinue(returnUrl, mensaje, "oferta_enviada");
    return res.status(200).json({ ok: true, accion: "oferta_enviada", mensaje });
  } catch (error) {
    console.error(`Error general en reactivar-oferta-lead-blackhair (lead ${leadId ?? "?"}):`, error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
};

// api/reactivar-lead-blackhair.js
//
// Webhook de Salesbot (widget_request) para REENGANCHAR leads del embudo
// de BlackHair Shampoo que dejaron de contestar. Se conecta a la salida de
// "tiempo agotado" (temporizador) del paso nativo "Pausa: Hasta recibir
// mensaje" que ya usa agenteventasblackhair.js — NO a la salida de
// "mensaje recibido" — así que, a diferencia de ese archivo, aquí NO llega
// ningún mensaje nuevo del cliente: lo único que pasó es que se cumplió el
// tiempo de espera (6 horas, configurado en el editor visual del Salesbot,
// no en este código).
//
// DISEÑO (22-ago-2026), a pedido del negocio: agenteventasblackhair.js se
// queda esperando la respuesta del cliente. Si pasan 6 horas sin que
// conteste, este archivo entra y le pregunta algo basado en las variables
// que el lead ya tiene llenas (en qué parte del embudo se quedó), para
// reactivar la conversación. Reutiliza los mismos textos/lógica que ya usa
// el agente principal (ver el Object.assign(module.exports, {...}) al
// final de agenteventasblackhair.js) — si cambias un mensaje allá, este
// archivo automáticamente usa la versión nueva, sin tener que tocar dos
// archivos.
//
// ESTE ES EL PRIMER NIVEL de reactivación (a las 6 horas). Para el lead que
// ya vio los 3 combos con precio pero no eligió ninguno, además de mandarle
// este mensaje, el handler de abajo lo marca como "supercalificado" en
// Kommo. Si ESE mismo lead sigue sin comprar 6 horas MÁS (12 horas en
// total desde que dejó de contestar), es api/reactivar-oferta-lead-
// blackhair.js — un segundo widget/webhook separado, conectado a un
// SEGUNDO paso de Pausa dibujado después de este en el editor visual del
// Salesbot — quien le manda la oferta de rebaja. Ver ese archivo para el
// detalle completo.
//
// ALCANCE A PROPÓSITO LIMITADO: solo reactiva leads que TODAVÍA están en
// el embudo (fase null / "objetivo" / "oferta", o ya en "ventas" pero sin
// combo elegido todavía). Un lead que ya eligió combo pasa a
// fase="asesor_humano" en agenteventasblackhair.js, y ESE agente deja de
// intervenir en la conversación — este agente de reactivación respeta la
// misma regla y NO le escribe nada a esos leads. El seguimiento de un lead
// ya escalado es responsabilidad del asesor humano, no del bot; si el bot
// también le insiste, hay riesgo de que ambos le escriban al cliente a la
// vez y se vea desordenado.
//
// Requiere en Vercel las MISMAS variables que agenteventasblackhair.js
// (KOMMO_TOKEN, y opcionalmente UPSTASH_REDIS_REST_URL/TOKEN si quieres
// que también respete la caché de estado — se hereda automáticamente
// porque leerEstadoDelLead() se reutiliza tal cual de ese archivo).

const {
  leerEstadoDelLead,
  avisarAKommoQueContinue,
  actualizarLeadEnKommo,
  MENSAJE_PREGUNTA_OBJETIVO,
  MENSAJE_INVITACION_OFERTAS,
} = require("./agenteventasblackhair");

// Nudge de reactivación para cuando el cliente todavía no contestó la
// primera pregunta nativa de Kommo ("¿cuántas canas tienes?", Paso 0 —
// vive fuera de este código, dibujada en el editor visual, así que no hay
// ninguna constante ya escrita para reutilizar acá como sí pasa con las
// demás fases).
const MENSAJE_REACTIVACION_CANAS =
  "¿Sigues ahí? 👋 Te preguntaba cuántas canas tienes para recomendarte " +
  "el combo ideal: ¿pocas (1), bastantes (2) o muchas (3)?";

// ACTUALIZADO (22-ago-2026): mensaje específico para el lead "calificado" —
// fase === "ventas" && sin combo significa que YA vio el saludo con los
// tres precios (MENSAJE_BIENVENIDA) pero no eligió ninguno todavía. No
// hace falta un campo nuevo en Kommo para DETECTAR esto: esa combinación de
// fase+combo YA es la señal. A pedido del negocio, este es el PRIMER
// recordatorio (a las 6 horas) de dos: en vez de repetir el saludo con los
// tres precios, le pregunta directamente cómo quiere hacer la compra. Este
// mismo lead, si sigue sin comprar 6 horas después de ESTE mensaje, es
// quien ve la oferta de rebaja (ver api/reactivar-oferta-lead-blackhair.js)
// — por eso, además del mensaje, el handler de abajo también marca al lead
// como "supercalificado" en Kommo justo cuando se manda este mensaje.
const MENSAJE_REACTIVACION_CALIFICADO =
  "¿Sigues ahí? 👋 ¿Cómo quieres hacer la compra? Cuéntame y te ayudo a " +
  "cerrarla ahora mismo 😊";

function mensajeDeReactivacionPara(estado) {
  if (!estado.fase) return MENSAJE_REACTIVACION_CANAS;
  if (estado.fase === "objetivo") return `¿Sigues ahí? 👋 ${MENSAJE_PREGUNTA_OBJETIVO}`;
  if (estado.fase === "oferta") return `¿Sigues ahí? 👋 ${MENSAJE_INVITACION_OFERTAS}`;
  if (estado.fase === "ventas" && !estado.combo) return MENSAJE_REACTIVACION_CALIFICADO;
  // Cualquier otro caso (fase === "asesor_humano", o combo ya elegido) no
  // debería llegar aquí — se filtra antes, en el handler, pero por si
  // acaso no se manda nada raro.
  return null;
}

// Es justo el mismo caso que dispara MENSAJE_REACTIVACION_CALIFICADO
// arriba: separado en su propia función para no repetir la condición en el
// handler y para dejar clarísimo por qué se marca "supercalificado" acá y
// no en otro punto del código.
function esLeadCalificadoSinComprar(estado) {
  return estado.fase === "ventas" && !estado.combo;
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

    console.log("BODY CRUDO (reactivar lead blackhair):", JSON.stringify(req.body));

    if (!leadId) {
      console.error("No se recibió lead_id en reactivar-lead-blackhair. Body:", JSON.stringify(req.body));
      return res.status(400).json({ error: "No se recibió lead_id", body_recibido: req.body });
    }

    const estado = await leerEstadoDelLead(leadId);

    // Regla principal de este archivo: si ya se escaló a un asesor humano
    // (o, por cualquier motivo legado, el lead ya tiene combo elegido sin
    // haber pasado por esa fase), el bot NO reactiva nada. El seguimiento
    // ahí es del asesor, no del bot.
    if (estado.fase === "asesor_humano" || estado.combo) {
      console.log(`Lead ${leadId}: no se reactiva (ya está con asesor humano o ya tiene combo elegido).`);
      return res.status(200).json({
        ok: true,
        accion: "omitido",
        mensaje: null,
        nota: "Lead ya escalado a asesor humano o con combo elegido; no se reactiva.",
      });
    }

    const mensaje = mensajeDeReactivacionPara(estado);
    if (!mensaje) {
      console.log(`Lead ${leadId}: no había ningún mensaje de reactivación aplicable para fase="${estado.fase}".`);
      return res.status(200).json({ ok: true, accion: "omitido", mensaje: null });
    }

    // AGREGADO (22-ago-2026): si este es el recordatorio del lead
    // calificado-sin-comprar, guarda la marca "supercalificado" en Kommo
    // ANTES de avisarle a Kommo que continúe — así, si el cliente sigue sin
    // contestar y en 6 horas más se dispara
    // api/reactivar-oferta-lead-blackhair.js, ese archivo ya encuentra la
    // marca puesta y sabe que le toca mostrar la oferta. Si
    // CAMPO_SUPERCALIFICADO_ID todavía no está configurado en
    // agenteventasblackhair.js, actualizarLeadEnKommo simplemente no
    // escribe ese campo (falla abierto) y el resto sigue igual.
    if (esLeadCalificadoSinComprar(estado)) {
      estado.superCalificado = true;
      await actualizarLeadEnKommo(leadId, estado, "reactivado");
    }

    await avisarAKommoQueContinue(returnUrl, mensaje, "reactivado");
    return res.status(200).json({ ok: true, accion: "reactivado", mensaje });
  } catch (error) {
    console.error(`Error general en reactivar-lead-blackhair (lead ${leadId ?? "?"}):`, error);
    // Igual que en agenteventasblackhair.js: si alcanzamos a tener
    // return_url, no dejamos la petición completamente en silencio, pero
    // aquí NO hay un mensaje de disculpa que mandarle al cliente (no hubo
    // ningún mensaje suyo que "responder") — solo dejamos que Kommo sepa
    // que este intento de reactivación se omitió por un error.
    return res.status(500).json({ error: "Error interno del servidor" });
  }
};

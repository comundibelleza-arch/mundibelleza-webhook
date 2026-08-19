// api/agente-ventas-blackhair.js
//
// *** VERSIÓN DE PRUEBA — identifica el combo y responde algo fijo ***
//
// Pensada para la nueva arquitectura que estás probando: tú mandas el
// saludo con los combos por tu cuenta (sin este código), pones una pausa
// nativa "esperar mensaje", y cuando el lead responde, AHÍ se activa este
// widget. Su trabajo aquí es leer el mensaje real del cliente, detectar
// qué combo mencionó, guardarlo en el campo "Combo Blackhair" del lead en
// Kommo, y contestar "¡Genial! El Combo X es el mejor." No usa reglas de
// FAQ completas ni LLM — es solo para confirmar tres cosas a la vez:
//   1) ¿Ya llega el mensaje real del cliente en vez de vacío?
//   2) ¿Se guarda bien el campo "Combo" en el lead?
//   3) ¿Ya se entrega el "show" al WhatsApp del cliente, o seguimos
//      atascados por el motor marketingbot del bot?
//
// CÓMO USARLO: sube este archivo reemplazando temporalmente
// api/agente-ventas-blackhair.js (mismo endpoint, no hay que tocar la URL
// del widget). Cuando termines la prueba, vuelve a subir la versión
// completa.
const KOMMO_TOKEN = process.env.KOMMO_TOKEN;
const KOMMO_SUBDOMAIN = "comundibelleza";
const CAMPO_COMBO_ID = 1289164; // "Combo Blackhair"

const COMBOS = {
  1: "Combo 1 (1 caja, 10 sobres)",
  2: "Combo 2 (2 cajas, 20 sobres)",
  3: "Combo 3 (3 cajas, 30 sobres)",
};

function detectarCombo(texto) {
  const t = texto.toLowerCase();
  if (/\b(combo\s*3|3\s*caja|30\s*sobre)/.test(t)) return 3;
  if (/\b(combo\s*2|2\s*caja|20\s*sobre)/.test(t)) return 2;
  if (/\b(combo\s*1|1\s*caja|10\s*sobre|una\s*caja)/.test(t)) return 1;
  return null;
}

// Mismo partidor de mensajes que la versión completa, por si acaso: el
// límite de 80 caracteres de Kommo aplica igual aquí.
const MAX_SHOW_LEN = 75;
function partirEnTrozos(mensaje) {
  const lineas = mensaje.split("\n");
  const trozos = [];
  for (const linea of lineas) {
    if (!linea.trim()) continue;
    const palabras = linea.split(/\s+/).filter(Boolean);
    let actual = "";
    for (const palabra of palabras) {
      const candidato = actual ? `${actual} ${palabra}` : palabra;
      if (candidato.length > MAX_SHOW_LEN) {
        if (actual) trozos.push(actual);
        actual = palabra;
      } else {
        actual = candidato;
      }
    }
    if (actual) trozos.push(actual);
  }
  return trozos.length ? trozos : [""];
}

// Guarda el combo detectado en el campo personalizado del lead, igual que
// hace la versión completa (actualizarLeadEnKommo), pero solo con este
// campo — nada de nombre/dirección/ciudad/pipeline aquí.
async function guardarComboEnKommo(leadId, combo) {
  const resp = await fetch(
    `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/leads/${leadId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${KOMMO_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        custom_fields_values: [
          { field_id: CAMPO_COMBO_ID, values: [{ value: String(combo) }] },
        ],
      }),
    }
  );
  const texto = await resp.text();
  if (!resp.ok) {
    console.error("PRUEBA combo: error guardando combo en Kommo:", resp.status, texto);
  } else {
    console.log("PRUEBA combo: combo guardado en Kommo OK:", resp.status, texto);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido, usa POST" });
  }
  try {
    console.log("PRUEBA combo: body recibido =", JSON.stringify(req.body));

    const mensajeCliente =
      (req.body &&
        (req.body["data[message_text]"] ||
          req.body.message_text ||
          req.body.text ||
          (req.body.data && req.body.data.message_text))) ||
      "";

    let leadId =
      (req.body && (req.body.lead_id || (req.body.additional_data && req.body.additional_data.id))) ||
      null;
    if (!leadId && req.body && req.body.token) {
      try {
        const payloadBase64 = req.body.token.split(".")[1];
        const payload = JSON.parse(Buffer.from(payloadBase64, "base64").toString("utf8"));
        leadId = payload.entity_id || null;
      } catch (e) {
        console.error("PRUEBA combo: no se pudo decodificar el token JWT:", e.message);
      }
    }

    const combo = detectarCombo(mensajeCliente);
    const mensajeRespuesta = combo
      ? `¡Genial! El ${COMBOS[combo]} es el mejor.`
      : `No identifiqué el combo en: "${mensajeCliente}". ¿Cuál eliges: 1, 2 o 3?`;

    console.log(
      "PRUEBA combo: mensajeCliente =", JSON.stringify(mensajeCliente),
      "| leadId =", leadId,
      "| combo detectado =", combo
    );

    if (combo && leadId) {
      await guardarComboEnKommo(leadId, combo);
    } else if (combo && !leadId) {
      console.error("PRUEBA combo: se detectó combo pero no hay leadId, no se pudo guardar en Kommo.");
    }

    const returnUrl = req.body && req.body.return_url;
    if (!returnUrl) {
      console.error("PRUEBA combo: no llegó return_url en el body.");
      return res.status(200).json({ ok: true, accion: "seguir", mensaje: mensajeRespuesta });
    }

    const trozos = partirEnTrozos(mensajeRespuesta);
    const executeHandlers = trozos.map((trozo) => ({
      handler: "show",
      params: { type: "text", value: trozo },
    }));

    const body = {
      data: { mensaje: mensajeRespuesta, accion: "seguir" },
      execute_handlers: executeHandlers,
    };

    const resp = await fetch(returnUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${KOMMO_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
    const textoResp = await resp.text();

    if (!resp.ok) {
      console.error(`PRUEBA combo: return_url respondió con error (${resp.status}):`, textoResp);
    } else {
      console.log(`PRUEBA combo: return_url respondió OK (${resp.status}):`, textoResp);
    }

    return res.status(200).json({ ok: true, accion: "seguir", mensaje: mensajeRespuesta });
  } catch (error) {
    console.error("PRUEBA combo: error general:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
};

// api/agente-ventas-blackhair.js
//
// Webhook de Salesbot (widget_request) para el agente de ventas de la
// Tintura Líquida Negra / BlackHair Shampoo. Sigue el mismo patrón que
// extraer-datos.js y enviar_catalogo.js: lee el mensaje y el lead_id del
// body/token, decide qué responder, guarda lo que aprenda en los campos
// del lead, y le avisa a Kommo (return_url) que continúe el bot.
//
// Nomenclatura: cada línea de producto va a tener su propio archivo
// "agente-ventas-<producto>.js" (este es el de blackhair). Los campos,
// pipeline y precios de este archivo son específicos de este producto —
// no los reutilices tal cual para otro agente, cópialo como base y ajusta.
//
// Requiere en Vercel:
//  - ANTHROPIC_API_KEY  (ya la tienes)
//  - KOMMO_TOKEN        (el mismo que usan extraer-datos.js / enviar_catalogo.js)
//
// IMPORTANTE — falta confirmar en tu cuenta:
//  - STEP_ESPERAR_RESPUESTA abajo es un placeholder (copié el mismo "1"
//    que usas en tus otros scripts). Confírmalo en tu Salesbot: debe ser
//    el número del paso que "espera la siguiente respuesta libre del
//    cliente" y vuelve a llamar a este mismo webhook.
//
// CORREGIDO (18-ago-2026), a partir de logs reales de Vercel:
//  - Kommo rechaza con 400 "TooLong" cualquier execute_handlers.show cuyo
//    "value" pase de 80 caracteres. Antes se mandaba el mensaje completo
//    en un solo "show" y por eso NUNCA llegaba nada al cliente (ni el
//    saludo ni las respuestas). Ahora se parte en varios "show" de <=80
//    caracteres.
//  - El "accion" que este archivo generaba (seguir_conversando /
//    cerrar_pedido / escalar_humano) no coincidía con lo que el widget
//    de Kommo espera en sus condiciones (cerrado / escalado / seguir).
//    Se agrega un mapeo antes de responder.
//  - leerEstadoDelLead y llamarLLM hacían response.json() sin revisar si
//    la respuesta venía vacía o con error, lo que producía un 500
//    "Unexpected end of JSON input" si Kommo o Anthropic devolvían un
//    cuerpo vacío (p.ej. token vencido). Ahora se revisa resp.ok primero.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const KOMMO_TOKEN = process.env.KOMMO_TOKEN;
const KOMMO_SUBDOMAIN = "comundibelleza";
const STEP_ESPERAR_RESPUESTA = 1; // <-- confirma este número en tu Salesbot
// IDs de campos personalizados del lead (Configuración → Campos personalizados → Leads)
const CAMPO_COMBO_ID = 1289164; // "Combo Blackhair"
const CAMPO_NOMBRE_ID = 1288972; // ya existe ("Nombre cliente (IA)"), mismo que extraer-datos.js
const CAMPO_DIRECCION_ID = 1289162; // "Direccion"
const CAMPO_CIUDAD_ID = 1274145; // ya existe ("Cuidad" — así está escrito en la cuenta)
// No hay campo de teléfono: como es una conversación de WhatsApp, Kommo ya
// guarda el número en el contacto asociado al lead. No hace falta pedirlo
// ni guardarlo aparte.
// Pipeline "BlackHair Shampoo" y su etapa "Logrado con éxito" (el "ganado"
// estándar de Kommo, id 142, reutilizado en vez de crear una etapa nueva).
// Se usa solo como hito para reportes, no para decidir qué responde el bot.
const PIPELINE_ID = 14307443;
const STAGE_PEDIDO_CONFIRMADO_ID = 142;
const COMBOS = {
  1: { nombre: "Combo 1 (1 caja, 10 sobres)", precio: 59900 },
  2: { nombre: "Combo 2 (2 cajas, 20 sobres)", precio: 89999 },
  3: { nombre: "Combo 3 (3 cajas, 30 sobres)", precio: 99999 },
};
function formatoPrecio(n) {
  return "$" + n.toLocaleString("es-CO");
}
const MENSAJE_BIENVENIDA =
  "¡Hola! 😊 Gracias por escribirnos. Somos Mundibelleza y esta es nuestra " +
  "Tintura Líquida Negra en sobres, fácil de aplicar en 5 minutos y con " +
  "resultado natural. Tenemos estas opciones:\n\n" +
  `1️⃣ ${COMBOS[1].nombre}: ${formatoPrecio(COMBOS[1].precio)}\n` +
  `2️⃣ ${COMBOS[2].nombre}: ${formatoPrecio(COMBOS[2].precio)}\n` +
  `3️⃣ ${COMBOS[3].nombre}: ${formatoPrecio(COMBOS[3].precio)} — la más pedida 🔥\n\n` +
  "¿Cuál te interesa?";
// ---------------------------------------------------------------------------
// Kommo rechaza execute_handlers.show con más de 80 caracteres (validado
// contra logs reales: "This value is too long. It should have 80
// characters or less."). Partimos cualquier mensaje en varios trozos
// cortos, respetando saltos de línea y palabras completas, con margen de
// seguridad porque emojis pueden contar más de 1 unidad.
// ---------------------------------------------------------------------------
const MAX_SHOW_LEN = 75;
function partirEnTrozos(mensaje) {
  // Respeta los saltos de línea del mensaje original como cortes de burbuja
  // (así cada combo queda en su propia línea de WhatsApp en vez de partirse
  // a la mitad), y dentro de cada línea envuelve por palabra completa.
  const lineas = mensaje.split("\n");
  const trozos = [];
  for (const linea of lineas) {
    if (!linea.trim()) continue; // las líneas vacías eran solo espaciado
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
// ---------------------------------------------------------------------------
// Traduce el "accion" interno (seguir_conversando/cerrar_pedido/
// escalar_humano) a los códigos que el widget de Kommo espera en sus
// condiciones del paso 1 (cerrado/escalado/seguir). Antes se mandaba tal
// cual y por eso las salidas "Pedido cerrado" / "Escalar a humano" del
// bloque nunca se disparaban.
// ---------------------------------------------------------------------------
const MAPA_ACCION = {
  cerrar_pedido: "cerrado",
  escalar_humano: "escalado",
  seguir_conversando: "seguir",
};
function accionParaKommo(accion) {
  return MAPA_ACCION[accion] || "seguir";
}
// ---------------------------------------------------------------------------
// Capa de reglas: intenta resolver SIN llamar al modelo.
// ---------------------------------------------------------------------------
function detectarCombo(texto) {
  const t = texto.toLowerCase();
  if (/\b(combo\s*3|3\s*caja|30\s*sobre)/.test(t)) return 3;
  if (/\b(combo\s*2|2\s*caja|20\s*sobre)/.test(t)) return 2;
  if (/\b(combo\s*1|1\s*caja|10\s*sobre|una\s*caja)/.test(t)) return 1;
  return null;
}
const FAQ_REGLAS = [
  {
    patron: /(precio|cu[aá]nto\s*(cuesta|vale)|costo)/,
    respuesta: () =>
      `El Combo 1 vale ${formatoPrecio(COMBOS[1].precio)}, el Combo 2 ` +
      `${formatoPrecio(COMBOS[2].precio)} y el Combo 3 ${formatoPrecio(COMBOS[3].precio)} ` +
      `— el Combo 3 es el más conveniente por caja. ¿Cuál te interesa?`,
  },
  {
    patron: /(env[ií]o|entrega|demora|cu[aá]ndo\s*llega)/,
    respuesta: () =>
      "Llega entre 2 y 5 días hábiles según tu ciudad, con envío gratis a toda Colombia.",
  },
  {
    patron: /(pago|contraentrega|pagar|efectivo|tarjeta)/,
    respuesta: () =>
      "Pagas cuando el mensajero te lo entrega en la puerta de tu casa, no antes. No arriesgas nada 🙌",
  },
];
function capaDeReglas(mensaje, estado) {
  if (!estado.combo) {
    const combo = detectarCombo(mensaje);
    if (combo) {
      return {
        texto: `¡Buena elección! El ${COMBOS[combo].nombre} te queda en ${formatoPrecio(
          COMBOS[combo].precio
        )}. ¿Es para ti o para alguien más?`,
        accion: "seguir_conversando",
        datos: { combo },
      };
    }
    return null;
  }
  for (const regla of FAQ_REGLAS) {
    if (regla.patron.test(mensaje.toLowerCase())) {
      return { texto: regla.respuesta(), accion: "seguir_conversando", datos: {} };
    }
  }
  return null;
}
// ---------------------------------------------------------------------------
// Lee el estado actual del lead directo desde Kommo (esto reemplaza a
// Redis/memoria: los campos del lead SON el estado).
// ---------------------------------------------------------------------------
async function leerEstadoDelLead(leadId) {
  const resp = await fetch(
    `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/leads/${leadId}`,
    { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` } }
  );
  if (!resp.ok) {
    console.error("Error leyendo lead en Kommo:", resp.status, await resp.text());
    return { combo: null, nombre: null, direccion: null, ciudad: null };
  }
  const data = await resp.json();
  const campos = {};
  for (const f of data.custom_fields_values || []) {
    campos[f.field_id] = f.values?.[0]?.value ?? null;
  }
  return {
    combo: campos[CAMPO_COMBO_ID] ? Number(campos[CAMPO_COMBO_ID]) : null,
    nombre: campos[CAMPO_NOMBRE_ID] || null,
    direccion: campos[CAMPO_DIRECCION_ID] || null,
    ciudad: campos[CAMPO_CIUDAD_ID] || null,
  };
}
// ---------------------------------------------------------------------------
// Llamada al LLM — mismo modelo y estilo (fetch directo) que ya usas en
// extraer-datos.js. Solo entra si la capa de reglas no resolvió el turno.
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `Eres Sofía, asesora de ventas de Mundibelleza por WhatsApp.
Vendes la Tintura Líquida Negra en sobres (tinte capilar de aplicación rápida).
PRECIOS (nunca inventes otros, ya se los mostró un mensaje anterior):
- Combo 1 (10 sobres): $59.900 COP
- Combo 2 (20 sobres): $89.999 COP
- Combo 3 (30 sobres): $99.999 COP — recomendado
REGLAS DE FORMATO:
- Responde en máximo 2-3 frases, tono cercano y colombiano, sin markdown, máximo 1 emoji.
- Nunca inventes datos de envío, garantías o políticas fuera de: envío gratis a toda
  Colombia, pago contraentrega, entrega 2-5 días hábiles.
- No pidas el teléfono: ya es una conversación de WhatsApp, Kommo ya lo tiene.
- Si el cliente ya dio combo + nombre + dirección + ciudad, usa acción "cerrar_pedido".
- Si el cliente pide algo fuera de esto (queja, reembolso ya despachado, pregunta médica
  sobre alergias/piel), usa acción "escalar_humano" y no improvises respuesta médica.
Responde ÚNICAMENTE con este JSON, sin texto adicional antes o después, sin markdown, sin backticks:
{"mensaje": "...", "accion": "seguir_conversando|cerrar_pedido|escalar_humano",
 "datos_extraidos": {"nombre": null, "direccion": null, "ciudad": null, "combo": null}}`;
async function llamarLLM(estado, mensajeNuevo) {
  const resumenEstado =
    `Estado actual: combo=${estado.combo ?? "sin definir"}, nombre=${estado.nombre ?? "?"}, ` +
    `direccion=${estado.direccion ?? "?"}, ciudad=${estado.ciudad ?? "?"}.`;
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001", // mismo modelo que ya usas en extraer-datos.js
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: `${resumenEstado}\n\nMensaje del cliente: "${mensajeNuevo}"` },
      ],
    }),
  });
  if (!response.ok) {
    console.error("Error de la API de Claude:", response.status, await response.text());
    return {
      mensaje: "Perdón, ¿me lo repites? Tuve un problema técnico 🙏",
      accion: "seguir_conversando",
      datos_extraidos: {},
    };
  }
  const data = await response.json();
  let texto = data.content[0].text.trim();
  texto = texto.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(texto);
  } catch (e) {
    console.error("Claude no devolvió JSON válido:", texto);
    return {
      mensaje: "Perdón, ¿me lo repites? No te entendí bien 🙏",
      accion: "seguir_conversando",
      datos_extraidos: {},
    };
  }
}
// ---------------------------------------------------------------------------
// Escribe en Kommo: los campos que se sepan + (solo si accion=cerrar_pedido)
// mueve el pipeline como hito. Es una sola llamada PATCH, como confirmamos.
// ---------------------------------------------------------------------------
async function actualizarLeadEnKommo(leadId, estado, accion) {
  const campos = [];
  if (estado.combo) campos.push({ field_id: CAMPO_COMBO_ID, values: [{ value: String(estado.combo) }] });
  if (estado.nombre) campos.push({ field_id: CAMPO_NOMBRE_ID, values: [{ value: estado.nombre }] });
  if (estado.direccion) campos.push({ field_id: CAMPO_DIRECCION_ID, values: [{ value: estado.direccion }] });
  if (estado.ciudad) campos.push({ field_id: CAMPO_CIUDAD_ID, values: [{ value: estado.ciudad }] });
  const body = { custom_fields_values: campos };
  if (accion === "cerrar_pedido" && STAGE_PEDIDO_CONFIRMADO_ID) {
    // Se manda pipeline_id junto con status_id: aunque 142 ("Logrado con
    // éxito") se repite en todos los pipelines de la cuenta, hay que decirle
    // a Kommo en cuál pipeline específico queremos ese estado.
    body.pipeline_id = PIPELINE_ID;
    body.status_id = STAGE_PEDIDO_CONFIRMADO_ID;
  }
  const resp = await fetch(
    `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/leads/${leadId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${KOMMO_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  if (!resp.ok) {
    console.error("Error actualizando lead en Kommo:", resp.status, await resp.text());
  }
}
// ---------------------------------------------------------------------------
// Le avisa a Kommo que continúe el bot, mandando el mensaje al cliente
// (uno o varios handlers "show" de <=80 caracteres) y volviendo al paso
// de espera (handler "goto").
// ---------------------------------------------------------------------------
async function avisarAKommoQueContinue(returnUrl, mensaje, accionKommo) {
  if (!returnUrl) {
    console.error("No hay return_url, el bot podría quedarse esperando.");
    return;
  }
  const trozos = partirEnTrozos(mensaje);
  const executeHandlers = trozos.map((trozo) => ({
    handler: "show",
    params: { type: "text", value: trozo },
  }));
  executeHandlers.push({ handler: "goto", params: { type: "question", step: STEP_ESPERAR_RESPUESTA } });

  const body = {
    data: { mensaje, accion: accionKommo },
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
  if (!resp.ok) {
    console.error(`Error al llamar return_url (${resp.status}):`, await resp.text());
  }
}
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido, usa POST" });
  }
  try {
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
        console.error("No se pudo decodificar el token JWT:", e.message);
      }
    }
    const returnUrl = req.body && req.body.return_url;
    if (!leadId) {
      return res.status(400).json({ error: "No se recibió lead_id", body_recibido: req.body });
    }
    // 1) Lee el estado actual directo de Kommo (esto ES la memoria de la conversación).
    const estado = await leerEstadoDelLead(leadId);
    let mensajeRespuesta;
    let accion = "seguir_conversando";
    // 2) Mientras no haya combo elegido, saluda con precios, sin gastar LLM
    //    (antes solo pasaba si además el mensaje venía vacío; eso fallaba
    //    cuando Kommo sí mandaba el texto del primer mensaje del cliente).
    if (!estado.combo) {
      mensajeRespuesta = MENSAJE_BIENVENIDA;
    } else {
      // 3) Intenta resolver por reglas (gratis).
      const porReglas = capaDeReglas(mensajeCliente, estado);
      if (porReglas) {
        mensajeRespuesta = porReglas.texto;
        accion = porReglas.accion;
        Object.assign(estado, porReglas.datos);
      } else {
        // 4) Si no se pudo, al LLM.
        const resultado = await llamarLLM(estado, mensajeCliente);
        mensajeRespuesta = resultado.mensaje;
        accion = resultado.accion;
        const d = resultado.datos_extraidos || {};
        if (d.nombre) estado.nombre = d.nombre;
        if (d.direccion) estado.direccion = d.direccion;
        if (d.ciudad) estado.ciudad = d.ciudad;
        if (d.combo) estado.combo = d.combo;
      }
    }
    // 5) Guarda lo aprendido en Kommo (y mueve el pipeline solo si se cerró).
    await actualizarLeadEnKommo(leadId, estado, accion);
    if (accion === "escalar_humano") {
      console.log(`Lead ${leadId} escalado a humano.`);
      // Si quieres, aquí puedes reusar enviarNotaInterna() como en webhook-carrito.js
      // para avisarle a un asesor humano con una nota en el lead.
    }
    // 6) Le devuelve el control al bot con el mensaje para el cliente y el
    //    código de acción traducido al vocabulario del widget (cerrado/
    //    escalado/seguir).
    const accionKommo = accionParaKommo(accion);
    await avisarAKommoQueContinue(returnUrl, mensajeRespuesta, accionKommo);
    return res.status(200).json({ ok: true, accion: accionKommo, mensaje: mensajeRespuesta });
  } catch (error) {
    console.error("Error general en agente-ventas:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
};

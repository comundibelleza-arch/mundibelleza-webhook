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
// CORREGIDO (18/19-ago-2026), a partir de logs reales de Vercel y del
// editor visual del Salesbot:
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
//  - Se quitó el "goto" que este archivo mandaba dentro de
//    execute_handlers (antes saltaba a un número de paso "STEP_ESPERAR_
//    RESPUESTA" copiado de otro bot, que no existía en este flujo y
//    provocaba un loop: el bloque Julieta se volvía a disparar solo,
//    decenas de veces, sin que el cliente escribiera nada). Ahora, ya que
//    en el editor visual quedó armado un paso nativo de Kommo ("Pausa:
//    Hasta recibir mensaje") conectado después de las salidas del bloque,
//    dejamos que Kommo siga ese camino por su cuenta en vez de forzar un
//    salto desde el código.
//
// ACTUALIZADO (19-ago-2026), a partir de investigación de producto (fabricante
// SEVICH, ingredientes publicados, reseñas reales de compradores, FDA/NHS sobre
// PPD): se agregó conocimiento de producto sintetizado al SYSTEM_PROMPT (qué es
// realmente, qué NO se puede prometer, protocolo de alergia/PPD, perfil de
// cliente) y varias FAQs fijas nuevas para objeciones frecuentes (alergia,
// ¿es natural?, ¿tiene amoníaco?, ¿es permanente?, ¿sirve en barba?, ¿mancha la
// piel?, ¿cuánto dura el color?, ¿cuánto alcanza un sobre?, ¿daña el cabello?).
// Se pusieron como reglas fijas (no LLM) justamente porque son temas sensibles
// (salud/alergia, afirmaciones legales tipo "natural"/"permanente") donde
// conviene una respuesta siempre igual y ya revisada, en vez de dejar que el
// LLM la redacte distinto cada vez.
//
// También (19-ago-2026): se agregó agregarNotaDePedidoCerrado(), que deja una
// nota con el resumen del pedido (combo/nombre/dirección/ciudad) dentro del
// lead cuando el bot cierra una venta. Antes, cerrar_pedido solo movía la
// etapa del pipeline y nadie se enteraba salvo que entrara a mirar Kommo
// manualmente — sigue sin haber aviso activo por WhatsApp/email/Slack, pero
// al menos ahora el resumen queda visible de un vistazo dentro del lead.
//
// REGLA GENERAL (19-ago-2026) que aplica a este bot Y a los que se hagan
// después — dos cosas a repetir en cualquier agente de ventas nuevo:
//  1) Confirmar SIEMPRE municipio Y departamento, no solo "ciudad". Aquí no
//     se creó un campo nuevo en Kommo para departamento (decisión del
//     negocio, para no complicar la cuenta) — en vez de eso se guarda pegado
//     al final del campo "Direccion" ya existente, con el marcador
//     " — Depto: " (ver combinarDireccionYDepartamento/
//     separarDireccionYDepartamento más abajo). Si otro bot sí tiene margen
//     para un campo nuevo en Kommo, es más limpio usar un campo separado en
//     vez de este truco de texto.
//  2) El mensaje justo ANTES de cerrar la venta (accion="cerrar_pedido")
//     SIEMPRE debe terminar en una pregunta de confirmación (ej. "¿Está
//     todo correcto?"), nunca cerrar de una en el mismo turno en que se
//     completó el último dato — así no se corta la conversación con el
//     cliente si algún dato quedó mal. Solo se cierra en el turno
//     SIGUIENTE, cuando el cliente confirma. Ver PATRON_CONFIRMACION_FINAL
//     en capaDeReglas: esa confirmación final se reconoce por regex (gratis,
//     sin LLM) en vez de tener que llamar al modelo otra vez solo para leer
//     un "sí".
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const KOMMO_TOKEN = process.env.KOMMO_TOKEN;
const KOMMO_SUBDOMAIN = "comundibelleza";
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
// El negocio pidió confirmar SIEMPRE municipio Y departamento (no solo
// "ciudad"), pero decidió no crear un campo nuevo en Kommo para
// departamento — en vez de eso se guarda pegado al final del campo
// "Direccion" que ya existe, separado con este marcador. Así, al releer el
// lead, se puede saber si el departamento ya fue capturado o todavía falta
// (ver leerEstadoDelLead) sin depender de memoria entre llamadas.
const MARCADOR_DEPARTAMENTO = " — Depto: ";
function combinarDireccionYDepartamento(direccionCalle, departamento) {
  if (!direccionCalle) return direccionCalle || null;
  if (!departamento) return direccionCalle;
  return `${direccionCalle}${MARCADOR_DEPARTAMENTO}${departamento}`;
}
function separarDireccionYDepartamento(direccionGuardada) {
  if (!direccionGuardada) return { direccion: null, departamento: null };
  const idx = direccionGuardada.indexOf(MARCADOR_DEPARTAMENTO);
  if (idx === -1) return { direccion: direccionGuardada, departamento: null };
  return {
    direccion: direccionGuardada.slice(0, idx),
    departamento: direccionGuardada.slice(idx + MARCADOR_DEPARTAMENTO.length),
  };
}
// NOTA: se intentó mandar la plantilla de bienvenida (template_id 58184)
// desde este código, vía execute_handlers en return_url, pero Kommo la
// rechaza con 400 "Unsupported handler code" — ese canal solo acepta
// "show", no "send_message"/plantillas. Las plantillas de WhatsApp solo se
// pueden disparar como paso nativo fijo dibujado en el editor visual del
// Salesbot, no dinámicamente desde el webhook. Por eso el saludo vuelve a
// mandarse como texto libre (ver MENSAJE_BIENVENIDA más abajo).
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
// Se usa cuando el cliente ya escribió algo pero no logramos identificar
// cuál kit quiere — en vez de repetir todo el saludo con precios, se lo
// volvemos a preguntar corto.
const MENSAJE_REPREGUNTA_COMBO =
  "No logré identificar cuál kit prefieres 🙏 ¿Me confirmas si quieres el " +
  "Combo 1, el Combo 2 o el Combo 3?";
// ---------------------------------------------------------------------------
// Kommo rechaza execute_handlers.show con más de 80 caracteres (validado
// contra logs reales: "This value is too long. It should have 80
// characters or less."). Partimos cualquier mensaje en varios trozos
// cortos, con margen de seguridad porque emojis pueden contar más de 1
// unidad. Prioridad de los cortes, para no perder coherencia:
//   1) saltos de línea del mensaje original (cada línea es su propio
//      grupo, así cada combo queda en su propia burbuja);
//   2) dentro de cada línea, después de un ".", "!" o "?" seguido de
//      espacio — o sea, entre oraciones completas, nunca a la mitad de
//      una frase;
//   3) solo si una sola oración ya es más larga que el límite (caso
//      raro), como último recurso se envuelve por palabra completa.
// Las oraciones/palabras se van empacando juntas hasta llenar el límite,
// para no generar una burbuja por cada frase corta.
// ---------------------------------------------------------------------------
const MAX_SHOW_LEN = 75;
function empacar(unidades, separador, maxLen) {
  const trozos = [];
  let actual = "";
  for (const unidad of unidades) {
    const candidato = actual ? `${actual}${separador}${unidad}` : unidad;
    if (candidato.length > maxLen) {
      if (actual) trozos.push(actual);
      actual = unidad;
    } else {
      actual = candidato;
    }
  }
  if (actual) trozos.push(actual);
  return trozos;
}
function partirPorPalabra(texto, maxLen) {
  return empacar(texto.split(/\s+/).filter(Boolean), " ", maxLen);
}
function partirEnTrozos(mensaje) {
  const lineas = mensaje.split("\n");
  const trozos = [];
  for (const linea of lineas) {
    if (!linea.trim()) continue; // las líneas vacías eran solo espaciado
    // Corta la línea en oraciones completas (después de ".", "!" o "?"
    // seguido de espacio) en vez de por palabra suelta.
    const oraciones = linea.split(/(?<=[.!?])\s+/).filter(Boolean);
    // Si alguna oración por sí sola ya pasa el límite (raro), se envuelve
    // por palabra solo esa oración, como último recurso.
    const unidades = oraciones.flatMap((oracion) =>
      oracion.length > MAX_SHOW_LEN ? partirPorPalabra(oracion, MAX_SHOW_LEN) : [oracion]
    );
    trozos.push(...empacar(unidades, " ", MAX_SHOW_LEN));
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
// FAQs generales: se deben contestar SIEMPRE, sin importar si el cliente
// ya eligió combo o no. El orden importa: "pago contraentrega" se revisa
// antes que "envío" porque la palabra "contraentrega" contiene la
// subcadena "entrega" y si el patrón de envío se revisara primero se
// robaría preguntas que en realidad son sobre la forma de pago.
const FAQ_SIEMPRE = [
  {
    patron: /(pago\s*contra\s*entrega|contraentrega|pagar\s*al\s*recibir|pago\s*al\s*recibir)/,
    respuesta: () => "Sí, manejamos pago contraentrega.",
  },
  {
    patron: /(d[oó]nde\s*(est[aá]n|queda|quedan|se\s*encuentran)|ubicaci[oó]n|de\s*d[oó]nde\s*son)/,
    respuesta: () =>
      "Hola 👋, somos Mundibelleza, en Bogotá. Hacemos envíos a todo el país, " +
      "con pago contraentrega — pagas al recibir tu pedido 😊.",
  },
  {
    patron: /(otro[s]?\s*producto|m[aá]s\s*producto|qu[eé]\s*m[aá]s\s*(venden|manejan|tienen|ofrecen))/,
    respuesta: () => "No, en esta campaña solo estamos ofertando el Black Hair Shampoo.",
  },
  {
    patron: /(env[ií]o|entrega|demora|cu[aá]ndo\s*llega|tiempo\s*de\s*env[ií]o)/,
    respuesta: () =>
      // ACORTADO (19-ago-2026): la versión original generaba 4 burbujas de
      // WhatsApp (261 caracteres) y a veces llegaban desordenadas. Esta
      // versión dice lo mismo en menos texto, para que quepa en 1-2.
      "Llega entre 2 y 5 días hábiles después del envío 🚛. No manejamos " +
      "fecha exacta porque depende de la transportadora, pero lo despachamos " +
      "lo antes posible 😊.",
  },
  // ---------------------------------------------------------------------
  // FAQs nuevas (19-ago-2026), a partir de la investigación de producto.
  // Van como respuesta FIJA (no LLM) por ser temas sensibles de salud o
  // afirmaciones que no podemos variar (natural / permanente / amoníaco).
  // Se revisan en orden, así que "envío" de arriba sigue ganando si el
  // cliente pregunta algo como "¿cuánto dura el envío?".
  // ---------------------------------------------------------------------
  // ACORTADAS (19-ago-2026): todas estas respuestas generaban entre 3 y 5
  // burbujas de WhatsApp y a veces llegaban desordenadas (ver conversación
  // sobre delays — no hay forma de forzar el orden por la API, así que la
  // mitigación real es reducir cuántas burbujas se generan). Se acortó la
  // redacción manteniendo el mismo contenido — en las de seguridad
  // (alergia/PPD, amoníaco, daño) NO se recortó ninguna advertencia, solo
  // el largo de las frases.
  {
    patron: /(alergia|al[eé]rgic|\bppd\b|reacci[oó]n\s*(al[eé]rgica)?|irritaci[oó]n|piel\s*sensible|prueba\s*de\s*(alergia|sensibilidad)|henna)/,
    respuesta: () =>
      "El producto contiene PPD, que en algunas personas puede causar alergia. " +
      "Te recomendamos probarlo antes en una zona pequeña de piel, sobre todo " +
      "si antes tuviste reacción a tintes o henna negra.",
  },
  {
    patron: /(es\s+natural|100\s*%?\s*natural|sin\s*qu[ií]micos|no\s*tiene\s*qu[ií]micos|org[aá]nico)/,
    respuesta: () =>
      "Es una fórmula de coloración capilar, no es 100% natural ni libre de " +
      "químicos, pensada para cubrir y oscurecer las canas rápido.",
  },
  {
    patron: /amon[ií]aco/,
    respuesta: () =>
      "Ese dato no lo tengo confirmado para este lote, prefiero no afirmarlo. " +
      "Sí te confirmo que es una fórmula pensada para actuar rápido y cubrir " +
      "bien las canas.",
  },
  {
    patron: /(permanente|para\s*siempre|definitivo|no\s*se\s*(quita|va)\s*(nunca)?)/,
    respuesta: () =>
      "No es permanente: el color se va perdiendo con los lavados, así que " +
      "puedes volver a aplicarlo cuando lo necesites.",
  },
  {
    patron: /\bbarba\b/,
    respuesta: () =>
      "Esta presentación es para el cabello. Para barba la marca maneja otras " +
      "líneas específicas, así que no te la recomendaría para esa zona.",
  },
  {
    patron: /(mancha|te[ñn]ir\s*(la\s*)?piel|guante)/,
    respuesta: () =>
      "Puede manchar la piel o superficies temporalmente, por eso te " +
      "recomendamos usar guantes al aplicarlo.",
  },
  {
    patron: /(cu[aá]nto\s*(tiempo\s*)?(me\s*)?dura|dura\s*cu[aá]nto|se\s*mantiene\s*el\s*color)/,
    respuesta: () =>
      "El fabricante indica hasta unas 4 semanas, pero varía por persona: hay " +
      "quienes reportan 1-2 semanas y otros hasta un mes, según lavado y tipo " +
      "de cabello.",
  },
  {
    patron: /(cu[aá]nto\s*(me\s*)?alcanza|alcanza\s*(el|un)?\s*sobre|cu[aá]nto\s*rinde|rinde\s*(el|un)?\s*sobre)/,
    respuesta: () =>
      "Un sobre alcanza para cabello corto o medio. Si es largo o abundante, " +
      "puede que necesites más de un sobre.",
  },
  {
    patron: /(da[ñn]a(r)?\s*(el\s*)?cabello|maltrat[a-z]*\s*(el\s*)?cabello|resec[a-z]*\s*(el\s*)?cabello)/,
    respuesta: () =>
      "Es coloración, así que como cualquier tinte puede afectar un poco la " +
      "fibra capilar. Sigue las instrucciones y haz la prueba de sensibilidad " +
      "antes.",
  },
];
// FAQs que solo tienen sentido una vez el cliente ya eligió un combo (por
// ejemplo, comparar precios entre los tres).
const FAQ_CON_COMBO = [
  {
    patron: /(precio|cu[aá]nto\s*(cuesta|vale)|costo)/,
    respuesta: () =>
      `Combo 1: ${formatoPrecio(COMBOS[1].precio)}, Combo 2: ${formatoPrecio(COMBOS[2].precio)}, ` +
      `Combo 3: ${formatoPrecio(COMBOS[3].precio)} (el más conveniente). ¿Cuál te interesa?`,
  },
];
// Reconoce una confirmación corta y explícita ("sí", "correcto", "dale"...)
// SIN nada más pegado al mensaje — si el cliente escribe "sí pero cambia la
// dirección", esto NO debe hacer match (por eso el ancla de inicio Y fin),
// para no cerrar de una por accidente cuando en realidad viene una
// corrección. Si no hace match, el mensaje sigue de largo hasta el LLM, que
// sí sabe leer matices.
const PATRON_CONFIRMACION_FINAL =
  /^(s[ií]|correcto|confirmo|as[ií]\s*es|dale|ok|listo|exacto|perfecto|de\s*una|claro|todo\s*bien|eso\s*es)[\s.,!¡¿?]*$/i;
function capaDeReglas(mensaje, estado) {
  const t = mensaje.toLowerCase();
  // 1) FAQs generales: siempre activas, sin importar el estado.
  for (const regla of FAQ_SIEMPRE) {
    if (regla.patron.test(t)) {
      return { texto: regla.respuesta(), accion: "seguir_conversando", datos: {} };
    }
  }
  // 1.5) Si ya está TODO el pedido completo (combo + nombre + dirección +
  // municipio + departamento) y el cliente solo está confirmando, cierra
  // aquí mismo sin gastar una llamada al LLM. La pregunta de confirmación
  // que el cliente está respondiendo la generó el LLM en el turno anterior
  // (ver regla en SYSTEM_PROMPT); esta regla solo reconoce el "sí".
  if (
    estado.combo &&
    estado.nombre &&
    estado.direccion &&
    estado.ciudad &&
    estado.departamento &&
    PATRON_CONFIRMACION_FINAL.test(mensaje.trim())
  ) {
    return {
      texto: "¡Listo! 🎉 Tu pedido quedó confirmado, en un momento coordinamos el envío.",
      accion: "cerrar_pedido",
      datos: {},
    };
  }
  // 2) Si todavía no hay combo, intenta identificar cuál kit quiere.
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
  // 3) Ya hay combo: FAQs que solo aplican en ese caso.
  for (const regla of FAQ_CON_COMBO) {
    if (regla.patron.test(t)) {
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
  // Leemos siempre como texto primero: si Kommo responde con el cuerpo
  // vacío (pasa incluso con status "ok" en algunos casos, p.ej. token
  // inválido/redirect), esto evita que resp.json() truene con
  // "Unexpected end of JSON input" y en vez de eso queda logueado qué
  // vino realmente.
  const texto = await resp.text();
  if (!resp.ok) {
    console.error("Error leyendo lead en Kommo:", resp.status, texto);
    return { combo: null, nombre: null, direccion: null, departamento: null, ciudad: null };
  }
  let data;
  try {
    data = texto ? JSON.parse(texto) : {};
  } catch (e) {
    console.error("Kommo respondió 200 pero el cuerpo no es JSON válido:", texto);
    return { combo: null, nombre: null, direccion: null, departamento: null, ciudad: null };
  }
  const campos = {};
  for (const f of data.custom_fields_values || []) {
    campos[f.field_id] = f.values?.[0]?.value ?? null;
  }
  // El departamento vive pegado dentro del campo "Direccion" (ver
  // MARCADOR_DEPARTAMENTO arriba) — hay que separarlo para saber si ya se
  // capturó o si todavía falta pedirlo.
  const { direccion, departamento } = separarDireccionYDepartamento(campos[CAMPO_DIRECCION_ID] || null);
  return {
    combo: campos[CAMPO_COMBO_ID] ? Number(campos[CAMPO_COMBO_ID]) : null,
    nombre: campos[CAMPO_NOMBRE_ID] || null,
    direccion,
    departamento,
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
- Responde en máximo 2-3 frases CORTAS, tono cercano y colombiano, sin markdown,
  máximo 1 emoji. Sé breve: WhatsApp parte tu respuesta en varias burbujas cada
  ~75 caracteres, y si genera más de 2-3 burbujas a veces llegan desordenadas —
  entre más corto el mensaje, menos riesgo de eso.
- Nunca inventes datos de envío, garantías o políticas fuera de: envío gratis a toda
  Colombia, pago contraentrega, entrega 2-5 días hábiles.
- No pidas el teléfono: ya es una conversación de WhatsApp, Kommo ya lo tiene.
- Antes de cerrar necesitas TODOS estos 5 datos: combo, nombre, dirección,
  municipio y departamento (son datos distintos: municipio es la ciudad/pueblo,
  departamento es la región más grande, ej. Medellín es municipio, Antioquia es
  departamento — no asumas el departamento a partir del municipio aunque te
  parezca obvio, pídeselo al cliente igual, hay municipios con el mismo nombre
  en distintos departamentos).
- Cuando con este mensaje completes el ÚLTIMO dato que faltaba de esos 5, NO
  uses "cerrar_pedido" todavía: manda un resumen breve de los 5 datos y termina
  con una pregunta de confirmación (ej.: "Para confirmar: Combo 2, envío a
  [dirección], [municipio], [departamento], a nombre de [nombre]. ¿Está todo
  correcto?"), con accion "seguir_conversando". Usa "cerrar_pedido" solo en un
  mensaje POSTERIOR, cuando el cliente ya haya confirmado. Regla general: el
  mensaje justo antes de cerrar SIEMPRE debe terminar en pregunta, para no
  perder la conversación con el cliente.
- Usa "escalar_humano" solo si el cliente describe una condición médica personal
  (embarazo, enfermedad de piel, medicamentos, etc.), pide reembolso de algo ya
  despachado, o se queja fuerte. Las preguntas generales de alergia/PPD ya las
  cubre una respuesta fija antes de llegar aquí; si igual te toca contestarlas,
  usa el mismo criterio del punto SEGURIDAD de abajo, sin escalar solo por eso.

IDENTIFICACIÓN DEL PRODUCTO:
- Nombre comercial: SEVICH Black Hair Shampoo, 10 sobres de 25 ml c/u (250 ml
  total), color negro. El cliente puede llamarlo de muchas formas: "shampoo
  para las canas", "shampoo anti-canas", "shampoo negro", "tinte shampoo",
  "tinte para canas", "tinte instantáneo", "shampoo Sevich", "Black Hair",
  etc. — todas se refieren al MISMO producto (la Tintura Líquida Negra en
  sobres). Si dice solo "shampoo" y el contexto menciona canas/teñir/
  oscurecer/Sevich, asume que habla de este producto; si no hay contexto
  suficiente, pregunta corto: "¿Te refieres al shampoo de Sevich que ayuda a
  cubrir las canas?". NUNCA corrijas al cliente por decirle "shampoo".
- Qué es en realidad: es una fórmula de COLORACIÓN capilar (contiene PPD y
  peróxido de hidrógeno), no un shampoo de limpieza. No quita caspa, no
  detiene la caída, no hace crecer cabello, no revierte biológicamente las
  canas ni recupera el pigmento natural. Su función es cubrir/oscurecer
  visualmente el cabello con cada aplicación.
- Modo de uso: sobre cabello seco, con guantes, se distribuye el sobre, se
  deja actuar el tiempo indicado en el empaque del cliente (se comercializa
  en 5-10 min según la presentación) y se enjuaga. Un sobre alcanza para
  cabello corto/medio; cabello largo o abundante puede necesitar 2-3 sobres.
- Duración: el fabricante indica hasta ~4 semanas, pero es MUY variable entre
  personas (usuarios reportan desde ~1 semana hasta ~1 mes) según tipo de
  cabello y frecuencia de lavado. Nunca prometas un número exacto de días.

QUÉ NUNCA PROMETER (aunque el cliente insista o lo haya visto en otra publicidad):
- No es "100% natural" ni "sin químicos" (tiene PPD, peróxido, resorcinol).
- No confirmes "sin amoníaco": no está verificado para este lote; si preguntan,
  di que no tienes ese dato específico a la mano.
- No es permanente: el color se pierde con los lavados (es normal, no un
  defecto — de hecho permite volver a comprar/aplicar cuando haga falta).
- No confirmes que sirve para barba: esta presentación es para cabello; la
  marca tiene líneas distintas para barba.
- No prometas "cero daño" ni resultado 100% garantizado: es coloración, di
  que sigan las instrucciones del empaque.
- No menciones registro INVIMA ni "aprobado por INVIMA": no está verificado.

SEGURIDAD (PPD/alergia) — si el cliente pregunta algo de esto que la respuesta
fija no cubrió: el producto contiene PPD, que en algunas personas puede causar
sensibilidad o alergia; recomienda probarlo en una zona pequeña de piel antes
de aplicarlo, sobre todo si antes tuvo reacción a tintes o a henna negra.
Nunca digas "no da alergia" ni "es hipoalergénico".

PERFIL Y ÁNGULO DE VENTA: el cliente típico es un hombre de 38-55 años con
canas en sienes o entradas, que no quiere ir a peluquería ni complicarse.
Vende con "cubre las canas rápido, en casa, sin que se note" — evita lenguaje
tipo "luce espectacular" o "realza tu belleza". Si el cliente duda del combo,
puedes preguntar corto por tipo/cantidad de cabello (corto/medio/largo, poco/
bastante abundante) para recomendar mejor.
Responde ÚNICAMENTE con este JSON, sin texto adicional antes o después, sin markdown, sin backticks:
{"mensaje": "...", "accion": "seguir_conversando|cerrar_pedido|escalar_humano",
 "datos_extraidos": {"nombre": null, "direccion": null, "ciudad": null, "departamento": null, "combo": null}}`;
async function llamarLLM(estado, mensajeNuevo) {
  const resumenEstado =
    `Estado actual: combo=${estado.combo ?? "sin definir"}, nombre=${estado.nombre ?? "?"}, ` +
    `direccion=${estado.direccion ?? "?"}, municipio=${estado.ciudad ?? "?"}, ` +
    `departamento=${estado.departamento ?? "?"}.`;
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
  const cuerpoRespuesta = await response.text();
  if (!response.ok) {
    console.error("Error de la API de Claude:", response.status, cuerpoRespuesta);
    return {
      mensaje: "Perdón, ¿me lo repites? Tuve un problema técnico 🙏",
      accion: "seguir_conversando",
      datos_extraidos: {},
    };
  }
  let data;
  try {
    data = cuerpoRespuesta ? JSON.parse(cuerpoRespuesta) : {};
  } catch (e) {
    console.error("Claude respondió 200 pero el cuerpo no es JSON válido:", cuerpoRespuesta);
    return {
      mensaje: "Perdón, ¿me lo repites? Tuve un problema técnico 🙏",
      accion: "seguir_conversando",
      datos_extraidos: {},
    };
  }
  if (!data.content || !data.content[0]) {
    console.error("Claude respondió sin 'content':", cuerpoRespuesta);
    return {
      mensaje: "Perdón, ¿me lo repites? Tuve un problema técnico 🙏",
      accion: "seguir_conversando",
      datos_extraidos: {},
    };
  }
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
  // El departamento se guarda pegado dentro del mismo campo "Direccion"
  // (ver MARCADOR_DEPARTAMENTO) porque el negocio decidió no crear un campo
  // nuevo en Kommo para esto.
  if (estado.direccion) {
    campos.push({
      field_id: CAMPO_DIRECCION_ID,
      values: [{ value: combinarDireccionYDepartamento(estado.direccion, estado.departamento) }],
    });
  }
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
// AGREGADO (19-ago-2026): antes, cuando el bot cerraba un pedido, lo único
// que pasaba era mover el lead a la etapa "Logrado con éxito" — nadie se
// enteraba a menos que entrara a mirar el pipeline manualmente. Esto deja
// una NOTA dentro del mismo lead con el resumen del pedido (combo, nombre,
// dirección, ciudad) para que quien revise Kommo lo vea de un vistazo, sin
// tener que abrir cada campo personalizado por separado.
// Endpoint de notas de Kommo: POST /api/v4/leads/{id}/notes, con un array de
// notas (aunque aquí solo mandamos una). note_type "common" es una nota de
// texto libre, la más simple que soporta la API.
// ---------------------------------------------------------------------------
async function agregarNotaDePedidoCerrado(leadId, estado) {
  const nombreCombo = estado.combo && COMBOS[estado.combo] ? COMBOS[estado.combo].nombre : "sin definir";
  const texto =
    `🛒 Pedido cerrado por el bot\n` +
    `Combo: ${nombreCombo}\n` +
    `Nombre: ${estado.nombre || "-"}\n` +
    `Dirección: ${estado.direccion || "-"}\n` +
    `Municipio: ${estado.ciudad || "-"}\n` +
    `Departamento: ${estado.departamento || "-"}`;
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
    console.error("Error agregando nota de pedido cerrado en Kommo:", resp.status, await resp.text());
  }
}
// ---------------------------------------------------------------------------
// Le avisa a Kommo que continúe el bot, mandando el mensaje al cliente
// como uno o varios handlers "show" de <=80 caracteres. Esto ya está
// confirmado tanto por los logs reales como por la documentación oficial
// de Kommo (https://developers.kommo.com/reference/salesbot-widget-block-
// execution-confirmation): "value cannot exceed 80 characters" en el
// handler show, y ADEMÁS esa misma documentación dice que el máximo es
// 10 handlers por petición — por eso truncamos si un mensaje (típicamente
// uno generado por el LLM) llegara a producir más de 10 trozos.
//
// PROBADO Y DESCARTADO: mandar un handler "send_message" con template_id
// (para plantillas de WhatsApp) por esta misma vía — Kommo lo rechaza con
// 400 "Unsupported handler code". La documentación oficial solo lista
// "show" y "goto" como handlers soportados en este endpoint; las
// plantillas solo se pueden disparar como paso nativo fijo dibujado en el
// editor visual del Salesbot.
//
// Tampoco mandamos "goto": dejamos que Kommo siga el camino que ya está
// dibujado en el editor visual del Salesbot (salida del bloque -> nota
// interna -> paso nativo "Pausa: Hasta recibir mensaje" -> vuelta a
// Julieta). Mandar nuestro propio "goto" a un número de paso inventado fue
// justo lo que causaba el loop que vimos en los logs.
// ---------------------------------------------------------------------------
const MAX_HANDLERS_POR_PETICION = 10;
async function avisarAKommoQueContinue(returnUrl, mensaje, accionKommo) {
  if (!returnUrl) {
    console.error("No hay return_url, el bot podría quedarse esperando.");
    return;
  }
  let trozos = partirEnTrozos(mensaje);
  if (trozos.length > MAX_HANDLERS_POR_PETICION) {
    console.error(
      `Mensaje truncado: generó ${trozos.length} trozos de "show" pero Kommo permite máximo ${MAX_HANDLERS_POR_PETICION} handlers por petición. Mensaje completo:`,
      mensaje
    );
    trozos = trozos.slice(0, MAX_HANDLERS_POR_PETICION);
  }
  const executeHandlers = trozos.map((trozo) => ({
    handler: "show",
    params: { type: "text", value: trozo },
  }));

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
    // 2) Intenta resolver por reglas primero (gratis). capaDeReglas ya
    //    cubre dos casos según el estado: si todavía no hay combo, intenta
    //    identificar cuál kit mencionó el cliente; si ya hay combo, revisa
    //    las preguntas frecuentes de envío/pago/precio.
    const porReglas = capaDeReglas(mensajeCliente, estado);
    if (porReglas) {
      mensajeRespuesta = porReglas.texto;
      accion = porReglas.accion;
      Object.assign(estado, porReglas.datos);
    } else if (!estado.combo) {
      // Las reglas no lograron identificar el kit. Si el cliente todavía
      // no ha escrito nada (primer contacto real), manda el saludo
      // completo con precios; si ya escribió algo pero no lo entendimos,
      // se lo volvemos a preguntar corto, sin repetir todo el saludo.
      mensajeRespuesta = mensajeCliente ? MENSAJE_REPREGUNTA_COMBO : MENSAJE_BIENVENIDA;
    } else {
      // 3) Ya hay combo y las reglas de FAQ no aplicaron: al LLM.
      const resultado = await llamarLLM(estado, mensajeCliente);
      mensajeRespuesta = resultado.mensaje;
      accion = resultado.accion;
      const d = resultado.datos_extraidos || {};
      if (d.nombre) estado.nombre = d.nombre;
      if (d.direccion) estado.direccion = d.direccion;
      if (d.ciudad) estado.ciudad = d.ciudad;
      if (d.departamento) estado.departamento = d.departamento;
      if (d.combo) estado.combo = d.combo;
    }
    // 5) Guarda lo aprendido en Kommo (y mueve el pipeline solo si se cerró).
    await actualizarLeadEnKommo(leadId, estado, accion);
    if (accion === "cerrar_pedido") {
      // Deja el resumen del pedido como nota en el lead — es la única forma
      // en que hoy alguien se entera de que se cerró una venta (no hay
      // WhatsApp/email/Slack automático, ver comentario arriba de la función).
      await agregarNotaDePedidoCerrado(leadId, estado);
    }
    if (accion === "escalar_humano") {
      console.log(`Lead ${leadId} escalado a humano.`);
      // TODO pendiente (mismo hueco que existía para cerrar_pedido antes de
      // hoy): tampoco hay aviso activo cuando se escala a humano, solo este
      // console.log. Si quieres, se le puede agregar la misma nota interna,
      // o reusar enviarNotaInterna() como en webhook-carrito.js.
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

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
//
// AGREGADO (19-ago-2026) — EMBUDO DE PRE-CALIFICACIÓN para tráfico frío:
// El negocio detectó que mostrar precio de una en el primer mensaje (el
// viejo MENSAJE_BIENVENIDA como saludo inicial) está matando leads fríos:
// llegan de un anuncio, no conocen la marca todavía, y ver 3 precios antes
// de generar ningún interés los espanta. Se cambia el embudo así:
//   Paso 0 (paso NATIVO de Kommo, fuera de este código, ya armado en el
//           editor visual): "¿Cuántas canas tienes? 1 Pocas / 2 Bastantes /
//           3 Muchas" — este código NO manda ese mensaje, solo interpreta
//           la respuesta cuando llega.
//   Paso 1 (este código): guarda el nivel de canas y pregunta "¿Qué buscas
//           principalmente? 1 Disimular las canas / 2 Verte más joven /
//           3 Ambas".
//   Paso 2 (este código): guarda el objetivo y pregunta "¿Quieres ver las
//           ofertas disponibles hoy? 1 Sí / 2 No, quiero saber más".
//   Paso 3 (este código): si responde que sí, ahí recién se muestra
//           MENSAJE_BIENVENIDA (el saludo con los 3 combos y precios, tal
//           cual como estaba antes). Si responde que no, se manda un
//           mensaje corto de valor/beneficios (sin precio) y se repite la
//           misma pregunta, en loop, hasta que acepte ver las ofertas.
//   Paso 4 en adelante: flujo de ventas de siempre (capaDeReglas / FAQs /
//           LLM), sin cambios.
// El progreso de este embudo (nivel de canas, objetivo, y en qué paso va)
// se guarda en 3 campos personalizados NUEVOS del lead — son la única forma
// de tener "memoria" entre llamadas, igual que el resto del estado. Ver
// CAMPO_CANAS_ID / CAMPO_OBJETIVO_ID / CAMPO_FASE_ID más abajo: ya se
// crearon en Kommo (vía PowerShell, POST /leads/custom_fields) y sus
// field_id están cargados, así que FUNNEL_CANAS_HABILITADO queda en true y
// el embudo nuevo ya está activo. Si alguna vez hay que desactivarlo sin
// tocar más código, basta con volver alguno de los 3 a null.
//
// Nivel de canas y objetivo también se guardan para "más adelante" (ver
// resumenEstado en llamarLLM): ya se le pasan al LLM como contexto por si
// quiere personalizar el tono de la conversación de ventas (ej. alguien
// que busca "verte más joven" vs. alguien que solo quiere "disimular"),
// pero de momento no cambian qué combo se recomienda ni el precio.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const KOMMO_TOKEN = process.env.KOMMO_TOKEN;
const KOMMO_SUBDOMAIN = "comundibelleza";
// IDs de campos personalizados del lead (Configuración → Campos personalizados → Leads)
const CAMPO_COMBO_ID = 1289164; // "Combo Blackhair"
const CAMPO_NOMBRE_ID = 1288972; // ya existe ("Nombre cliente (IA)"), mismo que extraer-datos.js
const CAMPO_DIRECCION_ID = 1289162; // "Direccion"
const CAMPO_CIUDAD_ID = 1274145; // ya existe ("Cuidad" — así está escrito en la cuenta)
// --- Campos del embudo de pre-calificación (19-ago-2026) ---------------
// Creados en Kommo por PowerShell (POST /leads/custom_fields):
//   - "Nivel de canas (IA)"     → lista desplegable: Pocas / Bastantes / Muchas
//   - "Objetivo cliente (IA)"   → lista desplegable: Disimular las canas / Verse más joven / Ambas
//   - "Fase embudo canas (IA)"  → texto (campo interno: guarda "objetivo" | "oferta" | "ventas")
const CAMPO_CANAS_ID = 1289166; // "Nivel de canas (IA)"
const CAMPO_OBJETIVO_ID = 1289168; // "Objetivo cliente (IA)"
const CAMPO_FASE_ID = 1289170; // "Fase embudo canas (IA)"
const FUNNEL_CANAS_HABILITADO = Boolean(CAMPO_CANAS_ID && CAMPO_OBJETIVO_ID && CAMPO_FASE_ID);
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
// IMPORTANTE (19-ago-2026): MENSAJE_BIENVENIDA ya NO es lo primero que ve
// un lead frío. Ahora solo se manda cuando el cliente ya pasó por el
// embudo de pre-calificación (canas → objetivo → "sí quiero ver ofertas").
// Sigue existiendo tal cual porque, una vez el cliente pidió ver precios,
// no tiene sentido esconderlos.
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
// AGREGADO (19-ago-2026): qué hacer cuando el cliente manda un audio, una
// imagen, un sticker, un PDF, etc. Kommo normalmente NO manda transcripción
// en message_text para ese tipo de mensajes — llega vacío (""), igual que si
// el cliente no hubiera escrito nada. Antes eso se malinterpretaba distinto
// según la fase (el caso más raro: en la fase de ventas sin combo elegido,
// un audio hacía que se reenviara TODO el saludo con precios, como si fuera
// el primer contacto). Ahora se corta con este mensaje fijo, sin tocar fase
// ni ningún dato guardado, para no reiniciar ni romper el hilo.
// OJO: esto es una inferencia sobre cómo Kommo arma el payload del Salesbot
// para mensajes que no son texto, no algo confirmado con un log real de un
// audio. Si revisas Vercel y ves que Kommo sí manda algún texto/placeholder
// para audios (ej. "[audio]"), avisa para ajustar el chequeo de abajo.
// ---------------------------------------------------------------------------
const MENSAJE_MEDIA_NO_SOPORTADA =
  "Por ahora no puedo escuchar audios ni ver archivos o imágenes 🙏 " +
  "¿me escribes lo que necesitas?";
// AGREGADO (21-ago-2026): mensaje de respaldo para cuando algo falla a
// mitad del proceso (ver el catch general y la rama de "no llegó lead_id"
// más abajo) — antes, en esos casos, Kommo nunca recibía ningún
// execute_handlers y el cliente se quedaba sin ninguna respuesta, en
// silencio total. Ahora siempre se intenta mandar al menos esto.
const MENSAJE_ERROR_TECNICO =
  "Perdón, tuvimos un problema técnico 🙏 ¿me repites tu mensaje?";
// AGREGADO (19-ago-2026), a pedido del negocio: además de pedirle al
// cliente que escriba, deja una nota interna en el lead para que alguien
// del equipo entre a Kommo/WhatsApp y escuche el audio (o vea la imagen/
// archivo) manualmente — el bot no lo puede procesar, pero puede traer
// información igual de importante que un mensaje de texto (ej. el cliente
// mandó su dirección hablada). Mismo endpoint de notas que ya se usa para
// agregarNotaDePedidoCerrado.
// QUITADO (22-ago-2026): ya no se llama desde el flujo principal (ver el
// comentario en el bloque de mensaje vacío, más abajo) mientras se confirma
// si esta nota es la que reactiva por error el paso "Pausa: Hasta recibir
// mensaje" del Salesbot. Se deja la función definida por si se retoma más
// adelante (por otro canal, ej. Slack, en vez de una nota en el lead).
async function agregarNotaDeAudioNoLeido(leadId) {
  const texto =
    `🎧 El cliente mandó un audio, imagen o archivo que el bot no puede leer.\n` +
    `Se le pidió que lo escriba, pero por si trae información importante ` +
    `(ej. la dirección dictada), alguien del equipo debería revisarlo ` +
    `manualmente en WhatsApp/Kommo.`;
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
    console.error("Error agregando nota de audio/archivo no leído en Kommo:", resp.status, await resp.text());
  }
}
// ---------------------------------------------------------------------------
// Mensajes del embudo de pre-calificación (19-ago-2026). El paso 0 (la
// pregunta de "¿cuántas canas tienes?") NO está aquí porque es un paso
// nativo de Kommo, armado en el editor visual, fuera de este código.
// ---------------------------------------------------------------------------
const NIVEL_CANAS_POR_NUMERO = { 1: "Pocas", 2: "Bastantes", 3: "Muchas" };
const OBJETIVO_POR_NUMERO = { 1: "Disimular las canas", 2: "Verse más joven", 3: "Ambas" };
// Texto del negocio para este paso, sin el "responde solamente con el
// número" (19-ago-2026: se quitó porque suena muy a bot). El cliente puede
// responder con el número o con la palabra ("disimular", "joven", "ambas",
// etc.) — detectarObjetivo() ya acepta las dos formas, no dependía de esa
// instrucción para funcionar.
const MENSAJE_PREGUNTA_OBJETIVO =
  "Perfecto 👍\n" +
  "¿Qué buscas principalmente?\n" +
  "1️⃣ Disimular las canas\n" +
  "2️⃣ Verte más joven\n" +
  "3️⃣ Ambas";
// AGREGADO (19-ago-2026): esta es una pregunta de sí/no, así que a pedido
// del negocio se le quitó también la lista de opciones numeradas (1️⃣ Sí /
// 2️⃣ No) — queda como pregunta abierta, más natural. Las de nivel de canas
// y objetivo NO son sí/no (son 3 opciones distintas), esas sí mantienen su
// lista. detectarRespuestaSiNo() ya reconocía respuestas libres ("sí",
// "no", "dale", "claro", etc.), no dependía de que estuvieran las opciones
// escritas para funcionar.
const MENSAJE_INVITACION_OFERTAS =
  "Perfecto 👍\n" +
  "Tenemos un producto en tono negro, pensado para hombres que quieren " +
  "disimular las canas y conseguir una apariencia más uniforme.\n" +
  "¿Quieres ver las ofertas disponibles hoy?";
// Cuando responde "no, quiero saber más": un mensaje de valor/beneficios
// SIN precio todavía, y se vuelve a invitar a ver las ofertas — se repite
// hasta que el cliente acepte, en vez de forzar el precio de una.
const MENSAJE_VALOR_BENEFICIOS =
  "Es una tintura líquida negra en sobres: te la aplicas en casa en unos 5 " +
  "minutos y cubre las canas al instante, sin ir a peluquería 💈. " +
  MENSAJE_INVITACION_OFERTAS;
const MENSAJE_REPREGUNTA_CANAS =
  "No logré identificar tu respuesta 🙏 ¿me confirmas si tienes pocas (1), " +
  "bastantes (2) o muchas (3) canas?";
const MENSAJE_REPREGUNTA_OBJETIVO =
  "No logré identificar tu respuesta 🙏 ¿buscas disimular las canas (1), " +
  "verte más joven (2), o ambas (3)?";
const MENSAJE_REPREGUNTA_OFERTA =
  "No logré identificar tu respuesta 🙏 ¿quieres ver las ofertas disponibles " +
  "hoy, o prefieres que te cuente un poco más primero?";
// Parsers tolerantes: aunque ya no se le pide al cliente "responde solo con
// el número" (19-ago-2026: se quitó de los mensajes por sonar muy a bot),
// igual puede escribir solo el número por costumbre — o la palabra clave
// ("pocas", "joven", "sí", etc.). Estas funciones aceptan cualquiera de las
// dos formas, así que no dependían de esa instrucción para funcionar.
function detectarNivelCanas(texto) {
  const t = (texto || "").toLowerCase();
  if (/\bmucha/.test(t) || /\b3\b/.test(t)) return NIVEL_CANAS_POR_NUMERO[3];
  if (/\bbastante/.test(t) || /\b2\b/.test(t)) return NIVEL_CANAS_POR_NUMERO[2];
  if (/\bpoca/.test(t) || /\b1\b/.test(t)) return NIVEL_CANAS_POR_NUMERO[1];
  return null;
}
function detectarObjetivo(texto) {
  const t = (texto || "").toLowerCase();
  if (/ambas|ambos|las\s*dos|\b3\b/.test(t)) return OBJETIVO_POR_NUMERO[3];
  if (/joven/.test(t) || /\b2\b/.test(t)) return OBJETIVO_POR_NUMERO[2];
  if (/disimul/.test(t) || /\b1\b/.test(t)) return OBJETIVO_POR_NUMERO[1];
  return null;
}
// Para la pregunta de "¿quieres ver las ofertas?", true = sí / false = no /
// null = no se entendió. Igual de tolerante: acepta "1"/"si"/"sí"/"dale" como
// sí, y "2"/"no" como no.
// BUG CORREGIDO (19-ago-2026), encontrado probando este mismo archivo: con
// "\bsí\b" (tilde), JavaScript NO reconoce "í" como carácter de palabra en
// una regex normal, así que el \b después de la í nunca hacía match — un
// cliente que escribía "sí" (con tilde, lo normal en español) cada vez
// caía en la repregunta en vez de avanzar. Se cambia el \b de después por
// un lookahead que sí entiende letras acentuadas, para que "sí" (con o sin
// tilde) funcione igual.
function detectarRespuestaSiNo(texto) {
  const t = (texto || "").trim().toLowerCase();
  if (/^(1|s[ií](?![a-záéíóúñ])|dale|claro|obvio|de\s*una)/.test(t) || /\b1\b/.test(t)) return true;
  if (/^(2|no(?![a-záéíóúñ]))/.test(t) || /\b2\b/.test(t)) return false;
  return null;
}
// ---------------------------------------------------------------------------
// AGREGADO (21-ago-2026): respaldo por LLM para las 3 preguntas del embudo
// de canas, para cuando el cliente responde con texto libre que no matchea
// ningún patrón de detectarNivelCanas/detectarObjetivo/detectarRespuestaSiNo
// (caso real: "Tengo el cabello blanco" en vez de "muchas" o "3"). Antes,
// cualquier respuesta que no matcheara el regex SIEMPRE caía en la
// repregunta ("No logré identificar tu respuesta 🙏"), obligando al cliente
// a volver a responder con el número exacto del menú.
// Solo se llama cuando el regex ya intentó y no encontró nada (nunca
// reemplaza al regex, solo lo respalda) — así no se gasta una llamada al
// LLM en el caso común de que el cliente sí responda con el número o la
// palabra esperada. Se le pide a Claude que verifique si el mensaje se
// puede mapear a una de las opciones del menú aunque no use esas palabras
// exactas, y que devuelva solo el número de la opción, o "0" si no hay
// relación clara.
// Devuelve el texto EXACTO de una de las `opciones` recibidas, o null si
// Claude no encontró relación clara, si la respuesta no vino en el formato
// esperado, o si la llamada falló por cualquier motivo (red, cuota, etc.).
// En todos esos casos de null el llamador cae de vuelta a la repregunta de
// siempre, así que un fallo acá nunca deja al cliente sin respuesta.
// ---------------------------------------------------------------------------
async function clasificarConLLM(pregunta, opciones, mensajeCliente) {
  if (!ANTHROPIC_API_KEY) return null;
  const listaOpciones = opciones.map((o, i) => `${i + 1}) ${o}`).join("\n");
  const prompt =
    `Un cliente le está respondiendo a esta pregunta de un bot de ventas por WhatsApp:\n` +
    `"${pregunta}"\n\nOpciones válidas:\n${listaOpciones}\n\n` +
    `Respuesta del cliente: "${mensajeCliente}"\n\n` +
    `¿A cuál opción se refiere el cliente, aunque no haya usado las palabras ` +
    `exactas del menú? Responde ÚNICAMENTE con el número de la opción (ej: "2"), ` +
    `o con "0" si la respuesta no tiene relación clara con ninguna opción. Sin ` +
    `texto adicional, sin explicación.`;
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 10,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const cuerpoRespuesta = await response.text();
    if (!response.ok) {
      console.error("Error de la API de Claude (clasificarConLLM):", response.status, cuerpoRespuesta);
      return null;
    }
    const data = cuerpoRespuesta ? JSON.parse(cuerpoRespuesta) : {};
    const texto = data?.content?.[0]?.text?.trim() || "";
    const numero = parseInt((texto.match(/\d+/) || [])[0] || "0", 10);
    if (numero >= 1 && numero <= opciones.length) return opciones[numero - 1];
    return null;
  } catch (e) {
    console.error("clasificarConLLM falló:", e.message);
    return null;
  }
}
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
    patron: /(env[ií]o|entrega|demora|tarda|cu[aá]ndo\s*llega|tiempo\s*de\s*env[ií]o)/,
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
// ---------------------------------------------------------------------------
// AGREGADO (19-ago-2026), a partir de un caso real: el cliente ya había
// elegido el Combo 3 y preguntó "¿dónde están ubicados?" a mitad del
// checkout. La FAQ fija contestaba la pregunta y ahí se quedaba, sin volver
// a pedir el dato que faltaba (nombre, en ese caso) — el mensaje no
// terminaba en pregunta, así que el cliente no supo que se esperaba que
// respondiera algo más, y la conversación se cortó.
// Esta función decide cuál pregunta agregar al final de CUALQUIER respuesta
// (FAQ fija o, más abajo, también se usa como guía para el LLM) cuando ya
// hay un combo elegido: pide el siguiente dato que falte, en orden, o pide
// confirmación final si ya están los 5. Antes de que haya combo elegido no
// se fuerza ninguna pregunta extra (el saludo ya termina en "¿Cuál te
// interesa?", no hace falta insistir más en esa etapa).
// ---------------------------------------------------------------------------
function preguntaSiguienteDato(estado) {
  if (!estado.combo) return null;
  if (!estado.nombre) return "¿Me regalas tu nombre completo para continuar con tu pedido?";
  if (!estado.direccion) return "¿Cuál es tu dirección completa (calle y número)?";
  if (!estado.ciudad) return "¿En qué municipio/ciudad es la entrega?";
  if (!estado.departamento) return "¿Y en qué departamento queda eso?";
  return "¿Confirmamos tu pedido con esos datos?";
}
function capaDeReglas(mensaje, estado) {
  const t = mensaje.toLowerCase();
  // 1) FAQs generales: siempre activas, sin importar el estado. Si ya hay
  // combo elegido, se le pega al final la pregunta por el siguiente dato
  // que falte — así la FAQ nunca deja la conversación "colgada" sin pedir
  // nada. Antes de elegir combo, se responde la FAQ tal cual, sin forzar
  // pregunta extra.
  for (const regla of FAQ_SIEMPRE) {
    if (regla.patron.test(t)) {
      let texto = regla.respuesta();
      const siguiente = preguntaSiguienteDato(estado);
      if (siguiente) texto = `${texto} ${siguiente}`;
      return { texto, accion: "seguir_conversando", datos: {} };
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
  const estadoVacio = {
    combo: null,
    nombre: null,
    direccion: null,
    departamento: null,
    ciudad: null,
    nivelCanas: null,
    objetivo: null,
    fase: null,
  };
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
    return estadoVacio;
  }
  let data;
  try {
    data = texto ? JSON.parse(texto) : {};
  } catch (e) {
    console.error("Kommo respondió 200 pero el cuerpo no es JSON válido:", texto);
    return estadoVacio;
  }
  const campos = {};
  for (const f of data.custom_fields_values || []) {
    campos[f.field_id] = f.values?.[0]?.value ?? null;
  }
  // El departamento vive pegado dentro del campo "Direccion" (ver
  // MARCADOR_DEPARTAMENTO arriba) — hay que separarlo para saber si ya se
  // capturó o si todavía falta pedirlo.
  const { direccion, departamento } = separarDireccionYDepartamento(campos[CAMPO_DIRECCION_ID] || null);
  const estado = {
    combo: campos[CAMPO_COMBO_ID] ? Number(campos[CAMPO_COMBO_ID]) : null,
    nombre: campos[CAMPO_NOMBRE_ID] || null,
    direccion,
    departamento,
    ciudad: campos[CAMPO_CIUDAD_ID] || null,
    nivelCanas: CAMPO_CANAS_ID ? campos[CAMPO_CANAS_ID] || null : null,
    objetivo: CAMPO_OBJETIVO_ID ? campos[CAMPO_OBJETIVO_ID] || null : null,
    fase: CAMPO_FASE_ID ? campos[CAMPO_FASE_ID] || null : null,
  };
  // Compatibilidad hacia atrás: un lead que ya venía conversando ANTES de
  // que este embudo de pre-calificación existiera (o mientras
  // FUNNEL_CANAS_HABILITADO todavía era false) puede tener combo ya
  // elegido pero fase=null. Sin este ajuste, el código pensaría que el
  // próximo mensaje de ese cliente es la respuesta a "¿cuántas canas
  // tienes?" y le rompería la conversación a mitad de camino.
  if (!estado.fase && estado.combo) estado.fase = "ventas";
  return estado;
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
- Si el estado te trae nivel_canas y/o objetivo ya capturados (vienen de un
  embudo de pre-calificación previo, ya respondido por el cliente), puedes
  usarlos para darle un toque personalizado al tono (ej. si objetivo es
  "Verse más joven", puedes enmarcar el beneficio en verse más joven; si
  nivel_canas es "Muchas", puedes mencionar que tal vez necesite más de un
  sobre). Es opcional, no cambia el precio ni el combo recomendado, es solo
  para que la conversación se sienta más a la medida.
- REGLA GENERAL (la más importante de romper): si tu accion es
  "seguir_conversando", tu mensaje SIEMPRE debe terminar en una pregunta
  concreta, nunca en una afirmación o dato suelto. Ejemplo de lo que NO
  hacer: responder una pregunta del cliente (envío, ubicación, etc.) y
  quedarte ahí sin pedir nada más, aunque todavía te falte un dato del
  pedido — eso corta la conversación porque el cliente no sabe que se
  espera que responda algo. Si ya tienes combo elegido y todavía faltan
  datos, SIEMPRE cierra tu respuesta pidiendo el siguiente dato que falte
  (nombre → dirección → municipio → departamento, en ese orden), aunque el
  mensaje del cliente haya sido sobre otra cosa (ej.: contesta su pregunta
  de envío Y en la misma respuesta pide el dato que falte, terminando en
  "?").
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
    `departamento=${estado.departamento ?? "?"}, nivel_canas=${estado.nivelCanas ?? "?"}, ` +
    `objetivo=${estado.objetivo ?? "?"}.`;
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
  // Campos del embudo de pre-calificación (solo si ya configuraste los
  // field_id reales — ver CAMPO_CANAS_ID/CAMPO_OBJETIVO_ID/CAMPO_FASE_ID).
  if (CAMPO_CANAS_ID && estado.nivelCanas) {
    campos.push({ field_id: CAMPO_CANAS_ID, values: [{ value: estado.nivelCanas }] });
  }
  if (CAMPO_OBJETIVO_ID && estado.objetivo) {
    campos.push({ field_id: CAMPO_OBJETIVO_ID, values: [{ value: estado.objetivo }] });
  }
  if (CAMPO_FASE_ID && estado.fase) {
    campos.push({ field_id: CAMPO_FASE_ID, values: [{ value: estado.fase }] });
  }
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
async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido, usa POST" });
  }
  // AGREGADO (21-ago-2026): leadId, returnUrl y mensajeCliente se declaran
  // ANTES del try (con "let", ya no "const" adentro) para que el catch
  // general de más abajo los pueda usar. Antes vivían solo dentro del try:
  // si algo fallaba a mitad de la función (un fetch a Kommo o a Anthropic
  // que rechazara la conexión, un JSON con forma inesperada, etc.), el catch
  // no tenía ni el return_url para poder avisarle a Kommo qué pasó — el
  // resultado real era que el cliente se quedaba sin NINGUNA respuesta, sin
  // importar en qué punto del proceso hubiera fallado algo. Este es
  // justamente el bug reportado: un cliente responde "3" y el bot se queda
  // callado — no porque la lógica del embudo esté mal (se revisó y matchea
  // bien), sino porque cualquier excepción en el camino terminaba en un 500
  // silencioso, sin nunca llamar a avisarAKommoQueContinue().
  let leadId = null;
  let returnUrl = null;
  let mensajeCliente = "";
  try {
    // AGREGADO (21-ago-2026): log del body crudo, igual que ya hace
    // extraer-campana-kommo-whatsapp.js. Sin esto no hay forma de confirmar
    // en Vercel qué mandó Kommo realmente cuando mensajeCliente sale vacío
    // (caso real detectado: se etiquetó como "audio/imagen no soportada"
    // un mensaje que probablemente no lo era — hay que ver el body real
    // para saber si el texto venía bajo una clave distinta a las que ya
    // revisamos abajo).
    console.log("BODY CRUDO (ventas blackhair):", JSON.stringify(req.body));
    mensajeCliente =
      (req.body &&
        (req.body["data[message_text]"] ||
          req.body.message_text ||
          req.body.text ||
          (req.body.data && req.body.data.message_text))) ||
      "";
    leadId =
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
    returnUrl = req.body && req.body.return_url;
    if (!leadId) {
      console.error("No se recibió lead_id. Body:", JSON.stringify(req.body));
      // AGREGADO (21-ago-2026): antes esto cortaba con un 400 sin avisarle
      // nunca a Kommo, dejando al cliente sin ninguna respuesta. Si al menos
      // hay return_url, se le manda un mensaje de disculpa para no dejar la
      // conversación colgada en silencio.
      await avisarAKommoQueContinue(returnUrl, MENSAJE_ERROR_TECNICO, accionParaKommo("seguir_conversando"));
      return res.status(400).json({ error: "No se recibió lead_id", body_recibido: req.body });
    }
    // 1) Si no llegó texto (típicamente audio/imagen/archivo — ver
    //    MENSAJE_MEDIA_NO_SOPORTADA arriba), responde eso mismo y corta acá,
    //    sin gastar una llamada a Kommo para leer el estado ni tocar fase/
    //    combo/datos. Con el embudo de canas activo, un mensaje vacío ya NO
    //    debería significar "primer contacto real" (ese ahora siempre llega
    //    con texto, porque responde a la pregunta nativa de canas).
    if (!mensajeCliente || !mensajeCliente.trim()) {
      // QUITADO (22-ago-2026): antes, aquí primero se llamaba a
      // agregarNotaDeAudioNoLeido(leadId), que escribe una nota en el lead
      // vía la API de Kommo. Hipótesis en investigación: esa nota (actividad
      // sobre el lead vía API, igual que la que ya quitamos de
      // extraer-campana-kommo-whatsapp.js) podría estar reactivando el paso
      // nativo "Pausa: Hasta recibir mensaje" del Salesbot, lo que dispararía
      // este mismo bloque otra vez con mensaje vacío -> nueva nota -> nueva
      // reactivación -> loop. Coincide con el patrón real observado (el
      // mensaje "no puedo escuchar audios" repitiéndose cada pocos minutos
      // sin que el cliente escriba nada más). Se deja solo el console.log
      // para no perder visibilidad del caso mientras se confirma la
      // hipótesis con logs reales de Vercel.
      console.log(`Lead ${leadId}: mensaje vacío (audio/imagen/archivo no soportado, o posible disparo sin mensaje real).`);
      await avisarAKommoQueContinue(returnUrl, MENSAJE_MEDIA_NO_SOPORTADA, accionParaKommo("seguir_conversando"));
      return res.status(200).json({ ok: true, accion: "seguir", mensaje: MENSAJE_MEDIA_NO_SOPORTADA });
    }
    // 2) Lee el estado actual directo de Kommo (esto ES la memoria de la conversación).
    const estado = await leerEstadoDelLead(leadId);
    let mensajeRespuesta;
    let accion = "seguir_conversando";
    // ---------------------------------------------------------------------
    // 3) EMBUDO DE PRE-CALIFICACIÓN (19-ago-2026), solo si ya configuraste
    // los 3 campos nuevos en Kommo (FUNNEL_CANAS_HABILITADO). Mientras no
    // los configures, este bloque se salta entero y el bot se comporta
    // exactamente como antes (directo al flujo de ventas de abajo).
    //
    // estado.fase indica QUÉ pregunta está esperando responder el cliente
    // con el mensaje que acaba de llegar:
    //   null            -> el mensaje que llegó es la respuesta al paso 0
    //                       nativo de Kommo ("¿cuántas canas tienes?").
    //   "objetivo"      -> el mensaje que llegó es la respuesta a "¿qué
    //                       buscas principalmente?".
    //   "oferta"        -> el mensaje que llegó es sí/no a "¿quieres ver
    //                       las ofertas?".
    //   "ventas"        -> el embudo ya terminó, sigue el flujo de ventas
    //                       de siempre (capaDeReglas/LLM), sin cambios.
    // ---------------------------------------------------------------------
    let yaResuelto = false;
    if (FUNNEL_CANAS_HABILITADO && estado.fase !== "ventas") {
      yaResuelto = true;
      if (!estado.fase) {
        // Respuesta a "¿cuántas canas tienes?" (paso nativo de Kommo).
        let nivel = detectarNivelCanas(mensajeCliente);
        if (!nivel) {
          // El regex no matcheó nada (ej. "tengo el cabello blanco") — antes
          // de repreguntar, se verifica con el LLM si se puede mapear a una
          // de las 3 opciones aunque no use las palabras exactas del menú.
          nivel = await clasificarConLLM(
            "¿Cuántas canas tienes?",
            ["Pocas", "Bastantes", "Muchas"],
            mensajeCliente
          );
        }
        if (!nivel) {
          mensajeRespuesta = MENSAJE_REPREGUNTA_CANAS;
        } else {
          estado.nivelCanas = nivel;
          estado.fase = "objetivo";
          mensajeRespuesta = MENSAJE_PREGUNTA_OBJETIVO;
        }
      } else if (estado.fase === "objetivo") {
        // Respuesta a "¿qué buscas principalmente?".
        let objetivo = detectarObjetivo(mensajeCliente);
        if (!objetivo) {
          objetivo = await clasificarConLLM(
            "¿Qué buscas principalmente?",
            ["Disimular las canas", "Verse más joven", "Ambas"],
            mensajeCliente
          );
        }
        if (!objetivo) {
          mensajeRespuesta = MENSAJE_REPREGUNTA_OBJETIVO;
        } else {
          estado.objetivo = objetivo;
          estado.fase = "oferta";
          mensajeRespuesta = MENSAJE_INVITACION_OFERTAS;
        }
      } else if (estado.fase === "oferta") {
        // Respuesta a "¿quieres ver las ofertas disponibles hoy?".
        let quiere = detectarRespuestaSiNo(mensajeCliente);
        if (quiere === null) {
          const opcion = await clasificarConLLM(
            "¿Quieres ver las ofertas disponibles hoy?",
            ["Sí, quiere ver las ofertas", "No, prefiere que le cuenten más primero"],
            mensajeCliente
          );
          if (opcion) quiere = opcion === "Sí, quiere ver las ofertas";
        }
        if (quiere === true) {
          estado.fase = "ventas";
          mensajeRespuesta = MENSAJE_BIENVENIDA;
        } else if (quiere === false) {
          // No cambia de fase: se queda en "oferta" y vuelve a invitar,
          // en vez de forzar el precio antes de que el cliente esté listo.
          mensajeRespuesta = MENSAJE_VALOR_BENEFICIOS;
        } else {
          mensajeRespuesta = MENSAJE_REPREGUNTA_OFERTA;
        }
      }
    }
    // 4) Si el embudo de pre-calificación no aplicó (o ya terminó), sigue
    //    el flujo de ventas de siempre, sin cambios respecto a antes.
    if (!yaResuelto) {
      // 3a) Intenta resolver por reglas primero (gratis). capaDeReglas ya
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
        // 3b) Ya hay combo y las reglas de FAQ no aplicaron: al LLM.
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
    }
    // 6) Guarda lo aprendido en Kommo (y mueve el pipeline solo si se cerró).
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
    // 7) Le devuelve el control al bot con el mensaje para el cliente y el
    //    código de acción traducido al vocabulario del widget (cerrado/
    //    escalado/seguir).
    const accionKommo = accionParaKommo(accion);
    await avisarAKommoQueContinue(returnUrl, mensajeRespuesta, accionKommo);
    return res.status(200).json({ ok: true, accion: accionKommo, mensaje: mensajeRespuesta });
  } catch (error) {
    console.error(`Error general en agente-ventas (lead ${leadId ?? "?"}, mensaje: "${mensajeCliente}"):`, error);
    // AGREGADO (21-ago-2026): antes, cualquier excepción en medio del
    // proceso terminaba aquí con solo un 500 — Kommo nunca recibía el
    // execute_handlers que le dice qué mostrarle al cliente, así que el
    // cliente se quedaba sin respuesta, sin siquiera un mensaje de error.
    // Ahora, si se alcanzó a tener return_url, se le avisa a Kommo con un
    // mensaje de disculpa genérico para no cortar la conversación en
    // silencio. Va en su propio try/catch porque ya estamos en el catch
    // general: si este intento también falla, no debe tumbar la función.
    if (returnUrl) {
      try {
        await avisarAKommoQueContinue(returnUrl, MENSAJE_ERROR_TECNICO, accionParaKommo("seguir_conversando"));
      } catch (e2) {
        console.error("También falló el intento de avisarle el error a Kommo:", e2.message);
      }
    }
    return res.status(500).json({ error: "Error interno del servidor" });
  }
}
module.exports = handler;
// ---------------------------------------------------------------------------
// AGREGADO (19-ago-2026): se exponen estas piezas internas para que
// api/seguimiento-leads-blackhair.js (el script de recordatorios a leads
// que dejaron de contestar) las reutilice en vez de duplicar textos/lógica
// — así, si cambias un mensaje o un field_id aquí, el script de seguimiento
// automáticamente usa la versión nueva, sin tener que acordarte de tocar
// dos archivos. No afecta a Vercel: module.exports sigue siendo la función
// handler (los objetos función en JS pueden tener propiedades extra).
// ---------------------------------------------------------------------------
Object.assign(module.exports, {
  leerEstadoDelLead,
  preguntaSiguienteDato,
  separarDireccionYDepartamento,
  combinarDireccionYDepartamento,
  MENSAJE_BIENVENIDA,
  MENSAJE_REPREGUNTA_COMBO,
  MENSAJE_PREGUNTA_OBJETIVO,
  MENSAJE_INVITACION_OFERTAS,
  MENSAJE_VALOR_BENEFICIOS,
  COMBOS,
  PIPELINE_ID,
  STAGE_PEDIDO_CONFIRMADO_ID,
  KOMMO_SUBDOMAIN,
  KOMMO_TOKEN,
  CAMPO_COMBO_ID,
  CAMPO_NOMBRE_ID,
  CAMPO_DIRECCION_ID,
  CAMPO_CIUDAD_ID,
  CAMPO_CANAS_ID,
  CAMPO_OBJETIVO_ID,
  CAMPO_FASE_ID,
});

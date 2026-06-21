// Webhook Mundibelleza — Extrae nombre O tipo de negocio con Claude
// (uno por llamada, según el parámetro "tipo") y lo escribe directamente
// en el lead de Kommo vía API.
// Versión para Vercel (función serverless)
// Esta función vive en /api/extraer-datos.js y Vercel la expone
// automáticamente en: https://tu-proyecto.vercel.app/api/extraer-datos

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const KOMMO_TOKEN = process.env.KOMMO_TOKEN;
const KOMMO_DOMAIN = "comundibelleza.kommo.com";

// IDs de los campos personalizados en Kommo (Configuración → Campos personalizados)
const CAMPO_NOMBRE_ID = 1288972; // "Nombre cliente (IA)" — tipo texto
const CAMPO_TIPO_NEGOCIO_ID = 1288976; // "Tipo de negocio (texto)" — tipo texto libre

// Un prompt distinto según qué estemos extrayendo en esta llamada
const PROMPTS = {
  nombre: `Eres un extractor de datos. A partir del mensaje del cliente, extrae su nombre de pila (solo el nombre, sin apellidos ni frases adicionales).

Si no aparece ningún nombre reconocible, usa null.

Responde ÚNICAMENTE con un JSON válido en este formato, sin texto adicional antes o después, sin markdown, sin backticks:

{"nombre": "..."}`,

  negocio: `Eres un extractor de datos. A partir del mensaje del cliente, describe en pocas palabras cómo trabaja la persona, usando sus propias palabras o una versión corta y clara (ejemplos: "independiente", "salón propio", "trabaja a domicilio", "clínica de estética", "alquila silla en salón"). No te limites a categorías fijas, usa lo que el cliente realmente describió.

Si no aparece esa información, usa null.

Responde ÚNICAMENTE con un JSON válido en este formato, sin texto adicional antes o después, sin markdown, sin backticks:

{"tipo_negocio": "..."}`,
};

// Llama a la API de Kommo para actualizar el campo correspondiente del lead
async function actualizarLeadEnKommo(leadId, tipo, valor) {
  if (!valor) {
    return { skipped: true };
  }

  const fieldId = tipo === "nombre" ? CAMPO_NOMBRE_ID : CAMPO_TIPO_NEGOCIO_ID;

  const campos = [
    {
      field_id: fieldId,
      values: [{ value: valor }],
    },
  ];

  const kommoResponse = await fetch(
    `https://${KOMMO_DOMAIN}/api/v4/leads/${leadId}`,
    {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${KOMMO_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        custom_fields_values: campos,
      }),
    }
  );

  const kommoData = await kommoResponse.json();

  if (!kommoResponse.ok) {
    throw new Error(`Error de Kommo (${kommoResponse.status}): ${JSON.stringify(kommoData)}`);
  }

  return kommoData;
}

// Llama al endpoint de confirmación de ejecución del widget para avisarle
// a Kommo que el paso terminó y que continúe el flujo del Salesbot.
// Documentación: POST /api/v4/{bot}/{bot_id}/continue/{continue_id}
// Se autentica con el token de larga duración de la integración (KOMMO_TOKEN),
// NO con el JWT que viene en el body original.
// El body debe tener la forma { data: {...}, execute_handlers: [...] }
async function avisarAKommoQueContinue(returnUrl, datosParaElBot) {
  if (!returnUrl) {
    console.error("No hay return_url, el bot podría quedarse esperando.");
    return;
  }

  const body = {
    data: datosParaElBot,
    execute_handlers: [
      {
        handler: "goto",
        params: {
          type: "question",
          step: 1,
        },
      },
    ],
  };

  const resp = await fetch(returnUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${KOMMO_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error(`Error al llamar return_url (${resp.status}):`, txt);
  } else {
    console.log("return_url llamado correctamente, el bot debería continuar.");
  }
}

export default async function handler(req, res) {
  // Aceptamos tanto POST (con body JSON) como GET (con ?mensaje=...&lead_id=...&tipo=... en la URL)
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Método no permitido, usa POST o GET" });
  }

  try {
    // LOG DE DIAGNÓSTICO TEMPORAL: registra exactamente qué llegó
    console.log("=== DIAGNÓSTICO ===");
    console.log("Método:", req.method);
    console.log("Body completo:", JSON.stringify(req.body));
    console.log("Query completo:", JSON.stringify(req.query));
    console.log("===================");

    const mensajeCliente =
      (req.method === "POST"
        ? (req.body &&
           (req.body["data[message_text]"] ||
            req.body.message_text ||
            req.body.text ||
            (req.body.data && req.body.data.message_text)))
        : (req.query.mensaje || req.query.message_text || req.query.text)) || "";

    // El lead_id puede venir de varias formas según el origen de la llamada:
    // 1. Directo como lead_id (pruebas manuales)
    // 2. Dentro de additional_data.id (formato KWID)
    // 3. Decodificado del JWT "token" que manda widget_request (campo entity_id)
    let leadId =
      (req.method === "POST"
        ? (req.body &&
           (req.body.lead_id || (req.body.additional_data && req.body.additional_data.id)))
        : req.query.lead_id) || null;

    if (!leadId && req.method === "POST" && req.body && req.body.token) {
      try {
        const payloadBase64 = req.body.token.split(".")[1];
        const payloadJson = Buffer.from(payloadBase64, "base64").toString("utf8");
        const payload = JSON.parse(payloadJson);
        leadId = payload.entity_id || null;
      } catch (e) {
        console.error("No se pudo decodificar el token JWT:", e.message);
      }
    }

    const tipo =
      (req.method === "POST"
        ? (req.body && (req.body["data[tipo]"] || req.body.tipo || (req.body.data && req.body.data.tipo)))
        : req.query.tipo) || "";

    const returnUrl = req.method === "POST" ? req.body && req.body.return_url : null;
    const tokenOriginal = req.method === "POST" ? req.body && req.body.token : null;

    if (!mensajeCliente) {
      return res.status(400).json({
        error: "No se recibió texto del mensaje",
        body_recibido: req.body,
        query_recibido: req.query,
      });
    }

    if (!leadId) {
      return res.status(400).json({
        error: "No se recibió lead_id, no se puede guardar en Kommo",
        body_recibido: req.body,
        query_recibido: req.query,
      });
    }

    if (tipo !== "nombre" && tipo !== "negocio") {
      return res.status(400).json({
        error: 'El parámetro "tipo" debe ser "nombre" o "negocio"',
        tipo_recibido: tipo,
        body_recibido: req.body,
        query_recibido: req.query,
      });
    }

    const systemPrompt = PROMPTS[tipo];

    // Paso 1: mandamos el mensaje a Claude para extraer el dato correspondiente
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001", // rápido y económico, ideal para esta tarea
        max_tokens: 200,
        system: systemPrompt,
        messages: [
          { role: "user", content: `Mensaje del cliente: "${mensajeCliente}"` },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Error de la API de Claude:", data);
      return res.status(500).json({ error: "Error al llamar a Claude", detalle: data });
    }

    let textoRespuesta = data.content[0].text.trim();

    // A veces Claude envuelve el JSON en backticks de markdown (```json ... ```)
    // aunque se le pida no hacerlo. Lo limpiamos antes de parsear.
    textoRespuesta = textoRespuesta
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/, "")
      .replace(/```\s*$/, "")
      .trim();

    let resultado;
    try {
      resultado = JSON.parse(textoRespuesta);
    } catch (e) {
      console.error("Claude no devolvió JSON válido:", textoRespuesta);
      return res.status(500).json({ error: "Formato de respuesta inválido", crudo: textoRespuesta });
    }

    const valorExtraido = tipo === "nombre" ? resultado.nombre : resultado.tipo_negocio;

    // Paso 2: escribimos el resultado directamente en el lead de Kommo
    try {
      await actualizarLeadEnKommo(leadId, tipo, valorExtraido);
    } catch (kommoError) {
      console.error("Error al actualizar Kommo:", kommoError.message);
      const resultadoError = {
        ok: false,
        error: "No se pudo guardar en Kommo",
      };
      await avisarAKommoQueContinue(returnUrl, resultadoError);
      return res.status(500).json({
        error: "Claude extrajo el dato pero no se pudo guardar en Kommo",
        detalle: kommoError.message,
        dato_extraido: valorExtraido,
      });
    }

    const resultadoFinal = {
      ok: true,
      tipo: tipo,
      valor: valorExtraido || null,
      guardado_en_kommo: true,
    };

    // Avisamos a Kommo que el paso terminó, para que el bot continúe
    await avisarAKommoQueContinue(returnUrl, resultadoFinal);

    return res.status(200).json(resultadoFinal);

  } catch (error) {
    console.error("Error general en el webhook:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
}

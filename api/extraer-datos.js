// Webhook Mundibelleza — Extrae nombre y tipo de negocio con Claude
// y los escribe directamente en el lead de Kommo vía API.
// Versión para Vercel (función serverless)
// Esta función vive en /api/extraer-datos.js y Vercel la expone
// automáticamente en: https://tu-proyecto.vercel.app/api/extraer-datos

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const KOMMO_TOKEN = process.env.KOMMO_TOKEN;
const KOMMO_DOMAIN = "comundibelleza.kommo.com";

// IDs de los campos personalizados en Kommo (Configuración → Campos personalizados)
const CAMPO_NOMBRE_ID = 1288972; // "Nombre cliente (IA)" — tipo texto
const CAMPO_TIPO_NEGOCIO_ID = 1288974; // "Tipo de negocio" — tipo lista (select)

// IDs de las opciones dentro del campo "Tipo de negocio"
const OPCION_INDEPENDIENTE_ID = 935436;
const OPCION_SALON_ID = 935438;

const SYSTEM_PROMPT = `Eres un extractor de datos. A partir del mensaje del cliente, extrae dos datos:

1. nombre: el nombre de pila de la persona (solo el nombre, sin apellidos ni frases adicionales)
2. tipo_negocio: clasifica como "independiente" si trabaja por su cuenta, o "salon" si menciona tener salón, local o equipo de trabajo

Si algún dato no aparece en el mensaje, usa null para ese campo.

Responde ÚNICAMENTE con un JSON válido en este formato, sin texto adicional antes o después, sin markdown, sin backticks:

{"nombre": "...", "tipo_negocio": "..."}`;

// Llama a la API de Kommo para actualizar los campos del lead
async function actualizarLeadEnKommo(leadId, nombre, tipoNegocio) {
  const campos = [];

  if (nombre) {
    campos.push({
      field_id: CAMPO_NOMBRE_ID,
      values: [{ value: nombre }],
    });
  }

  if (tipoNegocio === "independiente" || tipoNegocio === "salon") {
    const enumId = tipoNegocio === "independiente" ? OPCION_INDEPENDIENTE_ID : OPCION_SALON_ID;
    campos.push({
      field_id: CAMPO_TIPO_NEGOCIO_ID,
      values: [{ enum_id: enumId }],
    });
  }

  if (campos.length === 0) {
    return { skipped: true };
  }

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

export default async function handler(req, res) {
  // Aceptamos tanto POST (con body JSON) como GET (con ?mensaje=...&lead_id=... en la URL)
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Método no permitido, usa POST o GET" });
  }

  try {
    const mensajeCliente =
      (req.method === "POST"
        ? (req.body && (req.body.message_text || req.body.text))
        : (req.query.mensaje || req.query.message_text || req.query.text)) || "";

    const leadId =
      (req.method === "POST"
        ? (req.body && req.body.lead_id)
        : req.query.lead_id) || null;

    if (!mensajeCliente) {
      return res.status(400).json({ error: "No se recibió texto del mensaje" });
    }

    if (!leadId) {
      return res.status(400).json({ error: "No se recibió lead_id, no se puede guardar en Kommo" });
    }

    // Paso 1: mandamos el mensaje a Claude para extraer los datos
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
        system: SYSTEM_PROMPT,
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

    // Paso 2: escribimos el resultado directamente en el lead de Kommo
    try {
      await actualizarLeadEnKommo(leadId, resultado.nombre, resultado.tipo_negocio);
    } catch (kommoError) {
      console.error("Error al actualizar Kommo:", kommoError.message);
      return res.status(500).json({
        error: "Claude extrajo los datos pero no se pudieron guardar en Kommo",
        detalle: kommoError.message,
        datos_extraidos: resultado,
      });
    }

    return res.status(200).json({
      ok: true,
      nombre: resultado.nombre || null,
      tipo_negocio: resultado.tipo_negocio || null,
      guardado_en_kommo: true,
    });

  } catch (error) {
    console.error("Error general en el webhook:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
}

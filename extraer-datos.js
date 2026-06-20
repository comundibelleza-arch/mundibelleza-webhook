// Webhook Mundibelleza — Extrae nombre y tipo de negocio con Claude
// Versión para Vercel (función serverless)
// Esta función vive en /api/extraer-datos.js y Vercel la expone
// automáticamente en: https://tu-proyecto.vercel.app/api/extraer-datos

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = `Eres un extractor de datos. A partir del mensaje del cliente, extrae dos datos:

1. nombre: el nombre de pila de la persona (solo el nombre, sin apellidos ni frases adicionales)
2. tipo_negocio: clasifica como "independiente" si trabaja por su cuenta, o "salon" si menciona tener salón, local o equipo de trabajo

Si algún dato no aparece en el mensaje, usa null para ese campo.

Responde ÚNICAMENTE con un JSON válido en este formato, sin texto adicional antes o después, sin markdown, sin backticks:

{"nombre": "...", "tipo_negocio": "..."}`;

export default async function handler(req, res) {
  // Solo aceptamos POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido, usa POST" });
  }

  try {
    const mensajeCliente = req.body.message_text || req.body.text || "";

    if (!mensajeCliente) {
      return res.status(400).json({ error: "No se recibió texto del mensaje" });
    }

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

    const textoRespuesta = data.content[0].text.trim();

    let resultado;
    try {
      resultado = JSON.parse(textoRespuesta);
    } catch (e) {
      console.error("Claude no devolvió JSON válido:", textoRespuesta);
      return res.status(500).json({ error: "Formato de respuesta inválido", crudo: textoRespuesta });
    }

    return res.status(200).json({
      nombre: resultado.nombre || null,
      tipo_negocio: resultado.tipo_negocio || null,
    });

  } catch (error) {
    console.error("Error general en el webhook:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
}

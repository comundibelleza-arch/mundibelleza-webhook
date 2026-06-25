// api/enviar_catalogo.js

const KOMMO_TOKEN = process.env.KOMMO_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_TOKEN = process.env.WA_TOKEN;
const CATALOG_ID = process.env.CATALOG_ID;
const KOMMO_SUBDOMAIN = "comundibelleza";
const TEMPLATE_NAME = "catalogo_unas";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // ─── 1. LEER DATOS DE KOMMO ───────────────────────────────────────
    const phone = req.body["data[phone]"];
    const returnUrl = req.body["return_url"];

    const payloadBase64 = req.body.token.split(".")[1];
    const payload = JSON.parse(
      Buffer.from(payloadBase64, "base64").toString("utf8")
    );
    const leadId = payload.entity_id;

    if (!phone || !leadId || !returnUrl) {
      return res.status(400).json({ error: "Faltan datos requeridos" });
    }

    const cleanPhone = phone.replace(/\D/g, "");

    // ─── 2. ENVIAR TEMPLATE DE WHATSAPP CON CATÁLOGO ─────────────────
    let waSuccess = false;
    let waError = "";

    const waResponse = await fetch(
      `https://graph.facebook.com/v19.0/${WA_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${WA_TOKEN}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: cleanPhone,
          type: "template",
          template: {
            name: TEMPLATE_NAME,
            language: { code: "es" },
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: cleanPhone },
                  { type: "text", text: "Cliente" },
                ],
              },
              {
                type: "button",
                sub_type: "catalog",
                index: "0",
                parameters: [
                  { type: "catalog_id", catalog_id: CATALOG_ID },
                ],
              },
            ],
          },
        }),
      }
    );

    const waData = await waResponse.json();

    if (waResponse.ok) {
      waSuccess = true;
    } else {
      waError = JSON.stringify(waData);
    }

    // ─── 3. AGREGAR NOTA EN KOMMO ─────────────────────────────────────
    const noteText = waSuccess
      ? `✅ Catálogo enviado por WhatsApp al número ${phone}`
      : `❌ Error enviando catálogo: ${waError}`;

    await fetch(
      `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/leads/notes`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${KOMMO_TOKEN}`,
        },
        body: JSON.stringify([
          {
            entity_id: leadId,
            note_type: "common",
            params: { text: noteText },
          },
        ]),
      }
    );

    // ─── 4. AVISAR A KOMMO QUE EL BOT CONTINÚE ───────────────────────
    await fetch(returnUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${KOMMO_TOKEN}`,
      },
      body: JSON.stringify({
        data: {
          ok: waSuccess ? "true" : "false",
        },
        execute_handlers: [
          { handler: "goto", params: { type: "question", step: 1 } },
        ],
      }),
    });

    return res.status(200).json({ ok: true });

  } catch (error) {
    console.error("Error en enviar_catalogo:", error);
    return res.status(500).json({ ok: false, error: error.message });
  }
};

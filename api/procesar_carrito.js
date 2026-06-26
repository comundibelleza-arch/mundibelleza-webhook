const KOMMO_TOKEN = process.env.KOMMO_TOKEN;
const KOMMO_SUBDOMAIN = "comundibelleza";

module.exports = async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {

    //────────────────────────────────────────────
    // 1. OBTENER LEAD ID
    //────────────────────────────────────────────

    const returnUrl = req.body["return_url"];

    const payloadBase64 = req.body.token.split(".")[1];
    const payload = JSON.parse(
      Buffer.from(payloadBase64, "base64").toString("utf8")
    );

    const leadId = payload.entity_id;

    if (!leadId) {
      return res.status(400).json({
        error: "No se recibió el Lead ID"
      });
    }

    //────────────────────────────────────────────
    // 2. CONSULTAR EVENTS_TIMELINE
    //────────────────────────────────────────────

    const response = await fetch(
      `https://${KOMMO_SUBDOMAIN}.kommo.com/ajax/v3/leads/${leadId}/events_timeline/?limit=100`,
      {
        headers: {
          Authorization: `Bearer ${KOMMO_TOKEN}`
        }
      }
    );

    const timeline = await response.json();

    //────────────────────────────────────────────
    // 3. BUSCAR EL ÚLTIMO CARRITO
    //────────────────────────────────────────────

    let carrito = null;

    if (timeline._embedded?.items) {

      for (let i = timeline._embedded.items.length - 1; i >= 0; i--) {

        const item = timeline._embedded.items[i];

        if (
          item.data?.message_attributes?.waba?.products_message?.type === "order"
        ) {
          carrito = item;
          break;
        }

      }

    }

    if (!carrito) {

      return res.status(404).json({
        ok: false,
        mensaje: "No se encontró ningún carrito."
      });

    }

    //────────────────────────────────────────────
    // 4. RESPONDER
    //────────────────────────────────────────────

    return res.status(200).json({

      ok: true,

      lead_id: leadId,

      carrito: carrito.data.message_attributes.waba.products_message

    });

  } catch (error) {

    console.error(error);

    return res.status(500).json({
      ok: false,
      error: error.message
    });

  }

};

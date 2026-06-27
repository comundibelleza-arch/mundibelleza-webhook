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

    const leadId = req.body["message[add][0][entity_id]"];

    if (!leadId) {
      return res.status(400).json({
        ok: false,
        error: "No se recibió el Lead ID"
      });
    }

    //────────────────────────────────────────────
    // 2. CONSULTAR EVENTS_TIMELINE
    //────────────────────────────────────────────

    const response = await fetch(
      `https://${KOMMO_SUBDOMAIN}.kommo.com/ajax/v3/leads/${leadId}/events_timeline/?limit=100`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${KOMMO_TOKEN}`
        }
      }
    );

    if (!response.ok) {
      throw new Error("Error consultando events_timeline");
    }

    const timeline = await response.json();

    //────────────────────────────────────────────
    // 3. BUSCAR EL ÚLTIMO PEDIDO
    //────────────────────────────────────────────

    let pedido = null;

    if (timeline._embedded?.items) {

      for (let i = timeline._embedded.items.length - 1; i >= 0; i--) {

        const item = timeline._embedded.items[i];

        if (
          item.data?.message_attributes?.waba?.products_message?.type === "order"
        ) {
          pedido = item;
          break;
        }

      }

    }

    // Si no encontró carrito simplemente termina.
    if (!pedido) {

      return res.status(200).json({
        ok: true,
        mensaje: "No hay carrito en este mensaje."
      });

    }

    //────────────────────────────────────────────
    // 4. EXTRAER TODOS LOS PRODUCTOS
    //────────────────────────────────────────────

    const sets =
      pedido.data.message_attributes.waba.products_message.sets || [];

    const productos = [];

    sets.forEach(set => {

      (set.products || []).forEach(producto => {

        productos.push({
          sku: producto.id,
          cantidad: producto.quantity,
          precio: producto.price.value,
          moneda: producto.price.currency
        });

      });

    });

    //────────────────────────────────────────────
    // 5. RESPUESTA
    //────────────────────────────────────────────

    return res.status(200).json({

      ok: true,
      lead_id: leadId,
      productos,
      pedido_original: pedido

    });

  } catch (error) {

    console.error("Error en procesar_carrito:", error);

    return res.status(500).json({
      ok: false,
      error: error.message
    });

  }

};

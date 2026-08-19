// api/agente-ventas-blackhair.js
//
// *** VERSIÓN DE PRUEBA MÍNIMA — NO ES LA VERSIÓN FINAL ***
//
// El único objetivo de este archivo es confirmar si el mecanismo de
// entrega (return_url + execute_handlers "show") realmente le hace llegar
// un mensaje al cliente por WhatsApp. No lee nada de Kommo, no guarda
// nada, no usa reglas ni LLM — apenas se activa el widget, intenta mandar
// la palabra "hola".
//
// CÓMO USARLO:
//  1. Sube este archivo a Vercel reemplazando temporalmente el contenido
//     de api/agente-ventas-blackhair.js (mismo nombre de archivo, mismo
//     endpoint — así no hay que tocar la URL del widget en Kommo).
//  2. Escríbele al bot como el cliente de prueba.
//  3. Revisa dos cosas: ¿llegó "hola" al WhatsApp del cliente? y en los
//     Logs de Vercel, ¿qué dice la línea "PRUEBA hola: ..."? Ahí vas a ver
//     el body completo que mandó Kommo (útil para confirmar si return_url
//     sí viene) y la respuesta completa de la llamada a return_url (antes
//     solo logueábamos cuando fallaba; aquí también logueamos cuando sale
//     bien, para ver el detalle completo).
//  4. Cuando termines la prueba, vuelve a subir la versión completa (la
//     que ya tienes con reglas + LLM + guardado en Kommo) — este archivo
//     es solo para depurar, no reemplaza la lógica real del agente.
const KOMMO_TOKEN = process.env.KOMMO_TOKEN;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido, usa POST" });
  }
  try {
    console.log("PRUEBA hola: body recibido =", JSON.stringify(req.body));

    const returnUrl = req.body && req.body.return_url;
    if (!returnUrl) {
      console.error("PRUEBA hola: no llegó return_url en el body — revisa el log de arriba para ver qué sí llegó.");
      return res.status(200).json({ ok: true, accion: "seguir", mensaje: "hola" });
    }

    const body = {
      data: { mensaje: "hola", accion: "seguir" },
      execute_handlers: [{ handler: "show", params: { type: "text", value: "hola" } }],
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
      console.error(`PRUEBA hola: return_url respondió con error (${resp.status}):`, textoResp);
    } else {
      console.log(`PRUEBA hola: return_url respondió OK (${resp.status}):`, textoResp);
    }

    return res.status(200).json({ ok: true, accion: "seguir", mensaje: "hola" });
  } catch (error) {
    console.error("PRUEBA hola: error general:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
};

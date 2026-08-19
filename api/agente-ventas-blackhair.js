// api/agente-ventas-blackhair.js
//
// *** VERSIÓN DE PRUEBA — confirma si return_url se puede llamar más de
// una vez para espaciar mensajes en el tiempo ***
//
// Contexto: las respuestas largas del bot se parten en varias burbujas de
// WhatsApp (límite real de Kommo: 80 caracteres por "show"). Todas esas
// burbujas hoy se mandan juntas en UNA sola llamada a return_url, dentro
// del mismo array execute_handlers — y a veces llegan a WhatsApp en orden
// distinto al que se mandaron. La documentación oficial de Kommo no tiene
// ningún handler de "espera"/delay dentro de execute_handlers (solo existen
// "show" y "goto"), así que la única forma de meter un delay real sería
// mandar cada burbuja en su PROPIA llamada a return_url, con una pausa
// entre cada una.
//
// El problema: no sabemos si Kommo permite llamar return_url más de una
// vez. Es razonable pensar que continue_id es de un solo uso (como un
// token que se "gasta"), en cuyo caso la 2ª y 3ª llamada fallarían y esos
// mensajes nunca llegarían al cliente. Este archivo es solo para confirmar
// eso con datos reales, antes de invertir tiempo en reescribir la lógica
// completa del agente sobre un supuesto que podría ser falso.
//
// CÓMO USARLO:
//  1. Sube este archivo reemplazando temporalmente el contenido de
//     api/agente-ventas-blackhair.js (mismo endpoint, no hay que tocar la
//     URL del widget en Kommo).
//  2. Escríbele al bot como el cliente de prueba, cualquier mensaje.
//  3. Revisa DOS cosas:
//     a) En WhatsApp: ¿llegaron los 3 mensajes ("Mensaje de prueba 1/2/3")?
//        ¿en qué orden? ¿con separación notoria en el tiempo o casi juntos
//        igual que antes?
//     b) En los Logs de Vercel: busca las líneas "PRUEBA delay: intento 1",
//        "intento 2", "intento 3" — cada una muestra el status HTTP y el
//        cuerpo completo de la respuesta de esa llamada a return_url. Si la
//        2ª o 3ª llamada falla, ahí vas a ver el error exacto (por ejemplo
//        un 404/410/400 indicando que el continue_id ya se usó).
//  4. Cuéntame qué viste en los logs y en WhatsApp, y con eso decidimos:
//     - Si las 3 llamadas funcionan y el orden mejora: se puede llevar este
//       patrón a la versión completa del agente.
//     - Si la 2ª/3ª llamada falla: confirmamos que no es posible por esta
//       vía, y hay que buscar otra alternativa (o aceptar el desorden
//       ocasional como una limitación conocida de la plataforma).
//  5. Cuando termines la prueba, vuelve a subir la versión completa del
//     agente — este archivo es solo para depurar, no reemplaza la lógica
//     real de ventas.
const KOMMO_TOKEN = process.env.KOMMO_TOKEN;

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function llamarReturnUrl(returnUrl, mensaje, numeroIntento) {
  const body = {
    data: { mensaje, accion: "seguir" },
    execute_handlers: [{ handler: "show", params: { type: "text", value: mensaje } }],
  };
  const resp = await fetch(returnUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KOMMO_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const texto = await resp.text();
  console.log(
    `PRUEBA delay: intento ${numeroIntento} -> status ${resp.status}, respuesta:`,
    texto
  );
  return resp.ok;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido, usa POST" });
  }
  try {
    console.log("PRUEBA delay: body recibido =", JSON.stringify(req.body));

    const returnUrl = req.body && req.body.return_url;
    if (!returnUrl) {
      console.error("PRUEBA delay: no llegó return_url en el body.");
      return res.status(200).json({ ok: true, accion: "seguir" });
    }

    // 3 llamadas separadas al MISMO return_url, con ~600ms entre cada una.
    // Si Kommo rechaza la 2ª o 3ª llamada, va a quedar clarísimo en los
    // logs (status distinto de 2xx + el detalle del error).
    const ok1 = await llamarReturnUrl(returnUrl, "Mensaje de prueba 1", 1);
    await esperar(600);
    const ok2 = await llamarReturnUrl(returnUrl, "Mensaje de prueba 2", 2);
    await esperar(600);
    const ok3 = await llamarReturnUrl(returnUrl, "Mensaje de prueba 3", 3);

    console.log("PRUEBA delay: resumen ->", { ok1, ok2, ok3 });

    return res.status(200).json({ ok: true, resumen: { ok1, ok2, ok3 } });
  } catch (error) {
    console.error("PRUEBA delay: error general:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
};

const AGE_GATE_RE = /Sign in to confirm your age|age-restricted|age restricted|LOGIN_REQUIRED/i;

// Videos que ya no se pueden reproducir (canal terminated, borrado, privado...).
// No son un error del bot: se saltan y la cola sigue con el resto.
const UNAVAILABLE_RE =
  /no longer available|account associated with this video has been terminated|video is private|has been removed|removed by the uploader|unavailable|terminated|blocked it in your country|not available in your country/i;

function isUnavailableVideoError(e) {
  return UNAVAILABLE_RE.test(String(e?.message || e || ""));
}

function friendlyUnavailableError(e) {
  const msg = String(e?.message || e || "");
  if (/has been terminated/i.test(msg)) return "el canal de YouTube de este video fue termina";
  if (/video is private/i.test(msg)) return "el video es privado";
  if (/has been removed|removed by the uploader/i.test(msg)) return "el video fue eliminado por su autor";
  if (/not available in your country|blocked it in your country/i.test(msg)) return "el video no está disponible en tu país";
  return "el video ya no está disponible";
}

function isAgeGateError(e) {
  return AGE_GATE_RE.test(String(e?.message || e || ""));
}

function friendlyPlaybackError(e) {
  const msg = String(e?.message || e || "");
  if (AGE_GATE_RE.test(msg)) {
    return (
      "Este video está restringido por edad y YouTube rechazó la sesión de cookies del bot.\n" +
      "Regenera el archivo `yt-cookies.txt` con cookies de una cuenta que SÍ pueda ver el video " +
      "(expórtalas desde una ventana de **incógnito** y ciérrala al terminar para que YouTube no las rote), " +
      "o define `YOUTUBE_COOKIE` en `.env` y ejecuta `node tools/convert-cookies.js`."
    );
  }
  return msg;
}

module.exports = { isAgeGateError, friendlyPlaybackError, isUnavailableVideoError, friendlyUnavailableError };
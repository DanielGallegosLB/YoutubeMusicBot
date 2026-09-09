const AGE_GATE_RE = /Sign in to confirm your age|age-restricted|age restricted|LOGIN_REQUIRED/i;

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

module.exports = { isAgeGateError, friendlyPlaybackError };
// Trilha de auditoria (quem fez o quê, quando e de onde). Nunca derruba a operação principal.
const { pool } = require("./db");

async function registrar({ usuario, papel, acao, chamado_id, anexo_id, alvo, detalhe, ip } = {}) {
  try {
    await pool.query(
      "INSERT INTO ch_auditoria (usuario, papel, acao, chamado_id, anexo_id, alvo, detalhe, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [usuario ? String(usuario).slice(0, 160) : null, papel || null, acao, chamado_id || null, anexo_id || null, alvo ? String(alvo).slice(0, 160) : null, detalhe ? String(detalhe).slice(0, 300) : null, ip ? String(ip).slice(0, 64) : null]
    );
  } catch (e) {
    console.error("[auditoria] não registrou:", e.message);
  }
}
module.exports = { registrar };

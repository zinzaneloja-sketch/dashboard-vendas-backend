// Tempo em MINUTOS ÚTEIS (só conta o expediente). Sem isso, toda nota que termina uma etapa às
// 17h30 apareceria como "parada 14h" na manhã seguinte e o painel viraria um alarme falso.
// Configurável por variável de ambiente (padrão: seg–sáb, 08:00–18:00, horário de Brasília,
// que não tem horário de verão desde 2019, então o deslocamento fixo de -3h está correto).
const OFFSET_MS = -3 * 3600 * 1000;
const DAY = 86400000;

function parseHM(v, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || fallback));
  const [h, mi] = m ? [Number(m[1]), Number(m[2])] : parseHM(fallback, fallback);
  return h * 60 + mi;
}

const INI = parseHM(process.env.CD_EXPEDIENTE_INICIO, "08:00");
const FIM = parseHM(process.env.CD_EXPEDIENTE_FIM, "18:00");
const DIAS = String(process.env.CD_DIAS_UTEIS || "1,2,3,4,5,6").split(",").map((x) => Number(x.trim())).filter((x) => x >= 0 && x <= 6);

function minutosUteis(a, b) {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (!(tb > ta)) return 0;
  const la = ta + OFFSET_MS;
  const lb = tb + OFFSET_MS;
  let total = 0;
  let guard = 0;
  for (let d = Math.floor(la / DAY) * DAY; d <= lb && guard < 400; d += DAY, guard++) {
    if (!DIAS.includes(new Date(d).getUTCDay())) continue;
    const s = Math.max(d + INI * 60000, la);
    const e = Math.min(d + FIM * 60000, lb);
    if (e > s) total += (e - s) / 60000;
  }
  return Math.round(total * 10) / 10;
}

/** Data (YYYY-MM-DD) no fuso de Brasília. */
function diaLocal(d) {
  return new Date(new Date(d).getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

module.exports = { minutosUteis, diaLocal, expediente: { inicioMin: INI, fimMin: FIM, dias: DIAS } };

// Segurança de borda do servidor: limite de tentativas de login, cabeçalhos de segurança e CORS.
// Sem dependências externas (tudo em memória e Express puro).
const cors = require("cors");

// ---------- limite de tentativas de login ----------
// Por e-mail+IP: LIMITE_CONTA falhas em JANELA_MS bloqueiam aquela combinação por BLOQUEIO_MS.
// Por IP: LIMITE_IP falhas na janela bloqueiam o IP (barra quem testa muitos e-mails).
// Em memória: reiniciar o servidor zera a contagem (aceitável: o atacante perde o progresso, não ganha nada).
const JANELA_MS = 15 * 60 * 1000;
const BLOQUEIO_MS = 15 * 60 * 1000;
const LIMITE_CONTA = Number(process.env.LOGIN_MAX_TENTATIVAS) || 5;
const LIMITE_IP = Number(process.env.LOGIN_MAX_TENTATIVAS_IP) || 30;

const contas = new Map(); // chave -> { falhas, desde, bloqueadoAte }
const ips = new Map();

function entrada(mapa, chave) {
  const agora = Date.now();
  let e = mapa.get(chave);
  if (!e || (!e.bloqueadoAte && agora - e.desde > JANELA_MS) || (e.bloqueadoAte && agora > e.bloqueadoAte)) {
    e = { falhas: 0, desde: agora, bloqueadoAte: 0 };
    mapa.set(chave, e);
  }
  return e;
}
const chaveConta = (ip, email) => `${ip}|${String(email || "").trim().toLowerCase()}`;

/** Quantos segundos faltam para poder tentar de novo (0 = liberado). */
function esperaLogin(ip, email) {
  const agora = Date.now();
  const a = contas.get(chaveConta(ip, email)), b = ips.get(ip);
  const fim = Math.max(a && a.bloqueadoAte > agora ? a.bloqueadoAte : 0, b && b.bloqueadoAte > agora ? b.bloqueadoAte : 0);
  return fim ? Math.ceil((fim - agora) / 1000) : 0;
}
/** Registra uma falha; devolve true se com ela a combinação acabou de ser bloqueada. */
function falhaLogin(ip, email) {
  const a = entrada(contas, chaveConta(ip, email)), b = entrada(ips, ip);
  a.falhas++; b.falhas++;
  let novo = false;
  if (a.falhas >= LIMITE_CONTA && !a.bloqueadoAte) { a.bloqueadoAte = Date.now() + BLOQUEIO_MS; novo = true; }
  if (b.falhas >= LIMITE_IP && !b.bloqueadoAte) { b.bloqueadoAte = Date.now() + BLOQUEIO_MS; novo = true; }
  return novo;
}
function sucessoLogin(ip, email) { contas.delete(chaveConta(ip, email)); }
function erroBloqueio(seg) {
  const e = new Error(`Muitas tentativas. Aguarde ${Math.ceil(seg / 60)} minuto(s) e tente de novo.`);
  e.status = 429; e.retryAfter = seg;
  return e;
}
setInterval(() => { // limpeza
  const agora = Date.now();
  for (const m of [contas, ips]) for (const [k, e] of m) if ((e.bloqueadoAte && agora > e.bloqueadoAte) || (!e.bloqueadoAte && agora - e.desde > JANELA_MS)) m.delete(k);
}, 5 * 60 * 1000).unref();

// ---------- cabeçalhos de segurança ----------
function cabecalhos(req, res, next) {
  res.removeHeader("X-Powered-By");
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Strict-Transport-Security": "max-age=15552000; includeSubDomains",
    "Cross-Origin-Resource-Policy": "cross-origin", // a API é lida pelas páginas em outro domínio
  });
  // respostas de login, usuário e chamados nunca ficam em cache (dados pessoais)
  if (req.path.startsWith("/api/auth") || req.path.startsWith("/api/chamados")) res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });
  next();
}

// ---------- CORS ----------
// CORS_ORIGINS="https://painel.exemplo.com,https://outro.exemplo.com" restringe os sites que podem chamar a API.
// Sem a variável, continua aberto (como antes) e avisa no log.
function opcoesCors() {
  const lista = String(process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  if (!lista.length) {
    console.warn("[seguranca] CORS_ORIGINS não configurado — a API aceita chamadas de qualquer site. Defina CORS_ORIGINS com o endereço das suas páginas.");
    return {};
  }
  return {
    origin(origin, cb) { cb(null, !origin || lista.includes(String(origin).replace(/\/+$/, ""))); }, // sem Origin = chamada direta (curl, servidor): CORS não se aplica
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 600,
  };
}
const corsMiddleware = () => cors(opcoesCors());

module.exports = { esperaLogin, falhaLogin, sucessoLogin, erroBloqueio, cabecalhos, corsMiddleware, opcoesCors, LIMITE_CONTA };

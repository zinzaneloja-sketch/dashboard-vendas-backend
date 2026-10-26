// E-mail de cópia dos chamados (Resend). Falha de e-mail NUNCA derruba o chamado: tudo fica registrado em ch_emails
// (enviado / falhou / pulado) e o DP pode reenviar. Variáveis de ambiente:
//   RESEND_API_KEY          chave da conta Resend (sem ela os e-mails ficam como "pulado")
//   CHAMADOS_EMAIL_FROM     remetente no domínio verificado no Resend, ex.: "DP Zinzane <dp@zinzane.com.br>"
//   CHAMADOS_URL            endereço da página do painel, ex.: https://zinzaneonline.com.br/chamados-zinzane.html
//   CHAMADOS_DP_EMAIL       (opcional) e-mail(s) do departamento DP separados por vírgula; cada departamento também tem os seus e-mails no painel (Cadastros → E-mails)
const { pool } = require("../db");

const esc = (s) => String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const emailValido = (e) => EMAIL_RE.test(String(e || "").trim()) && String(e).length <= 160;

function dh(d) {
  if (!d) return "—";
  const x = new Date(new Date(d).getTime() - 3 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(x.getUTCDate())}/${p(x.getUTCMonth() + 1)}/${x.getUTCFullYear()} ${p(x.getUTCHours())}:${p(x.getUTCMinutes())}`;
}
function fmtMin(m) {
  if (m === null || m === undefined) return "—";
  const h = m / 60;
  if (h < 1) return `${Math.round(m)} min úteis`;
  if (h < 10) return `${String(Math.round(h * 10) / 10).replace(".", ",")} h úteis`;
  const dias = Math.round((m / 600) * 10) / 10;
  return `${String(dias).replace(".", ",")} dia(s) útil(eis)`;
}
const STATUS_ROT = { aberto: "Aberto", em_atendimento: "Em atendimento", aguardando_loja: "Aguardando resposta da loja", resolvido: "Resolvido", cancelado: "Cancelado" };

function linkChamado(id) {
  const base = String(process.env.CHAMADOS_URL || "").trim();
  return base ? `${base.replace(/#.*$/, "")}#chamado/${id}` : "";
}

// ---------- layout ----------
function layout(titulo, blocos, link) {
  const corpo = blocos.map((b) => b.html).join("");
  const texto = [titulo, "", ...blocos.map((b) => b.texto), link ? `\nAbrir no painel: ${link}` : "", "\nPara responder, use o painel de chamados (esta mensagem é só uma cópia para acompanhamento)."].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f6;font-family:Arial,Helvetica,sans-serif;color:#1d1d1f">
<div style="max-width:620px;margin:0 auto;padding:20px">
<div style="font-size:13px;letter-spacing:.2em;font-weight:700;color:#a3274f;margin:0 0 10px">ZINZANE &amp; CO. · CHAMADOS ZINZANE</div>
<div style="background:#fff;border-radius:14px;padding:22px;border:1px solid #e3e3e8">
<h2 style="margin:0 0 14px;font-size:18px">${esc(titulo)}</h2>${corpo}
${link ? `<p style="margin:20px 0 0"><a href="${esc(link)}" style="background:#a3274f;color:#fff;text-decoration:none;padding:11px 18px;border-radius:10px;font-weight:700;display:inline-block">Abrir no painel</a></p>` : ""}
</div>
<p style="font-size:12px;color:#6b6b73;margin:14px 4px">Para responder, use o painel de chamados. Esta mensagem é uma cópia para acompanhamento; responder este e-mail não atualiza o chamado.</p>
</div></body></html>`;
  return { html, texto };
}
const par = (rot, val) => ({ html: `<p style="margin:0 0 8px;font-size:14px"><b>${esc(rot)}:</b> ${esc(val)}</p>`, texto: `${rot}: ${val}` });
const caixa = (rot, val) => ({ html: `<div style="margin:12px 0;padding:12px 14px;background:#f7f7f9;border-left:4px solid #a3274f;border-radius:6px;font-size:14px;line-height:1.5"><div style="font-size:12px;color:#6b6b73;margin-bottom:4px">${esc(rot)}</div>${esc(val).replace(/\n/g, "<br>")}</div>`, texto: `\n${rot}:\n${val}\n` });

const aviso = () => par("Conteúdo", "Por segurança, o texto e os anexos do chamado não vão por e-mail. Abra o painel e entre com o seu login para ler.");
const depto = (ch) => ch.departamento_nome || "o departamento";
function dadosChamado(ch) {
  return [par("Protocolo", ch.protocolo), par("Departamento", ch.departamento_nome || "—"), par("Loja", ch.loja_nome), par("Status", STATUS_ROT[ch.status] || ch.status),
    ...(ch.prioridade === "urgente" ? [par("Prioridade", "Urgente")] : [])];
}

// monta os e-mails de cada evento
function montar(tipo, ch, extra = {}) {
  const link = linkChamado(ch.id);
  const assunto = (t) => `[${ch.protocolo}] ${t}`;
  if (tipo === "abertura_loja") {
    const l = layout("Recebemos o seu chamado", [...dadosChamado(ch), par("Aberto em", dh(ch.criado_em)), par("Prazo da 1ª resposta", fmtMin(ch.sla_resposta_min)), par("Prazo de resolução", fmtMin(ch.sla_resolucao_min)), aviso()], link);
    return { assunto: assunto("Chamado aberto"), ...l };
  }
  if (tipo === "abertura_dp") {
    const l = layout(`Novo chamado de loja para ${depto(ch)}`, [...dadosChamado(ch), par("Aberto por", ch.aberto_por), par("Prazo da 1ª resposta", fmtMin(ch.sla_resposta_min)), aviso()], link);
    return { assunto: assunto("Novo chamado") + ` · ${ch.loja_nome}`, ...l };
  }
  if (tipo === "resposta_dp") {
    const resolvido = ch.status === "resolvido";
    const l = layout(resolvido ? "Seu chamado foi resolvido" : `Resposta de ${depto(ch)} ao seu chamado`, [...dadosChamado(ch), par("Respondido por", extra.autor || depto(ch)), aviso(),
      ...(ch.status === "aguardando_loja" ? [par("Atenção", "O departamento aguarda a sua resposta no painel para continuar o atendimento.")] : []),
      ...(resolvido ? [par("Se não resolveu", "responda pelo painel em até 7 dias que o chamado é reaberto.")] : []),
      ...((extra.anexos || []).length ? [par("Anexos", extra.anexos.length + " arquivo(s) no painel")] : [])], link);
    return { assunto: assunto(resolvido ? "Resolvido" : `Resposta de ${depto(ch)}`), ...l };
  }
  if (tipo === "resposta_loja") {
    const l = layout("A loja respondeu ao chamado", [...dadosChamado(ch), par("Respondido por", extra.autor || ch.loja_nome), aviso(), ...(extra.reaberto ? [par("Atenção", "Chamado reaberto pela loja.")] : []),
      ...((extra.anexos || []).length ? [par("Anexos", extra.anexos.length + " arquivo(s) no painel")] : [])], link);
    return { assunto: assunto(extra.reaberto ? "Chamado reaberto" : "Loja respondeu") + ` · ${ch.loja_nome}`, ...l };
  }
  if (tipo === "cancelamento") {
    const l = layout("Chamado cancelado", [...dadosChamado(ch)], link);
    return { assunto: assunto("Cancelado"), ...l };
  }
  throw new Error("Tipo de e-mail desconhecido: " + tipo);
}

// ---------- envio ----------
async function chamarResend({ from, to, subject, html, text, replyTo }) {
  if (typeof fetch !== "function") throw new Error("Este servidor não tem fetch (use Node 18+).");
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 10000);
  try {
    const body = { from, to, subject, html, text };
    if (replyTo) body.reply_to = replyTo;
    const r = await fetch("https://api.resend.com/emails", { method: "POST", signal: ctl.signal, headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Resend ${r.status}: ${j.message || j.error || "erro ao enviar"}`);
    return j.id || null;
  } finally { clearTimeout(tm); }
}

// quem é avisado quando chega um chamado de um departamento: os e-mails cadastrados para ele (e, no DP, também CHAMADOS_DP_EMAIL)
async function destinosDepto(deptId) {
  const out = new Set();
  try {
    const { rows } = await pool.query("SELECT codigo, emails FROM ch_departamentos WHERE id = $1", [Number(deptId) || 0]);
    if (rows[0]) {
      String(rows[0].emails || "").split(/[,;\s]+/).filter(emailValido).forEach((e) => out.add(e.toLowerCase()));
      if (rows[0].codigo === "dp") String(process.env.CHAMADOS_DP_EMAIL || "").split(/[,;\s]+/).filter(emailValido).forEach((e) => out.add(e.toLowerCase()));
    }
  } catch (_) {}
  return [...out];
}
const destinosDp = async () => { const { rows } = await pool.query("SELECT id FROM ch_departamentos WHERE codigo = 'dp'"); return rows[0] ? destinosDepto(rows[0].id) : []; };
async function responderA(chamadoId) {
  try { const { rows } = await pool.query("SELECT departamento_id FROM ch_chamados WHERE id = $1", [chamadoId]); return rows[0] ? (await destinosDepto(rows[0].departamento_id))[0] : undefined; } catch (_) { return undefined; }
}

// registra e envia (uma linha em ch_emails por destinatário). Nunca lança.
async function enviar(chamadoId, tipo, destinos, conteudo) {
  const lista = [...new Set((destinos || []).map((d) => String(d || "").trim().toLowerCase()).filter(emailValido))];
  for (const para of lista) {
    let status = "pulado", erro = null, provedor_id = null;
    const from = String(process.env.CHAMADOS_EMAIL_FROM || "").trim();
    try {
      if (!process.env.RESEND_API_KEY || !from) erro = "E-mail não configurado (RESEND_API_KEY / CHAMADOS_EMAIL_FROM).";
      else {
        provedor_id = await chamarResend({ from, to: [para], subject: conteudo.assunto, html: conteudo.html, text: conteudo.texto, replyTo: await responderA(chamadoId) });
        status = "enviado";
      }
    } catch (e) { status = "falhou"; erro = String(e.message || e).slice(0, 400); console.error("[chamados:email]", erro); }
    try {
      await pool.query("INSERT INTO ch_emails (chamado_id, tipo, destino, assunto, status, erro, provedor_id, conteudo_html, conteudo_texto) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [chamadoId, tipo, para, conteudo.assunto, status, erro, provedor_id, conteudo.html, conteudo.texto]);
    } catch (e) { console.error("[chamados:email] log:", e.message); }
  }
}
async function reenviar(emailId) {
  const { rows } = await pool.query("SELECT * FROM ch_emails WHERE id = $1", [emailId]);
  const e = rows[0]; if (!e) { const er = new Error("E-mail não encontrado."); er.status = 404; throw er; }
  const from = String(process.env.CHAMADOS_EMAIL_FROM || "").trim();
  if (!process.env.RESEND_API_KEY || !from) { const er = new Error("E-mail não configurado no servidor (RESEND_API_KEY / CHAMADOS_EMAIL_FROM)."); er.status = 409; throw er; }
  try {
    const id = await chamarResend({ from, to: [e.destino], subject: e.assunto, html: e.conteudo_html, text: e.conteudo_texto, replyTo: await responderA(e.chamado_id) });
    await pool.query("UPDATE ch_emails SET status = 'enviado', erro = NULL, provedor_id = $2, tentativas = tentativas + 1, atualizado_em = now() WHERE id = $1", [emailId, id]);
    return { ok: true, status: "enviado" };
  } catch (err) {
    await pool.query("UPDATE ch_emails SET status = 'falhou', erro = $2, tentativas = tentativas + 1, atualizado_em = now() WHERE id = $1", [emailId, String(err.message).slice(0, 400)]);
    const er = new Error("Não foi possível enviar: " + err.message); er.status = 502; throw er;
  }
}

module.exports = { montar, enviar, reenviar, destinosDp, destinosDepto, emailValido, linkChamado, fmtMin };

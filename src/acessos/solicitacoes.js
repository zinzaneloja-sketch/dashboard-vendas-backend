// Primeiro acesso: a própria pessoa pede o acesso (só Chamados e Admissão e Rescisão) e o gestor do módulo aprova.
// - A solicitação NÃO cria login: a senha escolhida fica guardada (criptografada) até alguém aprovar.
// - Quem aprova: o administrador (todos os módulos) e as pessoas que o administrador marcar em Acessos (por módulo).
// - Na aprovação o gestor escolhe o perfil da pessoa naquele módulo (mesmas opções da tela de Acessos).
const bcrypt = require("bcryptjs");
const { pool } = require("../db");
const auth = require("../auth");
const auditoria = require("../auditoria");
const acessos = require("./acessos");

const MODULOS = ["chamados", "admissao"];
const NOME_MOD = { chamados: "Chamados Zinzane", admissao: "Admissão e Rescisão" };
const ADM_PAPEIS = ["analista", "gestor", "go", "diretoria"];
const SENHA_FALSA = "$2a$10$CwTycUXWue0Thq9StjUM0uJ8e1x0wV0y2oYb9uG0v1o3kz8m8Jr1u";
const em = (s) => String(s || "").trim().toLowerCase();
const txt = (s, n) => String(s == null ? "" : s).trim().slice(0, n || 200);
const emailOk = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) && s.length <= 160;
function erro(status, message) { const e = new Error(message); e.status = status; return e; }
const lista = (arr) => MODULOS.filter((m) => arr.includes(m)).map((m) => NOME_MOD[m]).join(" e ");

// limite simples de pedidos por IP e por e-mail (em memória, por hora)
const janela = new Map();
function estourou(chave, max, ms) {
  const agora = Date.now(), a = (janela.get(chave) || []).filter((t) => agora - t < ms);
  if (a.length >= max) { janela.set(chave, a); return true; }
  a.push(agora); janela.set(chave, a);
  if (janela.size > 5000) for (const [k, v] of janela) if (!v.some((t) => agora - t < ms)) janela.delete(k);
  return false;
}

/** Pedido público de primeiro acesso. Devolve só um "ok": nada aqui dá acesso. */
async function solicitar(b = {}, ip) {
  if (process.env.PRIMEIRO_ACESSO === "0") throw erro(403, "O primeiro acesso está desativado. Fale com o administrador.");
  const email = em(b.email), nome = txt(b.nome, 120), senha = String(b.senha || ""), obs = txt(b.obs, 300);
  if (nome.length < 3) throw erro(400, "Informe o seu nome completo.");
  if (!emailOk(email)) throw erro(400, "Informe um e-mail válido.");
  const dom = String(process.env.PRIMEIRO_ACESSO_DOMINIOS || "").split(",").map((s) => s.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  if (dom.length && !dom.includes(email.split("@")[1])) throw erro(400, "Use o seu e-mail corporativo (" + dom.map((d) => "@" + d).join(", ") + ").");
  let mods = [...new Set((Array.isArray(b.modulos) ? b.modulos : []).filter((m) => MODULOS.includes(m)))];
  if (!mods.length) throw erro(400, "Escolha o módulo em que precisa de acesso (Chamados e/ou Admissão e Rescisão).");
  if (String(b.senha || "") !== String(b.confirmar ?? b.senha)) throw erro(400, "A confirmação da senha não confere.");
  auth.validarSenhaNova(senha);
  if (estourou("ip:" + ip, Number(process.env.PRIMEIRO_ACESSO_MAX_IP) || 10, 3600e3) || estourou("em:" + email, 4, 3600e3)) throw erro(429, "Muitos pedidos em pouco tempo. Aguarde um pouco e tente de novo.");

  const { rows: us } = await pool.query("SELECT id, password_hash, modules, role FROM users WHERE lower(email) = $1", [email]);
  const u = us[0];
  let hash;
  if (u) {
    // já tem login: só aceita pedir módulo a mais provando que é a própria pessoa (senha atual)
    if (!(await bcrypt.compare(senha, u.password_hash))) throw erro(409, "Esse e-mail já tem login. Para pedir mais um módulo, informe a senha atual dele; se esqueceu, peça ao administrador para redefinir.");
    if (u.role === "admin") throw erro(409, "Administrador já tem acesso a todos os módulos.");
    mods = mods.filter((m) => !(u.modules || []).includes(m));
    if (!mods.length) throw erro(409, "Você já tem acesso a esse(s) módulo(s). É só entrar com o seu e-mail e senha.");
    hash = u.password_hash;
  } else hash = await bcrypt.hash(senha, 10);

  const { rows: pend } = await pool.query("SELECT modulo FROM acesso_solicitacoes WHERE lower(email) = $1 AND status = 'pendente' AND modulo = ANY($2)", [email, mods]);
  if (pend.length) throw erro(409, "Já existe um pedido aguardando aprovação para " + lista(pend.map((p) => p.modulo)) + ". Aguarde o gestor do módulo.");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    for (const m of mods) await c.query("INSERT INTO acesso_solicitacoes (email, nome, password_hash, modulo, obs, ip) VALUES ($1,$2,$3,$4,$5,$6)", [email, nome, hash, m, obs || null, ip || null]);
    await c.query("COMMIT");
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch (_) { /* ignora */ }
    if (e.code === "23505") throw erro(409, "Já existe um pedido aguardando aprovação para esse e-mail.");
    throw e;
  } finally { c.release(); }
  auditoria.registrar({ usuario: email, acao: "acesso_solicitado", ip, detalhe: "Primeiro acesso · " + mods.join(", ") });
  return { ok: true, modulos: mods };
}

/** Mensagem para quem tenta entrar sem login ainda (só aparece se a senha confere com a do pedido). */
async function mensagemLogin(email, senha) {
  const { rows } = await pool.query("SELECT modulo, status, motivo, password_hash FROM acesso_solicitacoes WHERE lower(email) = $1 ORDER BY id DESC LIMIT 6", [em(email)]);
  const hash = (rows.find((r) => r.password_hash) || {}).password_hash || SENHA_FALSA;
  const ok = await bcrypt.compare(String(senha || ""), hash);
  if (!rows.length || !ok) return null;
  const pend = rows.filter((r) => r.status === "pendente");
  if (pend.length) return "Seu pedido de acesso (" + lista([...new Set(pend.map((r) => r.modulo))]) + ") está aguardando a aprovação do gestor. Assim que ele aprovar, é só entrar de novo com este e-mail e senha.";
  const rec = rows.find((r) => r.status === "recusada");
  if (rec) return "Seu pedido de acesso a " + lista([rec.modulo]) + " foi recusado" + (rec.motivo ? ": " + rec.motivo : ".") + " Fale com o gestor do módulo ou com o administrador.";
  return null;
}

/** Módulos em que a pessoa aprova pedidos (o administrador aprova todos). */
async function modulosQueAprova(acc) {
  if (!acc) return [];
  if (acc.role === "admin") return MODULOS.slice();
  const { rows } = await pool.query("SELECT modulo FROM acesso_aprovadores WHERE lower(email) = $1", [em(acc.email)]);
  return rows.map((r) => r.modulo).filter((m) => MODULOS.includes(m));
}

async function listar(acc) {
  const mods = await modulosQueAprova(acc);
  if (!mods.length) return { modulos_aprovo: [], pendentes: 0, itens: [], recentes: [] };
  const [it, rc, op] = await Promise.all([
    pool.query(`SELECT s.id::int AS id, s.nome, s.email, s.modulo, s.obs, s.criado_em,
                       EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(s.email)) AS ja_tem_login
                  FROM acesso_solicitacoes s WHERE s.status = 'pendente' AND s.modulo = ANY($1) ORDER BY s.criado_em`, [mods]),
    pool.query(`SELECT id::int AS id, nome, email, modulo, status, motivo, perfil, decidido_por, decidido_em
                  FROM acesso_solicitacoes WHERE status <> 'pendente' AND modulo = ANY($1) ORDER BY decidido_em DESC NULLS LAST, id DESC LIMIT 20`, [mods]),
    acessos.opcoes(),
  ]);
  return {
    modulos_aprovo: mods, pendentes: it.rows.length, itens: it.rows, recentes: rc.rows,
    opcoes: { departamentos: op.departamentos, grupos: op.grupos, lojas: op.lojas.map((l) => ({ id: l.id, nome: l.nome })), adm_papeis: ADM_PAPEIS },
  };
}

async function carregarParaDecidir(c, acc, id) {
  const { rows } = await c.query("SELECT * FROM acesso_solicitacoes WHERE id = $1 FOR UPDATE", [Number(id) || 0]);
  const s = rows[0];
  if (!s) throw erro(404, "Pedido não encontrado.");
  if (s.status !== "pendente") throw erro(409, "Este pedido já foi " + (s.status === "aprovada" ? "aprovado" : "recusado") + (s.decidido_por ? " por " + s.decidido_por : "") + ".");
  if (!(await modulosQueAprova(acc)).includes(s.modulo)) throw erro(403, "Você não aprova pedidos de " + (NOME_MOD[s.modulo] || s.modulo) + ".");
  if (em(s.email) === em(acc.email)) throw erro(403, "Você não pode decidir o seu próprio pedido.");
  return s;
}

async function aprovar(acc, b = {}) {
  const p = b.perfil || {};
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const s = await carregarParaDecidir(c, acc, b.id), email = em(s.email);
    let desc, perfil;
    if (s.modulo === "chamados") {
      if (!["dp", "gestor", "loja"].includes(p.tipo)) throw erro(400, "Chamados: escolha o perfil (loja, atendimento de departamento ou gestor de departamento).");
      if (p.tipo === "loja") {
        const { rows } = await c.query("SELECT id::int AS id, nome, email FROM ch_lojas WHERE id = $1 AND ativa", [Number(p.loja_id) || 0]);
        if (!rows[0]) throw erro(400, "Chamados: escolha a loja deste login.");
        if (rows[0].email && em(rows[0].email) !== email) throw erro(409, "A loja " + rows[0].nome + " já está ligada ao e-mail " + rows[0].email + ". Troque o e-mail da loja primeiro (Chamados > Lojas).");
        await c.query("UPDATE ch_lojas SET email = $2 WHERE id = $1", [rows[0].id, email]);
        desc = "loja " + rows[0].nome; perfil = { tipo: "loja", loja_id: rows[0].id, loja: rows[0].nome };
      } else {
        const { rows } = await c.query("SELECT id::int AS id, nome FROM ch_departamentos WHERE id = $1 AND ativo", [Number(p.departamento_id) || 0]);
        if (!rows[0]) throw erro(400, "Chamados: escolha o departamento.");
        await c.query(`INSERT INTO ch_equipe (email, nome, papel, ativo, departamento_id) VALUES ($1,$2,$3,true,$4)
          ON CONFLICT (lower(email)) DO UPDATE SET papel = EXCLUDED.papel, ativo = true, nome = COALESCE(EXCLUDED.nome, ch_equipe.nome), departamento_id = EXCLUDED.departamento_id`, [email, s.nome, p.tipo === "gestor" ? "gestor" : "dp", rows[0].id]);
        desc = (p.tipo === "gestor" ? "gestor de " : "atendimento de ") + rows[0].nome; perfil = { tipo: p.tipo, departamento_id: rows[0].id, departamento: rows[0].nome };
      }
    } else {
      if (!ADM_PAPEIS.includes(p.papel)) throw erro(400, "Admissão e Rescisão: escolha o perfil (analista, gestor, GO ou diretoria).");
      const grupos = p.papel === "go" ? await acessos.gruposValidos(p.grupos, "Admissão e Rescisão") : [];
      if (p.papel === "go" && !grupos.length) throw erro(400, "Escolha o grupo de lojas (regional) da GO: ela só enxerga as lojas do grupo dela.");
      await c.query(`INSERT INTO adm_equipe (email, nome, papel, ativo, grupos) VALUES ($1,$2,$3,true,$4)
        ON CONFLICT (lower(email)) DO UPDATE SET papel = EXCLUDED.papel, ativo = true, nome = COALESCE(EXCLUDED.nome, adm_equipe.nome), grupos = EXCLUDED.grupos`, [email, s.nome, p.papel, grupos]);
      desc = p.papel + (grupos.length ? " (" + grupos.join(", ") + ")" : ""); perfil = { papel: p.papel, grupos };
    }
    // login: cria com a senha que a pessoa escolheu, ou só acrescenta o módulo se ela já tinha login
    const { rows: ex } = await c.query("SELECT id FROM users WHERE lower(email) = $1 FOR UPDATE", [email]);
    if (!ex[0]) {
      if (!s.password_hash) throw erro(409, "Este pedido não tem mais a senha guardada. Peça para a pessoa solicitar de novo.");
      await c.query("INSERT INTO users (email, password_hash, role, nome, modules, cd_perfis, trocar_senha) VALUES ($1,$2,'viewer',$3,$4,$5,false)", [email, s.password_hash, s.nome, [s.modulo], []]);
    } else {
      await c.query("UPDATE users SET modules = (SELECT array_agg(DISTINCT x) FROM unnest(coalesce(modules, '{}'::text[]) || $2::text[]) AS x), nome = COALESCE(nome, $3) WHERE id = $1", [ex[0].id, [s.modulo], s.nome]);
    }
    await c.query("UPDATE acesso_solicitacoes SET status = 'aprovada', perfil = $2, decidido_por = $3, decidido_em = now(), password_hash = '' WHERE id = $1", [s.id, JSON.stringify(perfil), acc.email]);
    await c.query("COMMIT");
    auditoria.registrar({ usuario: acc.email, papel: acc.role, acao: "acesso_aprovado", alvo: email, ip: acc.ip, detalhe: "Primeiro acesso · " + (NOME_MOD[s.modulo]) + " · " + desc });
    return { ok: true, email, modulo: s.modulo };
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch (_) { /* ignora */ }
    throw e;
  } finally { c.release(); }
}

async function recusar(acc, b = {}) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const s = await carregarParaDecidir(c, acc, b.id), motivo = txt(b.motivo, 200) || null;
    await c.query("UPDATE acesso_solicitacoes SET status = 'recusada', motivo = $2, decidido_por = $3, decidido_em = now() WHERE id = $1", [s.id, motivo, acc.email]);
    await c.query("COMMIT");
    auditoria.registrar({ usuario: acc.email, papel: acc.role, acao: "acesso_recusado", alvo: em(s.email), ip: acc.ip, detalhe: "Primeiro acesso · " + NOME_MOD[s.modulo] + (motivo ? " · " + motivo : "") });
    return { ok: true };
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch (_) { /* ignora */ }
    throw e;
  } finally { c.release(); }
}

// ---------- quem aprova (só o administrador define) ----------
async function listarAprovadores() {
  const [ap, us] = await Promise.all([
    pool.query("SELECT modulo, lower(email) AS email FROM acesso_aprovadores ORDER BY lower(email)"),
    pool.query("SELECT lower(email) AS email, nome FROM users WHERE role <> 'admin' ORDER BY lower(coalesce(nome, email))"),
  ]);
  const por = {}; MODULOS.forEach((m) => { por[m] = []; });
  ap.rows.forEach((r) => { if (por[r.modulo]) por[r.modulo].push(r.email); });
  return { modulos: MODULOS.map((m) => ({ chave: m, nome: NOME_MOD[m] })), aprovadores: por, pessoas: us.rows };
}
async function salvarAprovadores(acc, b = {}) {
  const modulo = String(b.modulo || "");
  if (!MODULOS.includes(modulo)) throw erro(400, "Módulo inválido.");
  const emails = [...new Set((Array.isArray(b.emails) ? b.emails : []).map(em).filter(Boolean))];
  if (emails.length > 30) throw erro(400, "No máximo 30 aprovadores por módulo.");
  if (emails.length) {
    const { rows } = await pool.query("SELECT lower(email) AS email FROM users WHERE lower(email) = ANY($1)", [emails]);
    const ok = new Set(rows.map((r) => r.email)), faltam = emails.filter((e) => !ok.has(e));
    if (faltam.length) throw erro(400, "Quem aprova precisa ter login: " + faltam.join(", ") + " não tem.");
  }
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("DELETE FROM acesso_aprovadores WHERE modulo = $1", [modulo]);
    for (const e of emails) await c.query("INSERT INTO acesso_aprovadores (modulo, email, criado_por) VALUES ($1,$2,$3)", [modulo, e, acc.email]);
    await c.query("COMMIT");
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch (_) { /* ignora */ }
    throw e;
  } finally { c.release(); }
  auditoria.registrar({ usuario: acc.email, papel: "admin", acao: "aprovadores_alterados", ip: acc.ip, detalhe: NOME_MOD[modulo] + " · " + (emails.join(", ") || "ninguém") });
  return { ok: true };
}

module.exports = { solicitar, mensagemLogin, modulosQueAprova, listar, aprovar, recusar, listarAprovadores, salvarAprovadores, MODULOS };

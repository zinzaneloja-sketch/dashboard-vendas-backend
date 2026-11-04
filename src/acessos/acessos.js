// Acessos: um login único por pessoa (e-mail + senha), com o papel dela em cada módulo definido em um só lugar.
// Só o administrador usa. Cada módulo continua lendo o seu próprio cadastro (ch_equipe, adm_equipe, vm_equipe,
// ch_lojas e users.cd_perfis): esta tela só grava todos eles de uma vez, sem precisar abrir módulo por módulo.
const bcrypt = require("bcryptjs");
const { pool } = require("../db");
const auth = require("../auth");
const auditoria = require("../auditoria");

const { MODULES, CD_PERFIS } = auth;
const ADM_PAPEIS = ["analista", "gestor", "go", "diretoria"];
const em = (s) => String(s || "").trim().toLowerCase();
const txt = (s, n) => String(s == null ? "" : s).trim().slice(0, n || 200);
const emailOk = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
function erro(status, message) { const e = new Error(message); e.status = status; return e; }
const meuId = (acc) => String(acc.sub || acc.id);
const souEu = (acc, u, email) => String(u && u.id) === meuId(acc) || em(acc.email) === em(email);

async function opcoes() {
  const [dep, reg, lj] = await Promise.all([
    pool.query("SELECT id::int AS id, nome FROM ch_departamentos WHERE ativo ORDER BY ordem, nome"),
    pool.query("SELECT DISTINCT trim(regional) AS nome FROM ch_lojas WHERE ativa AND coalesce(trim(regional),'') <> '' ORDER BY 1"),
    pool.query("SELECT id::int AS id, nome, email FROM ch_lojas WHERE ativa ORDER BY lower(nome)"),
  ]);
  const vistos = new Set(), grupos = [];
  reg.rows.forEach((r) => { const k = r.nome.toLowerCase(); if (!vistos.has(k)) { vistos.add(k); grupos.push(r.nome); } });
  return { departamentos: dep.rows, grupos, lojas: lj.rows, cd_perfis: CD_PERFIS, modulos: MODULES };
}

async function listar() {
  const [us, ce, ae, ve, lj] = await Promise.all([
    pool.query("SELECT id::int AS id, email, nome, role, modules, cd_perfis, trocar_senha, created_at FROM users ORDER BY lower(coalesce(nome, email))"),
    pool.query("SELECT e.email, e.nome, e.papel, e.ativo, e.departamento_id::int AS departamento_id, d.nome AS departamento FROM ch_equipe e LEFT JOIN ch_departamentos d ON d.id = e.departamento_id"),
    pool.query("SELECT email, nome, papel, ativo, grupos FROM adm_equipe"),
    pool.query("SELECT email, nome, papel, ativo, grupos FROM vm_equipe"),
    pool.query("SELECT id::int AS id, nome, email FROM ch_lojas WHERE ativa AND coalesce(trim(email),'') <> ''"),
  ]);
  const por = new Map();
  const pega = (email, nome) => { const k = em(email); if (!por.has(k)) por.set(k, { id: null, email: k, nome: nome || null, admin: false, sem_login: true, modules: [], cd_perfis: [], trocar_senha: false, criado_em: null, loja: null, perfis: {} }); const p = por.get(k); if (!p.nome && nome) p.nome = nome; return p; };
  us.rows.forEach((u) => { const p = pega(u.email, u.nome); Object.assign(p, { id: u.id, sem_login: false, admin: u.role === "admin", modules: u.modules || [], cd_perfis: u.cd_perfis || [], trocar_senha: !!u.trocar_senha, criado_em: u.created_at }); });
  ce.rows.forEach((r) => { const p = pega(r.email, r.nome); if (r.ativo) p.perfis.chamados = { tipo: r.papel === "gestor" ? "gestor" : "dp", departamento_id: r.departamento_id, departamento: r.departamento }; });
  ae.rows.forEach((r) => { const p = pega(r.email, r.nome); if (r.ativo) { p.perfis.admissao = { papel: r.papel, grupos: r.grupos || [] }; if (r.papel === "go" || r.papel === "diretoria") p.perfis.govendas = { papel: r.papel, grupos: r.grupos || [] }; } });
  ve.rows.forEach((r) => { const p = pega(r.email, r.nome); if (r.ativo) p.perfis.vm = { papel: r.papel, grupos: r.grupos || [] }; });
  lj.rows.forEach((l) => { const k = em(l.email); if (por.has(k) && !por.get(k).sem_login) { const p = por.get(k); p.loja = { id: l.id, nome: l.nome }; if (!p.perfis.chamados) p.perfis.chamados = { tipo: "loja" }; if (!p.perfis.vm) p.perfis.vm = { papel: "loja" }; } });
  // pessoas só com papel cadastrado (sem login) aparecem para o administrador poder criar o login; lojas sem usuário não entram na lista
  const pessoas = [...por.values()].filter((p) => !p.sem_login || p.perfis.chamados || p.perfis.admissao || p.perfis.vm);
  return { pessoas, opcoes: await opcoes() };
}

async function gruposValidos(lista, rotulo) {
  const { grupos } = await opcoes(); const out = [];
  for (const g of Array.isArray(lista) ? lista : []) {
    const k = txt(g, 120).toLowerCase(); if (!k) continue;
    const ach = grupos.find((x) => x.toLowerCase() === k);
    if (!ach) throw erro(400, rotulo + ': o grupo "' + txt(g, 40) + '" não existe no cadastro de lojas.');
    if (!out.includes(ach)) out.push(ach);
  }
  return out;
}

async function salvar(acc, b = {}) {
  const email = em(b.email); if (!emailOk(email)) throw erro(400, "Informe um e-mail válido.");
  const nome = txt(b.nome, 120) || null;
  const admin = !!b.admin;
  const senha = b.senha ? String(b.senha) : "";
  if (senha && senha.length < 8) throw erro(400, "A senha provisória precisa de pelo menos 8 caracteres.");
  const { rows: ex } = await pool.query("SELECT id::int AS id, role FROM users WHERE lower(email) = $1", [email]);
  const existente = ex[0] || null;
  if (!existente && !senha) throw erro(400, "Informe uma senha provisória para o novo login (a pessoa troca no primeiro acesso).");
  if (existente && souEu(acc, existente, email) && !admin) throw erro(400, "Você não pode tirar o seu próprio acesso de administrador.");

  const sel = new Set((Array.isArray(b.modules) ? b.modules : []).filter((m) => MODULES.includes(m)));
  let cdPerfis = (Array.isArray(b.cd_perfis) ? b.cd_perfis : []).filter((x) => CD_PERFIS.includes(x));
  const cha = b.chamados || {}, adm = b.admissao || {}, vm = b.vm || {}, gv = b.govendas || {};
  const lojaId = b.loja_id ? Number(b.loja_id) : null;
  let plano = {};
  if (!admin) {
    if (sel.has("cd") && !cdPerfis.length) throw erro(400, "Recebimento / CD: escolha ao menos uma mesa (etapa) para essa pessoa.");
    if (!sel.has("cd")) cdPerfis = [];
    if (lojaId) {
      const { rows } = await pool.query("SELECT id::int AS id, nome, email FROM ch_lojas WHERE id = $1 AND ativa", [lojaId]);
      if (!rows[0]) throw erro(400, "Loja não encontrada.");
      if (rows[0].email && em(rows[0].email) !== email) throw erro(409, "A loja " + rows[0].nome + " já está ligada ao e-mail " + rows[0].email + ". Troque o e-mail da loja primeiro (Chamados > Lojas).");
    }
    if (sel.has("chamados")) {
      if (!["dp", "gestor", "loja"].includes(cha.tipo)) throw erro(400, "Chamados: escolha o perfil (loja, atendimento de departamento ou gestor de departamento).");
      if (cha.tipo === "loja" && !lojaId) throw erro(400, "Chamados: para perfil de loja, escolha a loja no campo “Loja deste login”.");
      if (cha.tipo !== "loja") { const { rows } = await pool.query("SELECT 1 FROM ch_departamentos WHERE id = $1 AND ativo", [Number(cha.departamento_id) || 0]); if (!rows[0]) throw erro(400, "Chamados: escolha o departamento."); }
    }
    if (sel.has("vm")) {
      if (!["vm", "regional", "loja"].includes(vm.papel)) throw erro(400, "Visual Merchandising: escolha o perfil (VM corporativo, gestor regional ou loja).");
      if (vm.papel === "loja" && !lojaId) throw erro(400, "Visual Merchandising: para perfil de loja, escolha a loja no campo “Loja deste login”.");
      if (vm.papel === "regional") { plano.vmGrupos = await gruposValidos(vm.grupos, "Visual Merchandising"); if (!plano.vmGrupos.length) throw erro(400, "Visual Merchandising: escolha ao menos uma regional para o gestor regional."); }
    }
    // Admissão e Vendas por GO compartilham o cadastro de equipe (analista/gestor/GO/diretoria)
    if (sel.has("admissao") && !ADM_PAPEIS.includes(adm.papel)) throw erro(400, "Admissão e Rescisão: escolha o perfil (analista, gestor, GO ou diretoria).");
    if (sel.has("govendas") && !["go", "diretoria"].includes(gv.papel)) throw erro(400, "Vendas por GO: escolha se a pessoa é GO ou Diretoria.");
    if (sel.has("admissao") && sel.has("govendas") && adm.papel !== gv.papel) throw erro(400, "Admissão e Vendas por GO usam o mesmo cadastro de equipe: o perfil precisa ser igual nos dois (GO ou Diretoria).");
    if (sel.has("admissao") || sel.has("govendas")) {
      plano.admPapel = sel.has("govendas") ? gv.papel : adm.papel;
      const fonteGr = sel.has("govendas") ? gv.grupos : adm.grupos;
      plano.admGrupos = plano.admPapel === "go" ? await gruposValidos(fonteGr, sel.has("govendas") ? "Vendas por GO" : "Admissão e Rescisão") : [];
      if (plano.admPapel === "go" && !plano.admGrupos.length) throw erro(400, "Escolha o grupo de lojas (regional) da GO: ela só enxerga as lojas do grupo dela.");
    }
  }
  const modules = admin ? MODULES.slice() : [...sel];
  if (cdPerfis.length && !modules.includes("cd")) modules.push("cd");

  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    let criado = false;
    if (!existente) {
      await c.query("INSERT INTO users (email, password_hash, role, nome, modules, cd_perfis, trocar_senha) VALUES ($1,$2,$3,$4,$5,$6,true)", [email, await bcrypt.hash(senha, 10), admin ? "admin" : "viewer", nome, modules, cdPerfis]);
      criado = true;
    } else {
      await c.query("UPDATE users SET role = $2, nome = COALESCE($3, nome), modules = $4, cd_perfis = $5 WHERE id = $1", [existente.id, admin ? "admin" : "viewer", nome, modules, cdPerfis]);
      if (senha) await c.query("UPDATE users SET password_hash = $2, trocar_senha = true, token_version = token_version + 1, senha_alterada_em = now() WHERE id = $1", [existente.id, await bcrypt.hash(senha, 10)]);
    }
    if (!admin) {
      // loja deste login
      if (lojaId) { await c.query("UPDATE ch_lojas SET email = $2 WHERE id = $1", [lojaId, email]); }
      // Chamados
      if (sel.has("chamados") && cha.tipo !== "loja") {
        await c.query(`INSERT INTO ch_equipe (email, nome, papel, ativo, departamento_id) VALUES ($1,$2,$3,true,$4)
          ON CONFLICT (lower(email)) DO UPDATE SET papel = EXCLUDED.papel, ativo = true, nome = COALESCE(EXCLUDED.nome, ch_equipe.nome), departamento_id = EXCLUDED.departamento_id`, [email, nome, cha.tipo === "gestor" ? "gestor" : "dp", Number(cha.departamento_id)]);
      } else await c.query("UPDATE ch_equipe SET ativo = false WHERE lower(email) = $1", [email]);
      // Admissão / Vendas por GO
      if (plano.admPapel) {
        await c.query(`INSERT INTO adm_equipe (email, nome, papel, ativo, grupos) VALUES ($1,$2,$3,true,$4)
          ON CONFLICT (lower(email)) DO UPDATE SET papel = EXCLUDED.papel, ativo = true, nome = COALESCE(EXCLUDED.nome, adm_equipe.nome), grupos = EXCLUDED.grupos`, [email, nome, plano.admPapel, plano.admGrupos]);
      } else await c.query("UPDATE adm_equipe SET ativo = false WHERE lower(email) = $1", [email]);
      // Visual Merchandising
      if (sel.has("vm") && vm.papel !== "loja") {
        await c.query(`INSERT INTO vm_equipe (email, nome, papel, grupos, ativo) VALUES ($1,$2,$3,$4,true)
          ON CONFLICT (lower(email)) DO UPDATE SET nome = COALESCE(EXCLUDED.nome, vm_equipe.nome), papel = EXCLUDED.papel, grupos = EXCLUDED.grupos, ativo = true`, [email, nome, vm.papel, vm.papel === "regional" ? plano.vmGrupos : []]);
      } else await c.query("UPDATE vm_equipe SET ativo = false WHERE lower(email) = $1", [email]);
    }
    await c.query("COMMIT");
    await auditoria.registrar({ usuario: acc.email, papel: "admin", acao: criado ? "acesso_criado" : "acesso_alterado", alvo: email, detalhe: "Acessos · " + (admin ? "administrador" : modules.join(", ") || "sem módulos") });
    return { ok: true, criado, email };
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch (_) { /* ignora */ }
    throw e;
  } finally { c.release(); }
}

async function usuario(email) {
  const { rows } = await pool.query("SELECT id::int AS id, role FROM users WHERE lower(email) = $1", [em(email)]);
  if (!rows[0]) throw erro(404, "Essa pessoa ainda não tem login.");
  return rows[0];
}
async function redefinirSenha(acc, b = {}) {
  const email = em(b.email), senha = String(b.senha || "");
  if (senha.length < 8) throw erro(400, "A senha provisória precisa de pelo menos 8 caracteres.");
  const u = await usuario(email);
  if (u.role === "admin" && !souEu(acc, u, email)) throw erro(403, "A senha de um administrador só ele mesmo redefine (Minha senha).");
  await pool.query("UPDATE users SET password_hash = $2, trocar_senha = $3, token_version = token_version + 1, senha_alterada_em = now() WHERE id = $1", [u.id, await bcrypt.hash(senha, 10), !souEu(acc, u, email)]);
  await auditoria.registrar({ usuario: acc.email, papel: "admin", acao: "senha_redefinida", alvo: email, detalhe: "Acessos" });
  return { ok: true };
}
async function desativarPapeis(email) {
  await pool.query("UPDATE ch_equipe SET ativo = false WHERE lower(email) = $1", [email]);
  await pool.query("UPDATE adm_equipe SET ativo = false WHERE lower(email) = $1", [email]);
  await pool.query("UPDATE vm_equipe SET ativo = false WHERE lower(email) = $1", [email]);
}
async function bloquear(acc, b = {}) {
  const email = em(b.email), u = await usuario(email);
  if (souEu(acc, u, email)) throw erro(400, "Você não pode bloquear o próprio acesso.");
  if (u.role === "admin") throw erro(400, "Tire primeiro o papel de administrador dessa pessoa (Editar) para poder bloquear.");
  await pool.query("UPDATE users SET modules = '{}', cd_perfis = '{}', token_version = token_version + 1 WHERE id = $1", [u.id]);
  await desativarPapeis(email);
  await auditoria.registrar({ usuario: acc.email, papel: "admin", acao: "acesso_bloqueado", alvo: email, detalhe: "Acessos · todos os módulos" });
  return { ok: true };
}
async function excluir(acc, b = {}) {
  const email = em(b.email), u = await usuario(email);
  if (souEu(acc, u, email)) throw erro(400, "Você não pode excluir o próprio login.");
  await desativarPapeis(email);
  await pool.query("DELETE FROM users WHERE id = $1", [u.id]);
  await auditoria.registrar({ usuario: acc.email, papel: "admin", acao: "acesso_excluido", alvo: email, detalhe: "Acessos · login excluído" });
  return { ok: true };
}

module.exports = { listar, salvar, redefinirSenha, bloquear, excluir, opcoes };

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("./db");

const JWT_SECRET = process.env.JWT_SECRET;
const seg = require("./seguranca");
const auditoria = require("./auditoria");
// Duração da sessão: quem acessa dados de DP (módulo chamados) ou é administrador entra a cada 12 h;
// os demais seguem como antes (30 dias). Ajustáveis por variável de ambiente.
const TTL_PADRAO = process.env.AUTH_TOKEN_TTL || "30d";
const TTL_CHAMADOS = process.env.AUTH_TOKEN_TTL_CHAMADOS || "12h";
const ttlPara = (u) => (u && (u.role === "admin" || (u.modules || []).includes("chamados") || (u.modules || []).includes("admissao")) ? TTL_CHAMADOS : TTL_PADRAO);

if (!JWT_SECRET) {
  if (process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT) {
    // Sem segredo próprio, qualquer pessoa conseguiria forjar um login de administrador. Melhor não subir.
    console.error("[auth] ERRO: JWT_SECRET não configurado. Defina uma chave longa e aleatória nas variáveis do Railway.");
    process.exit(1);
  }
  console.warn("[auth] JWT_SECRET não configurado — usando chave de desenvolvimento (NUNCA use assim em produção).");
}

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role, tv: user.token_version || 0 }, JWT_SECRET || "dev-secret-inseguro", {
    expiresIn: ttlPara(user),
  });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET || "dev-secret-inseguro");
}

async function findUserByEmail(email) {
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [String(email).toLowerCase()]);
  return rows[0] || null;
}

const MODULES = ["vendas", "cd", "chamados", "admissao"];
// Cada etapa do CD é uma mesa (um login por etapa). "gestor" é o consolidado: enxerga tudo.
const CD_PERFIS = ["recebimento", "separacao", "contagem", "referencia", "etiquetas", "pedido", "entrada", "checkout", "confronto", "distribuicao", "picking", "faturamento", "gestor"];
// Perfis agrupados do modelo antigo: viram as mesas equivalentes (ninguém perde acesso).
const CD_PERFIS_LEGADO = {
  doca: ["recebimento", "separacao", "contagem"],
  estilo: ["referencia"],
  cadastro: ["etiquetas", "pedido", "entrada", "checkout", "confronto"],
  expedicao: ["distribuicao", "picking", "faturamento"],
};
const expandirPerfis = (arr) => [...new Set((arr || []).flatMap((x) => CD_PERFIS_LEGADO[x] || [x]))];

function sanitizeAccess({ modules, cd_perfis }) {
  const m = Array.isArray(modules) ? [...new Set(modules.filter((x) => MODULES.includes(x)))] : ["vendas"];
  const p = Array.isArray(cd_perfis) ? [...new Set(expandirPerfis(cd_perfis).filter((x) => CD_PERFIS.includes(x)))] : [];
  // Perfil do CD sem acesso ao modulo nao faz sentido: libera o modulo automaticamente.
  if (p.length && !m.includes("cd")) m.push("cd");
  return { modules: m, cd_perfis: p };
}

async function createUser({ email, password, role, nome, modules, cd_perfis }) {
  const hash = await bcrypt.hash(password, 10);
  const acc = sanitizeAccess({ modules, cd_perfis });
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, role, nome, modules, cd_perfis) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, email, nome, role, modules, cd_perfis, created_at`,
    [String(email).toLowerCase(), hash, role === "admin" ? "admin" : "viewer", nome || null, acc.modules, acc.cd_perfis]
  );
  return rows[0];
}

async function updateUserAccess(id, { role, nome, modules, cd_perfis }) {
  const acc = sanitizeAccess({ modules, cd_perfis });
  const { rows } = await pool.query(
    `UPDATE users SET role = $2, nome = COALESCE($3, nome), modules = $4, cd_perfis = $5 WHERE id = $1
     RETURNING id, email, nome, role, modules, cd_perfis, created_at`,
    [id, role === "admin" ? "admin" : "viewer", nome === undefined ? null : nome, acc.modules, acc.cd_perfis]
  );
  return rows[0] || null;
}

async function listUsers() {
  const { rows } = await pool.query(
    "SELECT id, email, nome, role, modules, cd_perfis, created_at FROM users ORDER BY created_at ASC"
  );
  return rows;
}

/** Perfil de acesso vindo do banco (sempre fresco: remover/alterar acesso vale na hora, sem esperar o token expirar). */
async function loadAccess(userId) {
  const { rows } = await pool.query("SELECT id, email, nome, role, modules, cd_perfis, trocar_senha, token_version FROM users WHERE id = $1", [userId]);
  const u = rows[0];
  if (!u) return null;
  const admin = u.role === "admin";
  return {
    id: u.id,
    sub: u.id,
    email: u.email,
    nome: u.nome,
    role: u.role,
    modules: admin ? MODULES.slice() : u.modules || [],
    cd_perfis: admin ? CD_PERFIS.slice() : expandirPerfis(u.cd_perfis),
    trocar_senha: !!u.trocar_senha,
    token_version: u.token_version || 0,
  };
}

async function deleteUser(id) {
  await pool.query("DELETE FROM users WHERE id = $1", [id]);
}

/** Middleware: exige um token válido (qualquer papel). Popula req.user. */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Não autenticado." });
  try {
    req.user = verifyToken(token);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Sessão inválida ou expirada." });
  }
}

/** Middleware: exige papel admin (deve vir depois de requireAuth). */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") return res.status(403).json({ error: "Acesso restrito ao administrador." });
  next();
}

/** Middleware: exige acesso ao modulo (admin passa sempre). Deve vir depois de requireAuth. */
function requireModule(mod) {
  return async (req, res, next) => {
    try {
      const acc = await loadAccess(req.user.sub);
      if (!acc) return res.status(401).json({ error: "Usuário não encontrado." });
      if ((req.user.tv || 0) !== acc.token_version) return res.status(401).json({ error: "Sessão encerrada. Entre novamente." });
      if (!acc.modules.includes(mod)) return res.status(403).json({ error: "Você não tem acesso a este módulo." });
      req.access = acc;
      next();
    } catch (err) {
      next(err);
    }
  };
}

function httpErro(status, message) { const e = new Error(message); e.status = status; return e; }

/** Senha nova aceitável: 10+ caracteres, com letra e número. */
function validarSenhaNova(senha) {
  const v = String(senha || "");
  if (v.length < 10) throw httpErro(400, "A senha nova precisa de pelo menos 10 caracteres.");
  if (v.length > 100) throw httpErro(400, "Senha muito longa (máximo 100 caracteres).");
  if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) throw httpErro(400, "A senha nova precisa ter letras e números.");
}

/** Login com limite de tentativas. Devolve { token, user }. */
async function fazerLogin(email, password, ip) {
  if (!email || !password) throw httpErro(400, "Informe email e senha.");
  const espera = seg.esperaLogin(ip, email);
  if (espera) {
    throw seg.erroBloqueio(espera); // (só o momento do bloqueio é registrado, para um ataque não encher a auditoria)
  }
  const user = await findUserByEmail(email);
  // compara sempre (mesmo sem usuário) para não revelar por tempo de resposta se o e-mail existe
  const hash = user ? user.password_hash : "$2a$10$CwTycUXWue0Thq9StjUM0uJ8e1x0wV0y2oYb9uG0v1o3kz8m8Jr1u";
  const ok = await bcrypt.compare(String(password), hash);
  if (!user || !ok) {
    const bloqueou = seg.falhaLogin(ip, email);
    auditoria.registrar({ usuario: String(email).toLowerCase(), acao: bloqueou ? "login_bloqueado" : "login_falhou", ip, detalhe: bloqueou ? "limite de tentativas atingido" : null });
    throw httpErro(401, "Email ou senha inválidos.");
  }
  seg.sucessoLogin(ip, email);
  const acc = await loadAccess(user.id);
  if (acc.role === "admin" || acc.modules.includes("chamados") || acc.modules.includes("admissao")) auditoria.registrar({ usuario: acc.email, acao: "login", ip });
  return { token: signToken(user), user: acc };
}

/** O próprio usuário troca a senha. Encerra as outras sessões e devolve um token novo. */
async function trocarSenha(userId, atual, nova, ip) {
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
  const user = rows[0];
  if (!user) throw httpErro(401, "Usuário não encontrado.");
  const chave = "troca:" + user.id;
  const espera = seg.esperaLogin(ip, chave);
  if (espera) throw seg.erroBloqueio(espera);
  if (!(await bcrypt.compare(String(atual || ""), user.password_hash))) {
    seg.falhaLogin(ip, chave);
    throw httpErro(400, "A senha atual não confere.");
  }
  seg.sucessoLogin(ip, chave);
  validarSenhaNova(nova);
  if (String(nova) === String(atual)) throw httpErro(400, "A senha nova precisa ser diferente da atual.");
  const { rows: up } = await pool.query(
    "UPDATE users SET password_hash = $2, trocar_senha = false, senha_alterada_em = now(), token_version = token_version + 1 WHERE id = $1 RETURNING *",
    [user.id, await bcrypt.hash(String(nova), 10)]
  );
  auditoria.registrar({ usuario: user.email, acao: "senha_alterada", ip, detalhe: "pelo próprio usuário" });
  return { token: signToken(up[0]), user: await loadAccess(user.id) };
}

/** Aviso de e-mail/senha: invalida todas as sessões abertas de uma pessoa. */
async function encerrarSessoes(userId) {
  await pool.query("UPDATE users SET token_version = token_version + 1 WHERE id = $1", [userId]);
}

module.exports = {
  fazerLogin, trocarSenha, validarSenhaNova, encerrarSessoes,
  MODULES, CD_PERFIS, signToken, verifyToken, findUserByEmail, createUser, updateUserAccess, listUsers, deleteUser,
  loadAccess, requireAuth, requireAdmin, requireModule,
};

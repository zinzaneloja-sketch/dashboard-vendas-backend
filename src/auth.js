const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("./db");

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = "30d";

if (!JWT_SECRET) {
  console.warn("[auth] JWT_SECRET não configurado — defina essa variável de ambiente antes de usar login em produção.");
}

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role }, JWT_SECRET || "dev-secret-inseguro", {
    expiresIn: TOKEN_TTL,
  });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET || "dev-secret-inseguro");
}

async function findUserByEmail(email) {
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [String(email).toLowerCase()]);
  return rows[0] || null;
}

const MODULES = ["vendas", "cd", "chamados"];
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
  const { rows } = await pool.query("SELECT id, email, nome, role, modules, cd_perfis FROM users WHERE id = $1", [userId]);
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
      if (!acc.modules.includes(mod)) return res.status(403).json({ error: "Você não tem acesso a este módulo." });
      req.access = acc;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  MODULES, CD_PERFIS, signToken, verifyToken, findUserByEmail, createUser, updateUserAccess, listUsers, deleteUser,
  loadAccess, requireAuth, requireAdmin, requireModule,
};

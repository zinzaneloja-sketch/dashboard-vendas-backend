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

async function createUser({ email, password, role }) {
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role, created_at",
    [String(email).toLowerCase(), hash, role === "admin" ? "admin" : "viewer"]
  );
  return rows[0];
}

async function listUsers() {
  const { rows } = await pool.query("SELECT id, email, role, created_at FROM users ORDER BY created_at ASC");
  return rows;
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

module.exports = { signToken, verifyToken, findUserByEmail, createUser, listUsers, deleteUser, requireAuth, requireAdmin };

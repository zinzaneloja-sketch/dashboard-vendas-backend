const { Pool } = require("pg");

// Railway injeta DATABASE_URL automaticamente quando um Postgres é anexado ao serviço.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("railway")
    ? { rejectUnauthorized: false }
    : false,
});

module.exports = { pool };

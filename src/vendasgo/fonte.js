// Fonte dos dados de venda: retaguarda (SQL Server, somente leitura) ou dados de demonstração.
// Variáveis de ambiente (Railway):
//   RETAGUARDA_MSSQL_HOST, RETAGUARDA_MSSQL_PORT (1433), RETAGUARDA_MSSQL_USER, RETAGUARDA_MSSQL_PASSWORD,
//   RETAGUARDA_MSSQL_DB, RETAGUARDA_MSSQL_ENCRYPT ("0" desliga), RETAGUARDA_MSSQL_TRUST_CERT ("1" aceita certificado próprio)
//   GV_FONTE=demo  -> usa dados fictícios (só para conhecer o painel; aparece um aviso na tela)
// O pacote "mssql" é carregado só quando precisa: se ele não estiver instalado o servidor continua subindo normalmente.
const consultas = require("./consultas");

const tipo = () => (process.env.GV_FONTE === "demo" ? "demo" : process.env.RETAGUARDA_MSSQL_HOST ? "sqlserver" : "nao_configurada");

let poolMs = null;
async function conectar() {
  let mssql; try { mssql = require("mssql"); } catch (_) { throw new Error('O pacote "mssql" não está instalado no servidor. Adicione "mssql" ao package.json.'); }
  if (!poolMs) {
    poolMs = new mssql.ConnectionPool({
      server: process.env.RETAGUARDA_MSSQL_HOST, port: Number(process.env.RETAGUARDA_MSSQL_PORT || 1433), user: process.env.RETAGUARDA_MSSQL_USER, password: process.env.RETAGUARDA_MSSQL_PASSWORD, database: process.env.RETAGUARDA_MSSQL_DB,
      options: { encrypt: process.env.RETAGUARDA_MSSQL_ENCRYPT !== "0", trustServerCertificate: process.env.RETAGUARDA_MSSQL_TRUST_CERT === "1", readOnlyIntent: true },
      connectionTimeout: 15000, requestTimeout: Number(process.env.RETAGUARDA_MSSQL_TIMEOUT_MS || 120000), pool: { max: 2, min: 0, idleTimeoutMillis: 30000 },
    });
    poolMs.on("error", () => { poolMs = null; });
    try { await poolMs.connect(); } catch (e) { poolMs = null; throw new Error("Não consegui conectar na retaguarda: " + e.message); }
  }
  return { mssql, pool: poolMs };
}
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const txt = (v) => (v === null || v === undefined ? null : String(v).trim() || null);
const dia = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

async function lojas() {
  const t = tipo();
  if (t === "demo") return demo.lojas();
  if (t !== "sqlserver") throw new Error("A retaguarda ainda não foi configurada no servidor.");
  const { pool } = await conectar();
  const r = await pool.request().query(consultas.LOJAS);
  return r.recordset.map((x) => ({ cod: txt(x.cod), nome: txt(x.nome), go: txt(x.go), gerente: txt(x.gerente), cluster: txt(x.cluster), uf: txt(x.uf), regiao: txt(x.regiao), area_m2: num(x.area_m2), hc_necessario: num(x.hc_necessario), hc_real: num(x.hc_real), custo_ocupacao: num(x.custo_ocupacao) })).filter((x) => x.cod && x.nome);
}
async function vendasDia(desde, ate) {
  const t = tipo();
  if (t === "demo") return demo.vendasDia(desde, ate);
  if (t !== "sqlserver") throw new Error("A retaguarda ainda não foi configurada no servidor.");
  const { mssql, pool } = await conectar();
  const r = await pool.request().input("desde", mssql.Date, new Date(desde + "T00:00:00Z")).input("ate", mssql.Date, new Date(ate + "T00:00:00Z")).query(consultas.VENDAS_DIA);
  return r.recordset.map((x) => ({ cod: txt(x.cod), data: dia(x.data), venda: num(x.venda) || 0, tickets: num(x.tickets) || 0, pecas: num(x.pecas) || 0 })).filter((x) => x.cod && x.data);
}
// Lista tabelas e colunas do banco para ajudar a escrever as consultas (só administradores).
async function esquema(filtro) {
  if (tipo() !== "sqlserver") throw new Error("O esquema só pode ser lido quando a retaguarda SQL Server está configurada.");
  const { mssql, pool } = await conectar();
  const q = String(filtro || "").replace(/[^\w%]/g, "").slice(0, 40);
  const r = await pool.request().input("f", mssql.VarChar(60), q ? "%" + q + "%" : "%").query(`SELECT TOP 1500 c.TABLE_SCHEMA AS esquema, c.TABLE_NAME AS tabela, c.COLUMN_NAME AS coluna, c.DATA_TYPE AS tipo
    FROM INFORMATION_SCHEMA.COLUMNS c WHERE c.TABLE_NAME LIKE @f OR c.COLUMN_NAME LIKE @f ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`);
  const por = {}; r.recordset.forEach((x) => { const k = x.esquema + "." + x.tabela; (por[k] = por[k] || []).push(x.coluna + " (" + x.tipo + ")"); });
  return { tabelas: Object.keys(por).map((k) => ({ tabela: k, colunas: por[k] })) };
}

// ---------- dados de demonstração (determinísticos) ----------
const demo = (() => {
  const GOS = ["Ana Souza", "Bruna Lima", "Carla Mendes"], CL = ["Rua", "Shopping", "Outlet"];
  const L = [
    ["101", "Zinzane Iguatemi SP", 0, 1, "SP", "Sudeste", 180, 9, 8, 52000], ["102", "Zinzane Morumbi", 0, 1, "SP", "Sudeste", 150, 8, 8, 47000], ["103", "Zinzane Oscar Freire", 0, 0, "SP", "Sudeste", 120, 7, 6, 61000], ["104", "Zinzane Campinas", 0, 1, "SP", "Sudeste", 140, 7, 7, 33000],
    ["201", "Zinzane Barra Shopping", 1, 1, "RJ", "Sudeste", 160, 8, 8, 44000], ["202", "Zinzane Leblon", 1, 0, "RJ", "Sudeste", 110, 6, 5, 58000], ["203", "Zinzane Vitória", 1, 1, "ES", "Sudeste", 130, 6, 6, 29000], ["204", "Zinzane BH Savassi", 1, 0, "MG", "Sudeste", 125, 6, 7, 31000],
    ["301", "Zinzane Curitiba", 2, 1, "PR", "Sul", 150, 7, 6, 30000], ["302", "Zinzane Porto Alegre", 2, 1, "RS", "Sul", 145, 7, 7, 28000], ["303", "Zinzane Florianópolis", 2, 2, "SC", "Sul", 200, 8, 8, 26000], ["304", "Zinzane Brasília", 2, 1, "DF", "Centro-Oeste", 138, 6, 6, 32000],
  ];
  const GER = ["Paula", "Renata", "Tatiane", "Juliana", "Fernanda", "Camila", "Patrícia", "Larissa", "Vanessa", "Aline", "Bianca", "Mariana"];
  const rnd = (n) => { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); };
  return {
    lojas: () => L.map((l, i) => ({ cod: l[0], nome: l[1], go: GOS[l[2]], gerente: GER[i] + " " + ["Silva", "Costa", "Rocha", "Alves"][i % 4], cluster: CL[l[3]], uf: l[4], regiao: l[5], area_m2: l[6], hc_necessario: l[7], hc_real: l[8], custo_ocupacao: l[9] })),
    vendasDia: (desde, ate) => {
      const out = []; const d0 = new Date(desde + "T00:00:00Z"), d1 = new Date(ate + "T00:00:00Z");
      for (let d = new Date(d0); d <= d1; d.setUTCDate(d.getUTCDate() + 1)) {
        const iso = d.toISOString().slice(0, 10), dow = d.getUTCDay(), seq = Math.floor(d.getTime() / 864e5);
        L.forEach((l, i) => {
          const base = (l[9] / 30) * 3.2 * (1 + (dow === 6 ? 0.45 : dow === 0 ? 0.1 : dow === 5 ? 0.2 : 0)) * (0.8 + 0.5 * rnd(seq * 31 + i)) * (1 + i * 0.015) * (d.getUTCMonth() === 10 || d.getUTCMonth() === 11 ? 1.25 : 1);
          const tickets = Math.max(4, Math.round(base / (320 + 40 * rnd(i + 3)))); const venda = Math.round(tickets * (300 + 90 * rnd(seq + i * 7)) * 100) / 100;
          out.push({ cod: l[0], data: iso, venda, tickets, pecas: Math.round(tickets * (1.6 + 0.8 * rnd(i + seq * 3))) });
        });
      }
      return out;
    },
  };
})();

module.exports = { tipo, lojas, vendasDia, esquema };

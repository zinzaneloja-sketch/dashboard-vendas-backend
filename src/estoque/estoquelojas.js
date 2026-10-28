// Estoque por loja (planilha "Estoque Omni"): ruptura de grade e excesso, sem depender de venda.
//  - Ruptura de grade: a loja tem o ref/cor, mas faltam tamanhos que a rede (lojas + CD) ainda tem.
//    "Repor do CD" = os tamanhos que faltam existem no CD.
//  - Excesso: peças de um mesmo ref/cor na loja acima de um limite (padrão 8).
const crypto = require("crypto");
const { pool } = require("../db");

const erro = (status, message) => Object.assign(new Error(message), { status });
const txt = (v) => String(v === null || v === undefined ? "" : v).trim();
const NG = 11; // posições da grade (ES1..ES11)

// ---------- classificação das filiais ----------
// loja = ponto de venda; cd = centro de distribuição (de onde se repõe); apoio = defeito, devolução, qualidade, marketing, mostruário.
function tipoPadrao(filial) {
  const f = txt(filial).toUpperCase();
  if (/DEFEITO|RETORNO|DEVOLUC|\bCQ\b|MARKETING|MOSTRUARIO|LOJA VIRTUAL|^RJ DISP/.test(f)) return "apoio";
  if (/DISTRIBUIDORA/.test(f)) return "cd";
  return "loja";
}

// ---------- importação em lotes (a planilha é lida no navegador) ----------
async function iniciar() {
  await pool.query("DELETE FROM estoque_lojas_stage_itens WHERE criado_em < now() - interval '1 day'");
  await pool.query("DELETE FROM estoque_lojas_stage_produtos WHERE criado_em < now() - interval '1 day'");
  return { import_id: crypto.randomBytes(8).toString("hex") };
}
function idOk(b) { const id = txt(b.import_id); if (!/^[a-f0-9]{16}$/.test(id)) throw erro(400, "Importação inválida. Comece de novo."); return id; }
// itens: [filial, ref_cor, qtd, omni(0/1), g1..g11]   produtos: [ref_cor, produto, nome, preco, categoria, linha]
async function lote(b = {}) {
  const id = idOk(b);
  const itens = Array.isArray(b.itens) ? b.itens : [], produtos = Array.isArray(b.produtos) ? b.produtos : [];
  if (itens.length > 8000 || produtos.length > 8000) throw erro(413, "Lote grande demais.");
  if (itens.length) {
    await pool.query(`INSERT INTO estoque_lojas_stage_itens (import_id, filial, ref_cor, qtd, omni, g)
      SELECT $1, left(e->>0, 80), left(e->>1, 40), coalesce((e->>2)::numeric, 0)::int, (e->>3) = '1',
             ARRAY[${Array.from({ length: NG }, (_, i) => `coalesce((e->>${4 + i})::numeric, 0)::int`).join(", ")}]::int[]
      FROM jsonb_array_elements($2::jsonb) e`, [id, JSON.stringify(itens)]);
  }
  if (produtos.length) {
    await pool.query(`INSERT INTO estoque_lojas_stage_produtos (import_id, ref_cor, produto, nome, preco, categoria, linha)
      SELECT $1, left(e->>0, 40), left(e->>1, 40), left(e->>2, 200), nullif(e->>3, '')::numeric, left(e->>4, 60), left(e->>5, 60)
      FROM jsonb_array_elements($2::jsonb) e`, [id, JSON.stringify(produtos)]);
  }
  return { ok: true, itens: itens.length, produtos: produtos.length };
}
let cache = null; // dados em memória, refeitos quando a planilha muda
async function concluir(b = {}, email) {
  const id = idOk(b);
  const { rows: n } = await pool.query("SELECT count(*)::int AS n, count(DISTINCT filial)::int AS filiais FROM estoque_lojas_stage_itens WHERE import_id = $1", [id]);
  if (!n[0].n) throw erro(422, "Nenhuma linha de estoque chegou. Envie a planilha de novo.");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("DELETE FROM estoque_lojas_itens");
    await c.query("INSERT INTO estoque_lojas_itens (filial, ref_cor, qtd, omni, g) SELECT filial, ref_cor, sum(qtd)::int, bool_or(omni), ARRAY[sum(g[1])::int, sum(g[2])::int, sum(g[3])::int, sum(g[4])::int, sum(g[5])::int, sum(g[6])::int, sum(g[7])::int, sum(g[8])::int, sum(g[9])::int, sum(g[10])::int, sum(g[11])::int] FROM estoque_lojas_stage_itens WHERE import_id = $1 GROUP BY filial, ref_cor", [id]);
    await c.query("DELETE FROM estoque_lojas_produtos");
    await c.query("INSERT INTO estoque_lojas_produtos (ref_cor, produto, nome, preco, categoria, linha) SELECT DISTINCT ON (ref_cor) ref_cor, produto, nome, preco, categoria, linha FROM estoque_lojas_stage_produtos WHERE import_id = $1 ORDER BY ref_cor", [id]);
    // filiais novas entram com a classificação padrão; o que o gestor já ajustou é mantido
    const { rows: fs } = await c.query("SELECT DISTINCT filial FROM estoque_lojas_itens");
    for (const f of fs) await c.query("INSERT INTO estoque_lojas_filiais (filial, tipo) VALUES ($1, $2) ON CONFLICT (filial) DO NOTHING", [f.filial, tipoPadrao(f.filial)]);
    await c.query("INSERT INTO estoque_lojas_meta (chave, valor) VALUES ('importacao', $1) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor", [JSON.stringify({ em: new Date().toISOString(), por: email || null, arquivo: txt(b.arquivo).slice(0, 120) || null, linhas: n[0].n, filiais: n[0].filiais })]);
    await c.query("DELETE FROM estoque_lojas_stage_itens WHERE import_id = $1", [id]);
    await c.query("DELETE FROM estoque_lojas_stage_produtos WHERE import_id = $1", [id]);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  cache = null;
  return { ok: true, linhas: n[0].n, filiais: n[0].filiais };
}

// ---------- dados em memória ----------
const bits = (g) => { let m = 0; for (let i = 0; i < NG; i++) if (g[i] > 0) m |= 1 << i; return m; };
const pop = (m) => { let c = 0; while (m) { c += m & 1; m >>= 1; } return c; };
async function carregar() {
  if (cache) return cache;
  const [{ rows: it }, { rows: pr }, { rows: fl }, { rows: me }] = await Promise.all([
    pool.query("SELECT filial, ref_cor, qtd, omni, g FROM estoque_lojas_itens"),
    pool.query("SELECT ref_cor, produto, nome, preco::float AS preco, categoria, linha FROM estoque_lojas_produtos"),
    pool.query("SELECT filial, tipo FROM estoque_lojas_filiais"),
    pool.query("SELECT valor FROM estoque_lojas_meta WHERE chave = 'importacao'")]);
  const tipo = new Map(fl.map((f) => [f.filial, f.tipo]));
  const prod = new Map(pr.map((p) => [p.ref_cor, { nome: txt(p.nome), preco: p.preco || 0, categoria: txt(p.categoria) || "Sem categoria", linha: txt(p.linha) || "Sem linha", produto: txt(p.produto) }]));
  const rede = new Map(); // ref_cor -> { mask: tamanhos que a rede (lojas+CD) tem, cd: [qtd por posição] }
  for (const r of it) {
    const t = tipo.get(r.filial) || "loja";
    if (t === "apoio") continue;
    let x = rede.get(r.ref_cor); if (!x) { x = { mask: 0, cd: new Array(NG).fill(0) }; rede.set(r.ref_cor, x); }
    x.mask |= bits(r.g);
    if (t === "cd") for (let i = 0; i < NG; i++) x.cd[i] += r.g[i] || 0;
  }
  for (const x of rede.values()) { x.cdMask = bits(x.cd); x.n = pop(x.mask); }
  let meta = null; try { meta = me[0] ? JSON.parse(me[0].valor) : null; } catch (e) { /* ignora */ }
  cache = { it, prod, tipo, rede, meta };
  return cache;
}

function params(q = {}) {
  const num = (v, d, a, b) => { const n = Number(v); return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : d; };
  return { gradeMin: num(q.grade_min, 50, 10, 90) / 100, excesso: Math.round(num(q.excesso, 8, 2, 200)), soOmni: q.so_omni === "1" || q.so_omni === "true", categoria: txt(q.categoria), linha: txt(q.linha), busca: txt(q.busca).toLowerCase() };
}
// avalia um item de loja: grade e excesso
function avaliar(d, r, P) {
  const p = d.prod.get(r.ref_cor) || { nome: "", preco: 0, categoria: "Sem categoria", linha: "Sem linha" };
  const red = d.rede.get(r.ref_cor) || { mask: bits(r.g), cdMask: 0, n: pop(bits(r.g)), cd: new Array(NG).fill(0) };
  const m = bits(r.g), nl = pop(m);
  const cov = red.n ? nl / red.n : 1;
  const quebrada = red.n >= 2 && cov <= P.gradeMin && nl < red.n;
  const falta = red.mask & ~m;
  const repor = quebrada && (falta & red.cdMask) !== 0;
  const exc = Math.max(0, r.qtd - P.excesso);
  return { p, red, m, cov, quebrada, repor, exc, falta };
}
function passa(d, r, P, p) {
  if (P.soOmni && !r.omni) return false;
  if (P.categoria && p.categoria !== P.categoria) return false;
  if (P.linha && p.linha !== P.linha) return false;
  if (P.busca && !(p.nome.toLowerCase().includes(P.busca) || r.ref_cor.toLowerCase().includes(P.busca))) return false;
  return true;
}

// mapa de calor: lojas x categorias
async function mapa(q = {}) {
  const d = await carregar(), P = params(q);
  const lojas = new Map(), cats = new Map(), cel = new Map();
  const tot = { itens: 0, pecas: 0, valor: 0, quebradas: 0, repor: 0, excessoPecas: 0, excessoValor: 0 };
  for (const r of d.it) {
    if ((d.tipo.get(r.filial) || "loja") !== "loja") continue;
    const p = d.prod.get(r.ref_cor) || { categoria: "Sem categoria", linha: "Sem linha", nome: "", preco: 0 };
    if (!passa(d, r, P, p)) continue;
    const a = avaliar(d, r, P), v = r.qtd * p.preco;
    const add = (o) => { o.itens++; o.pecas += r.qtd; o.valor += v; if (a.quebrada) o.quebradas++; if (a.repor) o.repor++; o.excessoPecas += a.exc; o.excessoValor += a.exc * p.preco; };
    const novo = () => ({ itens: 0, pecas: 0, valor: 0, quebradas: 0, repor: 0, excessoPecas: 0, excessoValor: 0 });
    let l = lojas.get(r.filial); if (!l) { l = novo(); lojas.set(r.filial, l); }
    let c = cats.get(p.categoria); if (!c) { c = novo(); cats.set(p.categoria, c); }
    const k = r.filial + "\u0001" + p.categoria; let x = cel.get(k); if (!x) { x = novo(); cel.set(k, x); }
    add(l); add(c); add(x); add(tot);
  }
  const arr = (m, k) => [...m.entries()].map(([nome, v]) => ({ [k]: nome, ...v }));
  return {
    parametros: { grade_min: Math.round(P.gradeMin * 100), excesso: P.excesso, so_omni: P.soOmni },
    importacao: d.meta, total: tot,
    lojas: arr(lojas, "loja").sort((a, b) => a.loja.localeCompare(b.loja)),
    categorias: arr(cats, "categoria").sort((a, b) => b.pecas - a.pecas),
    celulas: [...cel.entries()].map(([k, v]) => { const [loja, categoria] = k.split("\u0001"); return { loja, categoria, ...v }; })
  };
}
// filtros disponíveis
async function opcoes() {
  const d = await carregar();
  const cats = new Set(), lin = new Set();
  for (const p of d.prod.values()) { cats.add(p.categoria); lin.add(p.linha); }
  return { categorias: [...cats].sort(), linhas: [...lin].sort(), importacao: d.meta, tem_dados: d.it.length > 0 };
}
// itens de uma loja (opcionalmente de uma categoria), os mais críticos primeiro
async function itens(q = {}) {
  const d = await carregar(), P = params(q), loja = txt(q.loja);
  if (!loja) throw erro(400, "Informe a loja.");
  const foco = txt(q.foco); // "quebrada" | "excesso" | ""
  const out = [];
  for (const r of d.it) {
    if (r.filial !== loja) continue;
    const p = d.prod.get(r.ref_cor) || { categoria: "Sem categoria", linha: "Sem linha", nome: "", preco: 0 };
    if (!passa(d, r, P, p)) continue;
    const a = avaliar(d, r, P);
    if (foco === "quebrada" && !a.quebrada) continue;
    if (foco === "excesso" && !a.exc) continue;
    out.push({ ref_cor: r.ref_cor, nome: p.nome, categoria: p.categoria, preco: p.preco, qtd: r.qtd, grade: r.g, rede_mask: a.red.mask, cd: a.red.cd, cobertura_grade: Math.round(a.cov * 100), quebrada: a.quebrada, repor_do_cd: a.repor, excesso_pecas: a.exc, omni: r.omni });
  }
  out.sort((x, y) => (y.quebrada - x.quebrada) || (y.repor_do_cd - x.repor_do_cd) || (y.excesso_pecas - x.excesso_pecas) || (x.cobertura_grade - y.cobertura_grade) || (y.qtd - x.qtd));
  const limite = Math.min(500, Number(q.limite) || 300);
  return { total: out.length, itens: out.slice(0, limite), truncado: out.length > limite };
}

// ---------- filiais ----------
async function filiais() {
  const { rows } = await pool.query(`SELECT f.filial, f.tipo, coalesce(sum(i.qtd), 0)::int AS pecas, count(i.ref_cor)::int AS itens
    FROM estoque_lojas_filiais f LEFT JOIN estoque_lojas_itens i ON i.filial = f.filial GROUP BY f.filial, f.tipo ORDER BY f.tipo, f.filial`);
  return { filiais: rows };
}
async function definirTipo(b = {}) {
  const filial = txt(b.filial), tipo = txt(b.tipo);
  if (!["loja", "cd", "apoio"].includes(tipo)) throw erro(400, "Tipo inválido.");
  const { rowCount } = await pool.query("UPDATE estoque_lojas_filiais SET tipo = $2 WHERE filial = $1", [filial, tipo]);
  if (!rowCount) throw erro(404, "Filial não encontrada.");
  cache = null;
  return { ok: true };
}

module.exports = { iniciar, lote, concluir, mapa, opcoes, itens, filiais, definirTipo, tipoPadrao };

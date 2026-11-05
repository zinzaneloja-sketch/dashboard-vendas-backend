// Performance do CD: alguém lança todo dia, por etapa, as peças processadas e quantas pessoas atuaram.
// Dali saem produtividade (peças por pessoa), meta x realizado, cruzamento produção x nº de pessoas e
// o represamento entre etapas (gargalo). Perfil próprio ("performance") + o consolidado (gestor).
const { pool } = require("../db");
const { diaLocal } = require("./tempo");

// Ordem do fluxo: cada etapa alimenta a seguinte.
const ETAPAS = [
  { chave: "separacao", nome: "Separação" },
  { chave: "etiquetagem", nome: "Etiquetagem" },
  { chave: "picking", nome: "Picking" },
  { chave: "checkout", nome: "Checkout" },
  { chave: "faturamento", nome: "Faturamento" },
  { chave: "expedicao", nome: "Expedição" },
];
const CHAVES = ETAPAS.map((e) => e.chave);
const NOME = Object.fromEntries(ETAPAS.map((e) => [e.chave, e.nome]));
const MAX_PECAS = 10000000, MAX_PESSOAS = 500, MAX_DIAS = 366, MAX_VOLTA_DIAS = 730;

function erro(status, message) { const e = new Error(message); e.status = status; return e; }
const txt = (v) => (v === undefined || v === null ? "" : String(v).trim());
const perfis = (acc) => acc.cd_perfis || [];
const ehGestor = (acc) => perfis(acc).includes("gestor");
const ehPerf = (acc) => ehGestor(acc) || perfis(acc).includes("performance");
function exigirPerf(acc) { if (!ehPerf(acc)) throw erro(403, "O painel de performance é do perfil Performance do CD e do consolidado (gestor)."); }
function exigirGestor(acc) { if (!ehGestor(acc)) throw erro(403, "Só o consolidado (gestor) pode definir as metas."); }

const hoje = () => diaLocal(new Date());
const ehData = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s + "T00:00:00Z").getTime()) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
function somaDias(ymd, n) { const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function difDias(a, b) { return Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000); }
function validaData(s, nome = "Data") {
  const d = txt(s);
  if (!ehData(d)) throw erro(400, nome + ": use o formato AAAA-MM-DD.");
  return d;
}
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

function inteiro(v, nome, max) {
  const n = Number(String(v).trim().replace(/\./g, "").replace(",", "."));
  if (!Number.isInteger(n) || n < 0) throw erro(400, nome + ": informe um número inteiro, 0 ou mais.");
  if (n > max) throw erro(400, nome + ": o máximo é " + max.toLocaleString("pt-BR") + ".");
  return n;
}
const vazio = (v) => v === undefined || v === null || String(v).trim() === "";

// ---------- lançamento do dia ----------
async function lerDia(db, data) {
  const { rows } = await db.query(
    `SELECT etapa, pecas::int AS pecas, pessoas::int AS pessoas, obs, atualizado_por, atualizado_em FROM cd_perf_lancamentos WHERE data = $1::date`, [data]);
  return new Map(rows.map((r) => [r.etapa, r]));
}
async function metasMap(db) {
  const { rows } = await db.query("SELECT etapa, meta_dia::float AS meta_dia, meta_pessoa::float AS meta_pessoa FROM cd_perf_metas");
  return new Map(rows.map((r) => [r.etapa, r]));
}

async function obterDia(acc, { data } = {}) {
  exigirPerf(acc);
  const dia = data ? validaData(data) : hoje();
  const [m, metas] = await Promise.all([lerDia(pool, dia), metasMap(pool)]);
  const { rows: ant } = await pool.query(`SELECT to_char(max(data), 'YYYY-MM-DD') AS d FROM cd_perf_lancamentos WHERE data < $1::date`, [dia]);
  let anterior = null;
  if (ant[0] && ant[0].d) {
    const ma = await lerDia(pool, ant[0].d);
    anterior = { data: ant[0].d, etapas: ETAPAS.map((e) => ({ etapa: e.chave, pecas: ma.has(e.chave) ? ma.get(e.chave).pecas : null, pessoas: ma.has(e.chave) ? ma.get(e.chave).pessoas : null })) };
  }
  return {
    data: dia, hoje: hoje(),
    etapas: ETAPAS.map((e) => {
      const r = m.get(e.chave), mt = metas.get(e.chave) || {};
      return { etapa: e.chave, nome: e.nome, pecas: r ? r.pecas : null, pessoas: r ? r.pessoas : null, obs: r ? r.obs || "" : "", lancado: !!r, atualizado_por: r ? r.atualizado_por : null, atualizado_em: r ? r.atualizado_em : null, meta_dia: mt.meta_dia || null, meta_pessoa: mt.meta_pessoa || null };
    }),
    anterior,
  };
}

// grava (ou apaga, se vier em branco) todas as etapas do dia de uma vez
async function salvarDia(acc, b = {}) {
  exigirPerf(acc);
  const data = validaData(b.data);
  if (data > hoje()) throw erro(400, "Não dá para lançar um dia que ainda não aconteceu.");
  if (difDias(data, hoje()) > MAX_VOLTA_DIAS) throw erro(400, "Data muito antiga.");
  const itens = Array.isArray(b.etapas) ? b.etapas : [];
  if (!itens.length) throw erro(400, "Envie as etapas do dia.");
  const lista = [];
  const vistos = new Set();
  for (const it of itens) {
    const ch = txt(it.etapa);
    if (!CHAVES.includes(ch)) throw erro(400, "Etapa desconhecida: " + ch);
    if (vistos.has(ch)) throw erro(400, "Etapa repetida: " + NOME[ch]);
    vistos.add(ch);
    const nome = NOME[ch];
    const semP = vazio(it.pecas), semN = vazio(it.pessoas);
    if (semP && semN) { lista.push({ ch, apagar: true }); continue; }
    if (semP || semN) throw erro(400, nome + ": informe as peças e as pessoas (ou deixe os dois em branco).");
    const pecas = inteiro(it.pecas, nome + " · peças", MAX_PECAS), pessoas = inteiro(it.pessoas, nome + " · pessoas", MAX_PESSOAS);
    if (pecas > 0 && pessoas < 1) throw erro(400, nome + ": há peças lançadas, então tem que ter pelo menos 1 pessoa.");
    lista.push({ ch, pecas, pessoas, obs: txt(it.obs).slice(0, 300) || null });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let gravadas = 0, apagadas = 0;
    for (const x of lista) {
      if (x.apagar) { const r = await client.query("DELETE FROM cd_perf_lancamentos WHERE data = $1::date AND etapa = $2", [data, x.ch]); apagadas += r.rowCount; continue; }
      await client.query(
        `INSERT INTO cd_perf_lancamentos (data, etapa, pecas, pessoas, obs, criado_por, atualizado_por) VALUES ($1::date,$2,$3,$4,$5,$6,$6)
         ON CONFLICT (data, etapa) DO UPDATE SET pecas = EXCLUDED.pecas, pessoas = EXCLUDED.pessoas, obs = EXCLUDED.obs, atualizado_por = EXCLUDED.atualizado_por, atualizado_em = now()`,
        [data, x.ch, x.pecas, x.pessoas, x.obs, acc.email || null]);
      gravadas++;
    }
    await client.query("COMMIT");
    return { ok: true, data, gravadas, apagadas };
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
}

// ---------- metas ----------
async function obterMetas(acc) {
  exigirPerf(acc);
  const m = await metasMap(pool);
  return { metas: ETAPAS.map((e) => ({ etapa: e.chave, nome: e.nome, meta_dia: (m.get(e.chave) || {}).meta_dia || null, meta_pessoa: (m.get(e.chave) || {}).meta_pessoa || null })), pode_editar: ehGestor(acc) };
}
async function salvarMetas(acc, b = {}) {
  exigirGestor(acc);
  const itens = Array.isArray(b.metas) ? b.metas : [];
  if (!itens.length) throw erro(400, "Envie as metas.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const it of itens) {
      const ch = txt(it.etapa);
      if (!CHAVES.includes(ch)) throw erro(400, "Etapa desconhecida: " + ch);
      const md = vazio(it.meta_dia) ? null : inteiro(it.meta_dia, NOME[ch] + " · meta de peças por dia", MAX_PECAS);
      let mp = null;
      if (!vazio(it.meta_pessoa)) { mp = Number(String(it.meta_pessoa).trim().replace(/\./g, "").replace(",", ".")); if (!(mp >= 0) || mp > 100000) throw erro(400, NOME[ch] + " · meta de peças por pessoa: número inválido."); }
      await client.query(
        `INSERT INTO cd_perf_metas (etapa, meta_dia, meta_pessoa, atualizado_por) VALUES ($1,$2,$3,$4)
         ON CONFLICT (etapa) DO UPDATE SET meta_dia = EXCLUDED.meta_dia, meta_pessoa = EXCLUDED.meta_pessoa, atualizado_por = EXCLUDED.atualizado_por, atualizado_em = now()`,
        [ch, md, mp, acc.email || null]);
    }
    await client.query("COMMIT");
    return { ok: true };
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
}

// ---------- histórico (tabela / Excel) ----------
async function periodo(b) {
  const ate = b.ate ? validaData(b.ate, "Data final") : hoje();
  const de = b.de ? validaData(b.de, "Data inicial") : somaDias(ate, -29);
  if (de > ate) throw erro(400, "A data inicial é depois da final.");
  if (difDias(de, ate) + 1 > MAX_DIAS) throw erro(400, "O período máximo é de " + MAX_DIAS + " dias.");
  return { de, ate };
}
async function linhasPeriodo(de, ate) {
  const { rows } = await pool.query(
    `SELECT to_char(data, 'YYYY-MM-DD') AS data, etapa, pecas::int AS pecas, pessoas::int AS pessoas, obs, atualizado_por, atualizado_em
       FROM cd_perf_lancamentos WHERE data BETWEEN $1::date AND $2::date ORDER BY data, etapa`, [de, ate]);
  return rows;
}
async function historico(acc, b = {}) {
  exigirPerf(acc);
  const { de, ate } = await periodo(b);
  const rows = await linhasPeriodo(de, ate);
  const por = new Map();
  rows.forEach((r) => { const d = por.get(r.data) || { data: r.data, etapas: {} }; d.etapas[r.etapa] = { pecas: r.pecas, pessoas: r.pessoas, obs: r.obs, atualizado_por: r.atualizado_por }; por.set(r.data, d); });
  return { de, ate, dias: [...por.values()].sort((a, z) => z.data.localeCompare(a.data)) };
}

// ---------- dashboard ----------
function regressao(pts) {
  const n = pts.length; if (n < 3) return null;
  const mx = pts.reduce((a, p) => a + p.pessoas, 0) / n, my = pts.reduce((a, p) => a + p.pecas, 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  pts.forEach((p) => { sxx += (p.pessoas - mx) ** 2; syy += (p.pecas - my) ** 2; sxy += (p.pessoas - mx) * (p.pecas - my); });
  if (sxx === 0) return { variacao_pessoas: false };
  const slope = sxy / sxx, inter = my - slope * mx;
  return { variacao_pessoas: true, pecas_por_pessoa_extra: r1(slope), intercepto: r1(inter), correlacao: syy > 0 ? r2(sxy / Math.sqrt(sxx * syy)) : null, amostras: n };
}

function resumoEtapa(ch, linhas, metas) {
  const r = linhas.filter((x) => x.etapa === ch);
  const mt = metas.get(ch) || {};
  const dias = r.length, pecas = r.reduce((a, x) => a + x.pecas, 0), pessoasDia = r.reduce((a, x) => a + x.pessoas, 0);
  const media = dias ? pecas / dias : null, prod = pessoasDia ? pecas / pessoasDia : null;
  const melhor = r.length ? r.reduce((a, x) => (x.pecas > a.pecas ? x : a)) : null, pior = r.length ? r.reduce((a, x) => (x.pecas < a.pecas ? x : a)) : null;
  const meta = mt.meta_dia || null, metaP = mt.meta_pessoa || null;
  const pts = r.map((x) => ({ data: x.data, pecas: x.pecas, pessoas: x.pessoas }));
  const buckets = new Map();
  pts.forEach((p) => { const b = buckets.get(p.pessoas) || { pessoas: p.pessoas, dias: 0, pecas: 0 }; b.dias++; b.pecas += p.pecas; buckets.set(p.pessoas, b); });
  const faixas = [...buckets.values()].sort((a, z) => a.pessoas - z.pessoas).map((b) => ({ pessoas: b.pessoas, dias: b.dias, media_pecas: Math.round(b.pecas / b.dias), pecas_por_pessoa: b.pessoas ? r1(b.pecas / b.dias / b.pessoas) : null }));
  const comProd = faixas.filter((f) => f.pecas_por_pessoa !== null);
  const melhorFaixa = comProd.length > 1 ? comProd.reduce((a, f) => (f.pecas_por_pessoa > a.pecas_por_pessoa ? f : a)) : null;
  return {
    etapa: ch, nome: NOME[ch], dias, pecas, media_dia: media === null ? null : Math.round(media), pessoas_media: dias ? r1(pessoasDia / dias) : null, pessoas_dia: pessoasDia, pecas_por_pessoa: prod === null ? null : r1(prod),
    melhor_dia: melhor ? { data: melhor.data, pecas: melhor.pecas, pessoas: melhor.pessoas } : null, pior_dia: pior ? { data: pior.data, pecas: pior.pecas, pessoas: pior.pessoas } : null,
    meta_dia: meta, atingimento_dia: meta && media !== null ? media / meta : null, dias_na_meta: meta ? r.filter((x) => x.pecas >= meta).length : null,
    meta_pessoa: metaP, atingimento_pessoa: metaP && prod !== null ? prod / metaP : null,
    serie: r.map((x) => ({ data: x.data, pecas: x.pecas, pessoas: x.pessoas, pecas_por_pessoa: x.pessoas ? r1(x.pecas / x.pessoas) : null, obs: x.obs || null })),
    cruzamento: { pontos: pts, faixas, melhor_faixa: melhorFaixa, regressao: regressao(pts) },
  };
}

// fluxo entre etapas: se a etapa anterior processou mais do que a seguinte, a diferença fica represada
function fluxo(linhas) {
  const idx = new Map(linhas.map((x) => [x.data + "|" + x.etapa, x]));
  const datas = [...new Set(linhas.map((x) => x.data))].sort();
  const pares = [];
  for (let i = 1; i < CHAVES.length; i++) {
    const de = CHAVES[i - 1], para = CHAVES[i];
    let ac = 0, pDe = 0, pPara = 0, n = 0;
    const serie = [];
    datas.forEach((d) => {
      const a = idx.get(d + "|" + de), b = idx.get(d + "|" + para);
      if (!a || !b) return;
      n++; pDe += a.pecas; pPara += b.pecas; ac += a.pecas - b.pecas;
      serie.push({ data: d, de: a.pecas, para: b.pecas, delta: a.pecas - b.pecas, acumulado: ac });
    });
    pares.push({ de, para, de_nome: NOME[de], para_nome: NOME[para], dias_comparados: n, pecas_de: pDe, pecas_para: pPara, represado: ac, represado_pct: pDe > 0 ? ac / pDe : null, serie });
  }
  const cand = pares.filter((p) => p.dias_comparados > 0 && p.represado > 0).sort((a, z) => z.represado - a.represado);
  return { pares, gargalo: cand.length ? { de: cand[0].de, para: cand[0].para, de_nome: cand[0].de_nome, para_nome: cand[0].para_nome, represado: cand[0].represado, represado_pct: cand[0].represado_pct } : null };
}

async function dashboard(acc, b = {}) {
  exigirPerf(acc);
  const { de, ate } = await periodo(b);
  const dias = difDias(de, ate) + 1;
  const deAnt = somaDias(de, -dias), ateAnt = somaDias(de, -1);
  const [linhas, linhasAnt, metas] = await Promise.all([linhasPeriodo(de, ate), linhasPeriodo(deAnt, ateAnt), metasMap(pool)]);
  const etapas = CHAVES.map((ch) => {
    const e = resumoEtapa(ch, linhas, metas), a = resumoEtapa(ch, linhasAnt, metas);
    e.anterior = { dias: a.dias, media_dia: a.media_dia, pecas_por_pessoa: a.pecas_por_pessoa, pessoas_media: a.pessoas_media };
    e.var_media_dia = a.media_dia && e.media_dia !== null ? (e.media_dia - a.media_dia) / a.media_dia : null;
    e.var_pecas_por_pessoa = a.pecas_por_pessoa && e.pecas_por_pessoa !== null ? (e.pecas_por_pessoa - a.pecas_por_pessoa) / a.pecas_por_pessoa : null;
    return e;
  });
  const datasLanc = [...new Set(linhas.map((x) => x.data))].sort();
  const completos = datasLanc.filter((d) => CHAVES.every((ch) => linhas.some((x) => x.data === d && x.etapa === ch)));
  const comDados = etapas.filter((e) => e.dias > 0);
  const gargaloVazao = comDados.length > 1 ? comDados.reduce((a, e) => (e.media_dia < a.media_dia ? e : a)) : null;
  const ultimo = linhas.length ? linhas.reduce((a, x) => (x.atualizado_em > a ? x.atualizado_em : a), linhas[0].atualizado_em) : null;
  return {
    de, ate, dias, hoje: hoje(),
    kpis: {
      dias_lancados: datasLanc.length, dias_completos: completos.length, dias_sem_lancamento: Math.max(0, dias - datasLanc.length),
      pecas_faturadas: (etapas.find((e) => e.etapa === "faturamento") || {}).pecas || 0,
      pecas_expedidas: (etapas.find((e) => e.etapa === "expedicao") || {}).pecas || 0,
      pecas_por_pessoa_geral: (() => { const t = comDados.reduce((a, e) => a + e.pecas, 0), p = comDados.reduce((a, e) => a + e.pessoas_dia, 0); return p ? r1(t / p) : null; })(),
      pessoas_dia_total: comDados.reduce((a, e) => a + e.pessoas_dia, 0),
      ultimo_lancamento_em: ultimo,
    },
    etapas, fluxo: fluxo(linhas),
    menor_vazao: gargaloVazao ? { etapa: gargaloVazao.etapa, nome: gargaloVazao.nome, media_dia: gargaloVazao.media_dia } : null,
    datas_lancadas: datasLanc,
  };
}

const VERSAO = "2026-11-06.2";
module.exports = { ETAPAS, obterDia, salvarDia, obterMetas, salvarMetas, historico, dashboard, VERSAO };

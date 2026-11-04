// Vendas por GO: sincronização com a retaguarda, painel de acompanhamento e cadastro do WhatsApp das gerentes.
const { pool } = require("../db");
const fonte = require("./fonte");

function erro(status, message) { const e = new Error(message); e.status = status; return e; }
const norm = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const em = (s) => String(s || "").trim().toLowerCase();

// ---------- datas (texto AAAA-MM-DD, sempre no dia de São Paulo) ----------
const iso = (d) => d.toISOString().slice(0, 10);
const D = (s) => new Date(s + "T12:00:00Z");
const addDias = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const hojeSP = () => iso(new Date(Date.now() - 3 * 3600e3));
const iniMes = (s) => s.slice(0, 8) + "01";
const fimMes = (s) => { const d = D(iniMes(s)); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return iso(d); };
const dow = (s) => D(s).getUTCDay();
const diasEntre = (a, b) => Math.round((D(b) - D(a)) / 864e5);
const segunda = (s) => addDias(s, -((dow(s) + 6) % 7));
const dataValida = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !isNaN(D(s));

// ---------- papéis ----------
// Diretoria e GOs já estão cadastradas no módulo de Admissão (adm_equipe). O administrador do portal vê tudo.
async function papelDe(acc) {
  const email = em(acc.email);
  if (acc.role === "admin") return { papel: "diretoria", admin: true, nome: acc.nome || acc.email, email, grupos: [] };
  let eq = [];
  try { eq = (await pool.query("SELECT nome, papel, grupos FROM adm_equipe WHERE lower(email) = $1 AND ativo", [email])).rows; } catch (_) { eq = []; }
  const e = eq[0];
  if (e && e.papel === "diretoria") return { papel: "diretoria", admin: false, nome: e.nome || acc.nome || acc.email, email, grupos: [] };
  if (e && e.papel === "go") return { papel: "go", admin: false, nome: e.nome || acc.nome || acc.email, email, grupos: (e.grupos || []).map(norm) };
  throw erro(403, "Seu usuário não está cadastrado como GO nem como Diretoria. Peça ao RH/administrador para cadastrar (Admissão e Rescisão > Cadastros > Equipe).");
}
const exigirDiretoria = (p) => { if (p.papel !== "diretoria") throw erro(403, "O relatório geral das GOs é enviado pela Diretoria."); };
const exigirGO = (p) => { if (p.papel !== "go" && !p.admin) throw erro(403, "O relatório das lojas é enviado pelas GOs."); };

// ---------- sincronização com a retaguarda ----------
let sincronizando = false;
async function meta(chave, valor) {
  if (valor === undefined) { const r = await pool.query("SELECT valor, atualizado_em FROM gv_meta WHERE chave = $1", [chave]); return r.rows[0] || null; }
  await pool.query("INSERT INTO gv_meta (chave, valor, atualizado_em) VALUES ($1,$2,now()) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()", [chave, valor]);
}
async function sincronizar({ completa = false } = {}) {
  if (fonte.tipo() === "nao_configurada") throw erro(503, "A retaguarda ainda não foi configurada no servidor (variáveis RETAGUARDA_MSSQL_*).");
  if (sincronizando) throw erro(409, "Já existe uma atualização em andamento.");
  sincronizando = true; const ini = Date.now();
  try {
    const hoje = hojeSP();
    const ultima = await meta("sync_completa");
    const fazCompleta = completa || !ultima || Date.now() - new Date(ultima.atualizado_em).getTime() > 24 * 3600e3;
    // janela completa: início do ano passado do mês anterior até hoje (cobre ano, mês anterior e comparações)
    const desde = fazCompleta ? [iniMes(addDias(iniMes(hoje), -1)), hoje.slice(0, 4) + "-01-01", addDias(hoje, -75)].sort()[0] : addDias(hoje, -10);
    const ls = await fonte.lojas();
    const { rows: ch } = await pool.query("SELECT codigo, nome, regional FROM ch_lojas WHERE ativa");
    const porCod = new Map(ch.filter((c) => c.codigo).map((c) => [norm(c.codigo), c.regional])), porNome = new Map(ch.map((c) => [norm(c.nome), c.regional]));
    for (const l of ls) {
      const regional = porCod.get(norm(l.cod)) || porNome.get(norm(l.nome)) || null;
      await pool.query(`INSERT INTO gv_lojas (cod, nome, go, gerente, cluster, uf, regiao, area_m2, hc_necessario, hc_real, custo_ocupacao, ativa, atualizada_em)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,now())
        ON CONFLICT (cod) DO UPDATE SET nome = EXCLUDED.nome, go = EXCLUDED.go, gerente = EXCLUDED.gerente, cluster = EXCLUDED.cluster, uf = EXCLUDED.uf, regiao = EXCLUDED.regiao, area_m2 = EXCLUDED.area_m2,
          hc_necessario = EXCLUDED.hc_necessario, hc_real = EXCLUDED.hc_real, custo_ocupacao = EXCLUDED.custo_ocupacao, ativa = true, atualizada_em = now()`,
        [l.cod, l.nome, regional || l.go, l.gerente, l.cluster, l.uf, l.regiao, l.area_m2, l.hc_necessario, l.hc_real, l.custo_ocupacao]);
    }
    if (ls.length) await pool.query("UPDATE gv_lojas SET ativa = false WHERE NOT (cod = ANY($1::text[]))", [ls.map((l) => l.cod)]);
    const cods = new Set(ls.map((l) => l.cod));
    const vs = (await fonte.vendasDia(desde, hoje)).filter((v) => cods.has(v.cod));
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("DELETE FROM gv_vendas_dia WHERE data BETWEEN $1::date AND $2::date", [desde, hoje]);
      for (let i = 0; i < vs.length; i += 2000) {
        const lote = vs.slice(i, i + 2000);
        await c.query("INSERT INTO gv_vendas_dia (cod, data, venda, tickets, pecas) SELECT * FROM unnest($1::text[], $2::date[], $3::numeric[], $4::int[], $5::int[]) ON CONFLICT (cod, data) DO UPDATE SET venda = EXCLUDED.venda, tickets = EXCLUDED.tickets, pecas = EXCLUDED.pecas",
          [lote.map((x) => x.cod), lote.map((x) => x.data), lote.map((x) => x.venda), lote.map((x) => Math.round(x.tickets)), lote.map((x) => Math.round(x.pecas))]);
      }
      await c.query("COMMIT");
    } catch (e) { try { await c.query("ROLLBACK"); } catch (_) { /* ignora */ } throw e; } finally { c.release(); }
    if (fazCompleta) await meta("sync_completa", "ok");
    await meta("sync_ok", JSON.stringify({ lojas: ls.length, linhas: vs.length, desde, completa: fazCompleta, ms: Date.now() - ini, fonte: fonte.tipo() }));
    await meta("sync_erro", "");
    return { ok: true, lojas: ls.length, linhas: vs.length, desde, completa: fazCompleta };
  } catch (e) {
    await meta("sync_erro", String(e.message).slice(0, 400)).catch(() => {});
    throw e;
  } finally { sincronizando = false; }
}
async function statusSync() {
  const ok = await meta("sync_ok"), er = await meta("sync_erro");
  return { fonte: fonte.tipo(), ultima: ok ? { em: ok.atualizado_em, ...JSON.parse(ok.valor) } : null, erro: er && er.valor ? er.valor : null, sincronizando };
}
async function eu(acc) {
  const p = await papelDe(acc);
  return { papel: p.papel, admin: !!p.admin, nome: p.nome, email: p.email, grupos: p.grupos, sync: await statusSync() };
}

// ---------- consulta de somas por loja ----------
async function somas(janelas, cods) {
  const params = []; const cols = [];
  Object.keys(janelas).forEach((k) => {
    params.push(janelas[k][0], janelas[k][1]); const i = params.length;
    const f = `FILTER (WHERE data BETWEEN $${i - 1}::date AND $${i}::date)`;
    cols.push(`coalesce(sum(venda) ${f},0)::float AS "${k}_v", coalesce(sum(tickets) ${f},0)::float AS "${k}_t", coalesce(sum(pecas) ${f},0)::float AS "${k}_p"`);
  });
  params.push(cods);
  const { rows } = await pool.query(`SELECT cod, ${cols.join(", ")} FROM gv_vendas_dia WHERE cod = ANY($${params.length}::text[]) GROUP BY cod`, params);
  const m = new Map(); rows.forEach((r) => m.set(r.cod, r)); return m;
}
const S = (r, k) => ({ venda: r ? r[k + "_v"] : 0, tickets: r ? r[k + "_t"] : 0, pecas: r ? r[k + "_p"] : 0 });
const somaS = (a, b) => ({ venda: a.venda + b.venda, tickets: a.tickets + b.tickets, pecas: a.pecas + b.pecas });
const ZERO = () => ({ venda: 0, tickets: 0, pecas: 0 });
const ticket = (s) => (s.tickets > 0 ? s.venda / s.tickets : null);
const pa = (s) => (s.tickets > 0 ? s.pecas / s.tickets : null);
const varPct = (a, b) => (b > 0 ? (100 * (a - b)) / b : null);

async function dataBaseVendas() {
  const ontem = addDias(hojeSP(), -1);
  const { rows } = await pool.query("SELECT max(data)::text AS d FROM gv_vendas_dia WHERE data <= $1::date AND venda > 0", [ontem]);
  return rows[0] && rows[0].d ? rows[0].d : null;
}
// Projeção: venda do mês até a data-base + média dos mesmos dias da semana nas últimas 8 semanas (só dias com venda) × dias que faltam.
async function projecoes(cods, base) {
  const out = new Map(); if (!cods.length) return out;
  const { rows } = await pool.query("SELECT cod, data::text AS data, venda::float AS venda FROM gv_vendas_dia WHERE cod = ANY($1::text[]) AND data BETWEEN $2::date AND $3::date", [cods, addDias(base, -55), base]);
  const por = new Map(); rows.forEach((r) => { if (!por.has(r.cod)) por.set(r.cod, []); por.get(r.cod).push(r); });
  const mi = iniMes(base), fm = fimMes(base);
  for (const cod of cods) {
    const rs = por.get(cod) || []; const mtd = rs.filter((r) => r.data >= mi).reduce((a, r) => a + r.venda, 0);
    const pos = rs.filter((r) => r.venda > 0); const geral = pos.length ? pos.reduce((a, r) => a + r.venda, 0) / pos.length : 0;
    const mediaDow = {}; for (let d = 0; d < 7; d++) { const x = pos.filter((r) => dow(r.data) === d); mediaDow[d] = x.length >= 2 ? x.reduce((a, r) => a + r.venda, 0) / x.length : geral; }
    let proj = mtd; for (let d = addDias(base, 1); d <= fm; d = addDias(d, 1)) proj += mediaDow[dow(d)];
    out.set(cod, Math.round(proj * 100) / 100);
  }
  return out;
}

// ---------- lojas visíveis ----------
async function lojasDoEscopo(p, f = {}) {
  const params = []; const w = ["ativa"];
  if (p.papel === "go") { params.push(p.grupos.length ? p.grupos : ["\u0000"]); w.push(`lower(trim(coalesce(go,''))) = ANY($${params.length}::text[])`); }
  if (f.go) { params.push(norm(f.go)); w.push(`lower(trim(coalesce(go,''))) = $${params.length}`); }
  if (f.loja) { params.push(String(f.loja)); w.push(`cod = $${params.length}`); }
  if (f.cluster) { params.push(norm(f.cluster)); w.push(`lower(trim(coalesce(cluster,''))) = $${params.length}`); }
  if (f.uf) { params.push(norm(f.uf)); w.push(`lower(trim(coalesce(uf,''))) = $${params.length}`); }
  if (f.regiao) { params.push(norm(f.regiao)); w.push(`lower(trim(coalesce(regiao,''))) = $${params.length}`); }
  const { rows } = await pool.query(`SELECT cod, nome, go, gerente, cluster, uf, regiao, area_m2::float AS area_m2, hc_necessario, hc_real, custo_ocupacao::float AS custo_ocupacao, gerente_whatsapp FROM gv_lojas WHERE ${w.join(" AND ")} ORDER BY lower(coalesce(go,'')), lower(nome)`, params);
  return rows;
}

// ---------- painel ----------
async function painel(acc, q = {}) {
  const p = await papelDe(acc);
  const todas = await lojasDoEscopo(p);
  const base = await dataBaseVendas(); const hoje = hojeSP();
  const lista = (k) => [...new Set(todas.map((l) => (l[k] || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const opcoes = { gos: lista("go"), lojas: todas.map((l) => ({ cod: l.cod, nome: l.nome, go: l.go })), clusters: lista("cluster"), ufs: lista("uf"), regioes: lista("regiao") };
  const st = await statusSync();
  if (!base || !todas.length) return { vazio: true, motivo: !todas.length ? "Nenhuma loja encontrada para o seu perfil." : "Ainda não há vendas sincronizadas.", opcoes, sync: st, data_base: base };
  const filtros = { go: q.go || "", loja: q.loja || "", cluster: q.cluster || "", uf: q.uf || "", regiao: q.regiao || "", hc: q.hc || "" };
  let lojas = await lojasDoEscopo(p, filtros);
  let de = dataValida(q.de) ? q.de : iniMes(base), ate = dataValida(q.ate) ? q.ate : base;
  if (ate > hoje) ate = hoje; if (de > ate) { const t = de; de = ate; ate = t; }
  if (diasEntre(de, ate) > 400) de = addDias(ate, -400);
  const len = diasEntre(de, ate) + 1, pde = addDias(de, -len), pate = addDias(de, -1);
  const mI = iniMes(base), maI = iniMes(addDias(mI, -1)), maF = addDias(mI, -1);
  const maMesmo = addDias(maI, Math.min(diasEntre(mI, base), diasEntre(maI, maF)));
  const win = { per: [de, ate], ant: [pde, pate], mes: [mI, base], maTot: [maI, maF], maMp: [maI, maMesmo], ano: [base.slice(0, 4) + "-01-01", base] };
  const cods = lojas.map((l) => l.cod); const sm = await somas(win, cods); const pj = await projecoes(cods, base);
  let linhas = lojas.map((l) => {
    const r = sm.get(l.cod), per = S(r, "per"), ant = S(r, "ant"), mes = S(r, "mes"), maTot = S(r, "maTot"), maMp = S(r, "maMp"), ano = S(r, "ano");
    const projecao = pj.get(l.cod) || 0;
    return { cod: l.cod, nome: l.nome, go: l.go, gerente: l.gerente, cluster: l.cluster, uf: l.uf, regiao: l.regiao, area_m2: l.area_m2, hc_necessario: l.hc_necessario, hc_real: l.hc_real,
      hc_gap: l.hc_real !== null && l.hc_necessario !== null ? l.hc_real - l.hc_necessario : null, custo_ocupacao: l.custo_ocupacao, gerente_whatsapp: l.gerente_whatsapp,
      venda_mes_anterior: maTot.venda, venda_periodo: per.venda, var_periodo: varPct(per.venda, ant.venda), ticket_medio: ticket(per), pa: pa(per), venda_mes: mes.venda, var_mes: varPct(mes.venda, maMp.venda),
      venda_ano: ano.venda, projecao_mes: projecao, var_projecao: varPct(projecao, maTot.venda), ocupacao_pct: l.custo_ocupacao && maTot.venda > 0 ? (100 * l.custo_ocupacao) / maTot.venda : null,
      venda_m2: l.area_m2 > 0 && maTot.venda > 0 ? maTot.venda / l.area_m2 : null, venda_por_hc: l.hc_real > 0 ? per.venda / l.hc_real : null, _per: per, _ant: ant, _mes: mes, _maTot: maTot, _maMp: maMp, _ano: ano };
  });
  if (filtros.hc === "falta") linhas = linhas.filter((l) => l.hc_gap !== null && l.hc_gap < 0); else if (filtros.hc === "ok") linhas = linhas.filter((l) => l.hc_gap === 0); else if (filtros.hc === "sobra") linhas = linhas.filter((l) => l.hc_gap !== null && l.hc_gap > 0);
  const agrega = (ls) => {
    const t = { per: ZERO(), ant: ZERO(), mes: ZERO(), maTot: ZERO(), maMp: ZERO(), ano: ZERO() }; let proj = 0, hcN = 0, hcR = 0, custo = 0;
    ls.forEach((l) => { t.per = somaS(t.per, l._per); t.ant = somaS(t.ant, l._ant); t.mes = somaS(t.mes, l._mes); t.maTot = somaS(t.maTot, l._maTot); t.maMp = somaS(t.maMp, l._maMp); t.ano = somaS(t.ano, l._ano); proj += l.projecao_mes; hcN += l.hc_necessario || 0; hcR += l.hc_real || 0; custo += l.custo_ocupacao || 0; });
    return { lojas: ls.length, venda_periodo: t.per.venda, var_periodo: varPct(t.per.venda, t.ant.venda), venda_periodo_anterior: t.ant.venda, ticket_medio: ticket(t.per), pa: pa(t.per), venda_mes: t.mes.venda, var_mes: varPct(t.mes.venda, t.maMp.venda), venda_mes_anterior: t.maTot.venda, venda_ano: t.ano.venda,
      projecao_mes: proj, var_projecao: varPct(proj, t.maTot.venda), hc_necessario: hcN, hc_real: hcR, custo_ocupacao: custo, ocupacao_pct: custo > 0 && t.maTot.venda > 0 ? (100 * custo) / t.maTot.venda : null };
  };
  const resumo = agrega(linhas);
  const porGo = {}; linhas.forEach((l) => { const k = l.go || "(sem GO)"; (porGo[k] = porGo[k] || []).push(l); });
  const por_go = Object.keys(porGo).map((k) => ({ go: k, ...agrega(porGo[k]) })).sort((a, b) => b.venda_periodo - a.venda_periodo);
  // série diária (período e período anterior equivalente, alinhados pelo dia)
  const cs = linhas.map((l) => l.cod); const serie = [];
  if (cs.length) {
    const { rows } = await pool.query("SELECT data::text AS data, sum(venda)::float AS venda, sum(tickets)::int AS tickets, sum(pecas)::int AS pecas FROM gv_vendas_dia WHERE cod = ANY($1::text[]) AND data BETWEEN $2::date AND $3::date GROUP BY data", [cs, pde, ate]);
    const mp = new Map(rows.map((r) => [r.data, r]));
    for (let i = 0; i < len; i++) { const d = addDias(de, i), c = mp.get(d), a = mp.get(addDias(pde, i)); serie.push({ data: d, venda: c ? c.venda : 0, tickets: c ? c.tickets : 0, pecas: c ? c.pecas : 0, anterior: a ? a.venda : 0, data_anterior: addDias(pde, i) }); }
  }
  const out = linhas.map((l) => { const { _per, _ant, _mes, _maTot, _maMp, _ano, ...r } = l; return r; });
  return { vazio: false, data_base: base, periodo: { de, ate, dias: len, anterior: { de: pde, ate: pate } }, filtros, opcoes, resumo, por_go, lojas: out, serie, sync: st, demo: fonte.tipo() === "demo" };
}

// ---------- WhatsApp das gerentes ----------
function numeroWhats(v) {
  let d = String(v || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 10 || d.length === 11) d = "55" + d;
  if (!/^55\d{10,11}$/.test(d)) return null;
  return d;
}
async function salvarWhats(acc, cod, b) {
  const p = await papelDe(acc);
  const l = (await lojasDoEscopo(p, { loja: cod }))[0]; if (!l) throw erro(403, "Essa loja não está na sua área.");
  if (p.papel === "diretoria" && !p.admin) throw erro(403, "O número da gerente é cadastrado pela GO.");
  const bruto = String(b.numero || "").trim();
  const n = bruto ? numeroWhats(bruto) : null; if (bruto && !n) throw erro(400, "Número inválido. Use DDD + número, por exemplo (11) 91234-5678.");
  const nome = String(b.gerente || "").trim().slice(0, 80) || null;
  await pool.query("UPDATE gv_lojas SET gerente_whatsapp = $2, gerente = COALESCE($3, gerente) WHERE cod = $1", [cod, n, nome]);
  return { ok: true, numero: n };
}
async function registrarEnvio(acc, b) {
  const p = await papelDe(acc);
  const tipo = ["grupo_gos", "go", "loja"].includes(b.tipo) ? b.tipo : null; if (!tipo) throw erro(400, "Tipo inválido.");
  if (tipo !== "loja") exigirDiretoria(p); else exigirGO(p);
  await pool.query("INSERT INTO gv_envios (usuario, papel, tipo, destino, ref) VALUES ($1,$2,$3,$4,$5)", [p.email, p.papel, tipo, String(b.destino || "").slice(0, 120) || null, String(b.ref || "").slice(0, 120) || null]);
  return { ok: true };
}

module.exports = { erro, norm, iso, D, addDias, hojeSP, iniMes, fimMes, dow, diasEntre, segunda, papelDe, exigirDiretoria, exigirGO, sincronizar, statusSync, eu, somas, S, somaS, ZERO, ticket, pa, varPct, dataBaseVendas, projecoes, lojasDoEscopo, painel, numeroWhats, salvarWhats, registrarEnvio, esquema: fonte.esquema, fonteTipo: fonte.tipo };

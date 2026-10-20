// Faturamento e trânsito: NFs de saída (uma por loja), tabelas de frete das transportadoras,
// projeção de custo e prazo, coleta, flag de entregue e quadro de trânsito/atrasadas.
// Independe das notas de entrada: uma NF de saída mistura produtos de várias entradas.
const { pool } = require("../db");
const { diaLocal } = require("./tempo");

function erro(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) e.extra = extra;
  return e;
}
const txt = (v) => (v === undefined || v === null ? "" : String(v).trim());
const semAcento = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const ehGestor = (acc) => (acc.cd_perfis || []).includes("gestor");
const ehFat = (acc) => ehGestor(acc) || (acc.cd_perfis || []).includes("faturamento");
function exigirFat(acc) { if (!ehFat(acc)) throw erro(403, "Faturamento e trânsito é da mesa de Faturamento e do consolidado."); }
function exigirGestor(acc) { if (!ehGestor(acc)) throw erro(403, "Só o consolidado (gestor) pode fazer isso."); }

// número em formato brasileiro ("1.234,56", "0,35%", "12,5 kg") ou comum
function numBR(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).replace(/[^\d.,-]/g, "");
  if (!s || s === "-") return null;
  if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
  else if (s.includes(",")) s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
const opt = (v) => (v === "" || v === undefined ? null : v);

async function comTransacao(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---------- datas (dias úteis seg–sex, a menos que a transportadora conte dias corridos) ----------
const hoje = () => diaLocal(new Date());
function dataValida(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !Number.isNaN(Date.parse(s + "T00:00:00Z")); }
function addDias(dataStr, n, corridos) {
  const d = new Date(dataStr + "T00:00:00Z");
  let falta = Number(n) || 0;
  while (falta > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (corridos || (d.getUTCDay() !== 0 && d.getUTCDay() !== 6)) falta--;
  }
  return d.toISOString().slice(0, 10);
}
function difDias(a, b) { return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000); } // b - a
function diasUteisEntre(a, b) { // quantos dias úteis de a (exclusivo) até b (inclusivo)
  let n = 0; const d = new Date(a + "T00:00:00Z"); const fim = new Date(b + "T00:00:00Z");
  while (d < fim) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) n++; }
  return n;
}
const dstr = (v) => (v ? (v instanceof Date ? diaLocalDate(v) : String(v).slice(0, 10)) : null);
// colunas DATE chegam como Date à meia-noite local do servidor: converte sem mudar de dia
function diaLocalDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

// ---------- leitura do XML da NF-e ----------
const tagXml = (src, t) => { const m = String(src || "").match(new RegExp(`<${t}(?:\\s[^>]*)?>\\s*([^<]*?)\\s*</${t}>`)); return m ? m[1] : null; };
const blocoXml = (src, t) => { const m = String(src || "").match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`)); return m ? m[1] : null; };
function lerXmlSaida(xml) {
  if (!/<infNFe[\s>]/.test(xml)) return null;
  const chave = ((xml.match(/<infNFe[^>]*\sId="NFe(\d{44})"/) || [])[1]) || tagXml(xml, "chNFe") || null;
  const ide = blocoXml(xml, "ide"), dest = blocoXml(xml, "dest"), tot = blocoXml(xml, "ICMSTot"), transp = blocoXml(xml, "transp");
  const end = blocoXml(dest, "enderDest");
  let pecas = 0, achou = false;
  for (const m of xml.matchAll(/<det\b[\s\S]*?<\/det>/g)) { const q = Number(String(tagXml(m[0], "qCom") || "").replace(",", ".")); if (Number.isFinite(q)) { pecas += q; achou = true; } }
  let vol = 0, peso = 0, temVol = false, temPeso = false;
  for (const m of String(transp || "").matchAll(/<vol\b[\s\S]*?<\/vol>/g)) {
    const q = numBR(tagXml(m[0], "qVol")), pb = numBR(tagXml(m[0], "pesoB")) ?? numBR(tagXml(m[0], "pesoL"));
    if (q !== null) { vol += q; temVol = true; }
    if (pb !== null) { peso += pb; temPeso = true; }
  }
  const trp = blocoXml(transp, "transporta");
  const vNF = Number(tagXml(tot, "vNF"));
  const dh = tagXml(ide, "dhEmi") || tagXml(ide, "dEmi");
  return {
    numero: tagXml(ide, "nNF"), serie: tagXml(ide, "serie"), chave,
    emitida_em: dh && !Number.isNaN(Date.parse(dh)) ? new Date(dh).toISOString() : null,
    destino_nome: tagXml(dest, "xNome"), destino_cnpj: tagXml(dest, "CNPJ") || tagXml(dest, "CPF"),
    destino_uf: (tagXml(end, "UF") || "").toUpperCase() || null, destino_cidade: tagXml(end, "xMun"), destino_cep: tagXml(end, "CEP"),
    volumes: temVol ? Math.round(vol) : null, peso_kg: temPeso ? Math.round(peso * 1000) / 1000 : null,
    pecas: achou ? Math.round(pecas) : null, valor: Number.isFinite(vNF) ? vNF : null,
    transportadora_xml: tagXml(trp, "xNome"), transportadora_cnpj: tagXml(trp, "CNPJ"),
  };
}

// ---------- cálculo do frete ----------
function calcFrete(row, peso, valor) {
  const p = Number(peso), v = Number(valor) || 0;
  const frete = Number(row.frete) || 0, porKg = (Number(row.frete_kg) || 0) * p, exc = (Number(row.excedente_kg) || 0) * Math.max(0, p - (Number(row.peso_de) || 0));
  let base = frete + porKg + exc;
  const minimo = Number(row.frete_minimo) || 0;
  const minAplicado = minimo > base;
  if (minAplicado) base = minimo;
  const adv = v * (Number(row.adv_pct) || 0) / 100, gris = v * (Number(row.gris_pct) || 0) / 100, taxa = Number(row.taxa_fixa) || 0;
  const arred = (x) => Math.round(x * 100) / 100;
  return { frete_peso: arred(base), ad_valorem: arred(adv), gris: arred(gris), taxa_fixa: arred(taxa), minimo_aplicado: minAplicado, total: arred(base + adv + gris + taxa) };
}

// linha da tabela da transportadora que atende UF/cidade/peso (cidade específica vence a regra geral da UF)
async function linhaDaTabela(db, transportadoraId, uf, cidade, peso) {
  const { rows } = await db.query(
    `SELECT * FROM cd_frete_tabela WHERE transportadora_id = $1 AND uf = $2 AND peso_de <= $3 AND (peso_ate IS NULL OR peso_ate >= $3)
        AND (cidade_norm IS NULL OR cidade_norm = $4)
      ORDER BY (cidade_norm IS NULL), peso_de DESC LIMIT 1`, [transportadoraId, uf, peso, semAcento(cidade)]);
  return rows[0] || null;
}

async function cotarCom(db, t, nf) {
  // t: transportadora {id,nome,prazo_corridos}
  const base = { transportadora_id: Number(t.id), nome: t.nome, prazo_corridos: t.prazo_corridos };
  if (!nf.destino_uf) return { ...base, ok: false, motivo: "Informe a UF do destino." };
  if (nf.peso_kg === null || nf.peso_kg === undefined || Number(nf.peso_kg) <= 0) return { ...base, ok: false, motivo: "Informe o peso da NF." };
  const row = await linhaDaTabela(db, t.id, nf.destino_uf, nf.destino_cidade, Number(nf.peso_kg));
  if (!row) return { ...base, ok: false, motivo: `Sem faixa na tabela para ${nf.destino_uf}${nf.destino_cidade ? " / " + nf.destino_cidade : ""} com ${Number(nf.peso_kg)} kg.` };
  const c = calcFrete(row, nf.peso_kg, nf.valor);
  const out = { ...base, ok: true, frete: c.total, memoria: c, prazo_dias: row.prazo_dias === null ? null : Number(row.prazo_dias), cidade_regra: row.cidade || null };
  if (nf.valor === null || nf.valor === undefined) out.aviso = "NF sem valor: ad valorem e GRIS não entraram.";
  return out;
}

async function cotacoes(db, nf) {
  const { rows: ts } = await db.query("SELECT id, nome, prazo_corridos FROM cd_transportadoras WHERE ativa ORDER BY nome");
  const out = [];
  for (const t of ts) {
    const c = await cotarCom(db, t, nf);
    if (c.ok) {
      const ini = hoje();
      c.previsao_se_coletar_hoje = c.prazo_dias === null ? null : addDias(ini, c.prazo_dias, t.prazo_corridos);
    }
    out.push(c);
  }
  const ok = out.filter((x) => x.ok);
  if (ok.length) {
    const menor = Math.min(...ok.map((x) => x.frete)); ok.forEach((x) => { x.mais_barata = x.frete === menor; });
    const pz = ok.filter((x) => x.prazo_dias !== null);
    if (pz.length) { const mp = Math.min(...pz.map((x) => x.prazo_dias)); pz.forEach((x) => { x.mais_rapida = x.prazo_dias === mp; }); }
  }
  out.sort((a, b) => (b.ok - a.ok) || ((a.frete ?? 1e12) - (b.frete ?? 1e12)));
  return out;
}

// ---------- transportadoras e tabelas ----------
async function listarTransportadoras(acc) {
  exigirFat(acc);
  const { rows } = await pool.query(
    `SELECT t.id, t.nome, t.cnpj, t.prazo_corridos, t.ativa, t.tabela_importada_em, t.tabela_importada_por,
            (SELECT count(*)::int FROM cd_frete_tabela f WHERE f.transportadora_id = t.id) AS linhas,
            (SELECT count(DISTINCT uf)::int FROM cd_frete_tabela f WHERE f.transportadora_id = t.id) AS ufs
       FROM cd_transportadoras t ORDER BY t.ativa DESC, lower(t.nome)`);
  return { transportadoras: rows };
}

async function salvarTransportadora(acc, id, b = {}) {
  exigirFat(acc);
  const nome = txt(b.nome).slice(0, 80);
  if (nome.length < 2) throw erro(400, "Informe o nome da transportadora.");
  const corr = b.prazo_corridos === true || b.prazo_corridos === "true";
  try {
    if (id) {
      const { rows } = await pool.query("UPDATE cd_transportadoras SET nome = $2, cnpj = $3, prazo_corridos = $4, ativa = COALESCE($5, ativa) WHERE id = $1 RETURNING id", [id, nome, opt(txt(b.cnpj)), corr, b.ativa === undefined ? null : !!b.ativa]);
      if (!rows[0]) throw erro(404, "Transportadora não encontrada.");
      return { ok: true, id: Number(id) };
    }
    const { rows } = await pool.query("INSERT INTO cd_transportadoras (nome, cnpj, prazo_corridos) VALUES ($1,$2,$3) RETURNING id", [nome, opt(txt(b.cnpj)), corr]);
    return { ok: true, id: Number(rows[0].id) };
  } catch (e) {
    if (e.code === "23505") throw erro(409, "Já existe uma transportadora com esse nome.");
    throw e;
  }
}

const UFS = new Set("AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split(" "));
// rows: [{uf, cidade, peso_de, peso_ate, frete, frete_kg, excedente_kg, adv_pct, gris_pct, taxa_fixa, frete_minimo, prazo_dias, [transportadora]}]
// A importação SUBSTITUI toda a tabela da transportadora (a nova tabela vira a vigente).
async function importarTabela(acc, transportadoraId, b = {}) {
  exigirFat(acc);
  const linhas = Array.isArray(b.rows) ? b.rows : [];
  if (!linhas.length) throw erro(400, "A tabela veio vazia.");
  if (linhas.length > 60000) throw erro(413, "Tabela grande demais (máximo 60.000 linhas por transportadora).");
  const ok = [], ignoradas = [];
  linhas.forEach((r, i) => {
    const uf = txt(r.uf).toUpperCase();
    if (!UFS.has(uf)) { ignoradas.push({ linha: i + 1, motivo: `UF inválida: "${txt(r.uf)}"` }); return; }
    const peso_de = numBR(r.peso_de) ?? 0, peso_ate = numBR(r.peso_ate);
    if (peso_ate !== null && peso_ate < peso_de) { ignoradas.push({ linha: i + 1, motivo: "Peso final menor que o inicial." }); return; }
    const o = { uf, cidade: txt(r.cidade) || null, cidade_norm: semAcento(r.cidade) || null, peso_de, peso_ate, frete: numBR(r.frete), frete_kg: numBR(r.frete_kg), excedente_kg: numBR(r.excedente_kg), adv_pct: numBR(r.adv_pct), gris_pct: numBR(r.gris_pct), taxa_fixa: numBR(r.taxa_fixa), frete_minimo: numBR(r.frete_minimo), prazo_dias: numBR(r.prazo_dias) };
    if ([o.frete, o.frete_kg, o.excedente_kg, o.frete_minimo].every((x) => x === null)) { ignoradas.push({ linha: i + 1, motivo: "Linha sem nenhum valor de frete (frete, R$/kg, excedente ou mínimo)." }); return; }
    if (o.prazo_dias !== null) o.prazo_dias = Math.round(o.prazo_dias);
    ok.push(o);
  });
  if (!ok.length) throw erro(422, "Nenhuma linha válida na tabela.", { ignoradas: ignoradas.slice(0, 30) });
  return comTransacao(async (c) => {
    const { rows: t } = await c.query("SELECT id, nome FROM cd_transportadoras WHERE id = $1 FOR UPDATE", [transportadoraId]);
    if (!t[0]) throw erro(404, "Transportadora não encontrada.");
    await c.query("DELETE FROM cd_frete_tabela WHERE transportadora_id = $1", [transportadoraId]);
    const CH = 2000;
    for (let i = 0; i < ok.length; i += CH) {
      const p = ok.slice(i, i + CH), col = (k) => p.map((x) => x[k]);
      await c.query(
        `INSERT INTO cd_frete_tabela (transportadora_id, uf, cidade, cidade_norm, peso_de, peso_ate, frete, frete_kg, excedente_kg, adv_pct, gris_pct, taxa_fixa, frete_minimo, prazo_dias)
         SELECT $1, uf, cidade, cidade_norm, peso_de, peso_ate, frete, frete_kg, excedente_kg, adv_pct, gris_pct, taxa_fixa, frete_minimo, prazo_dias
           FROM unnest($2::text[], $3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[], $10::numeric[], $11::numeric[], $12::numeric[], $13::numeric[], $14::int[])
             AS u(uf, cidade, cidade_norm, peso_de, peso_ate, frete, frete_kg, excedente_kg, adv_pct, gris_pct, taxa_fixa, frete_minimo, prazo_dias)`,
        [transportadoraId, col("uf"), col("cidade"), col("cidade_norm"), col("peso_de"), col("peso_ate"), col("frete"), col("frete_kg"), col("excedente_kg"), col("adv_pct"), col("gris_pct"), col("taxa_fixa"), col("frete_minimo"), col("prazo_dias")]);
    }
    await c.query("UPDATE cd_transportadoras SET tabela_importada_em = now(), tabela_importada_por = $2 WHERE id = $1", [transportadoraId, acc.email]);
    return { ok: true, transportadora: t[0].nome, linhas: ok.length, ignoradas: ignoradas.length, detalhe_ignoradas: ignoradas.slice(0, 30) };
  });
}

async function verTabela(acc, transportadoraId, { uf } = {}) {
  exigirFat(acc);
  const { rows: porUf } = await pool.query("SELECT uf, count(*)::int AS linhas, min(prazo_dias) AS prazo_min, max(prazo_dias) AS prazo_max FROM cd_frete_tabela WHERE transportadora_id = $1 GROUP BY uf ORDER BY uf", [transportadoraId]);
  const filtro = txt(uf).toUpperCase() || (porUf[0] && porUf[0].uf) || null;
  const { rows } = filtro
    ? await pool.query("SELECT uf, cidade, peso_de::float, peso_ate::float, frete::float, frete_kg::float, excedente_kg::float, adv_pct::float, gris_pct::float, taxa_fixa::float, frete_minimo::float, prazo_dias FROM cd_frete_tabela WHERE transportadora_id = $1 AND uf = $2 ORDER BY cidade NULLS FIRST, peso_de LIMIT 500", [transportadoraId, filtro])
    : { rows: [] };
  return { por_uf: porUf, uf: filtro, linhas: rows };
}

async function limparTabela(acc, transportadoraId) {
  exigirGestor(acc);
  await pool.query("DELETE FROM cd_frete_tabela WHERE transportadora_id = $1", [transportadoraId]);
  await pool.query("UPDATE cd_transportadoras SET tabela_importada_em = NULL, tabela_importada_por = NULL WHERE id = $1", [transportadoraId]);
  return { ok: true };
}

async function simular(acc, b = {}) {
  exigirFat(acc);
  const nf = { destino_uf: txt(b.uf).toUpperCase(), destino_cidade: txt(b.cidade), peso_kg: numBR(b.peso), valor: numBR(b.valor) };
  if (!UFS.has(nf.destino_uf)) throw erro(400, "Informe a UF do destino.");
  return { cotacoes: await cotacoes(pool, nf) };
}

// ---------- NFs de saída ----------
const COLS_LISTA = `n.id::int AS id, n.tipo, n.arquivo_nome, n.numero, n.serie, n.chave, n.emitida_em, n.destino_nome, n.destino_cnpj, n.destino_uf, n.destino_cidade, n.destino_cep,
  n.volumes, n.peso_kg::float AS peso_kg, n.valor::float AS valor, n.pecas, n.transportadora_xml, n.transportadora_id::int AS transportadora_id, t.nome AS transportadora, t.prazo_corridos,
  n.frete_previsto::float AS frete_previsto, n.frete_real::float AS frete_real, n.prazo_dias, n.prazo_manual, n.status, n.coleta_data, n.previsao_entrega, n.entregue_data, n.entregue_por, n.recebido_por, n.obs, n.enviada_por, n.enviada_em`;

// situação calculada: aguardando coleta, no prazo, vence hoje, atrasada, entregue (no prazo ou atrasada)
function situacao(n, dia = hoje()) {
  const coleta = dstr(n.coleta_data), prev = dstr(n.previsao_entrega), ent = dstr(n.entregue_data);
  const o = { ...n, coleta_data: coleta, previsao_entrega: prev, entregue_data: ent };
  if (n.status === "entregue") {
    o.situacao = prev && ent && ent > prev ? "entregue_atrasada" : "entregue";
    o.dias_atraso = prev && ent && ent > prev ? difDias(prev, ent) : 0;
    o.dias_transito = coleta && ent ? difDias(coleta, ent) : null;
  } else if (n.status === "em_transito") {
    o.dias_transito = coleta ? difDias(coleta, dia) : null;
    if (!prev) { o.situacao = "sem_previsao"; o.dias_atraso = 0; }
    else if (dia > prev) { o.situacao = "atrasada"; o.dias_atraso = difDias(prev, dia); }
    else if (dia === prev) { o.situacao = "vence_hoje"; o.dias_atraso = 0; }
    else { o.situacao = "no_prazo"; o.dias_atraso = 0; o.dias_para_vencer = difDias(dia, prev); }
  } else {
    o.situacao = "aguardando_coleta";
    const emi = n.emitida_em ? diaLocal(n.emitida_em) : diaLocal(n.enviada_em);
    o.dias_aguardando = diasUteisEntre(emi, dia);
    o.parada = o.dias_aguardando >= 2;
  }
  return o;
}

function filtrosSql(f, params) {
  const w = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  if (f.status && f.status !== "todas") w.push(`n.status = ${add(f.status)}`); else if (!f.status) w.push("n.status <> 'cancelada'"); else w.push("n.status <> 'cancelada'");
  if (f.transportadora_id) w.push(`n.transportadora_id = ${add(Number(f.transportadora_id))}`);
  if (f.sem_transportadora) w.push("n.transportadora_id IS NULL");
  if (f.uf) w.push(`n.destino_uf = ${add(txt(f.uf).toUpperCase())}`);
  if (f.q) { const p = add("%" + semAcento(f.q) + "%"); w.push(`(lower(n.numero) LIKE ${p} OR lower(coalesce(n.destino_nome,'')) LIKE ${p} OR n.chave LIKE ${p} OR lower(coalesce(n.destino_cidade,'')) LIKE ${p})`); }
  return w.length ? "WHERE " + w.join(" AND ") : "";
}

async function listarNfs(acc, f = {}) {
  exigirFat(acc);
  const params = [];
  const where = filtrosSql(f, params);
  const lim = Math.min(Math.max(Number(f.limit) || 300, 1), 2000);
  const { rows } = await pool.query(`SELECT ${COLS_LISTA} FROM cd_fat_nfs n LEFT JOIN cd_transportadoras t ON t.id = n.transportadora_id ${where} ORDER BY n.enviada_em DESC, n.id DESC LIMIT ${lim}`, params);
  const dia = hoje();
  let nfs = rows.map((r) => situacao(r, dia));
  if (f.situacao) nfs = nfs.filter((n) => n.situacao === f.situacao);
  return { nfs };
}

async function detalheNf(acc, id) {
  exigirFat(acc);
  const { rows } = await pool.query(`SELECT ${COLS_LISTA} FROM cd_fat_nfs n LEFT JOIN cd_transportadoras t ON t.id = n.transportadora_id WHERE n.id = $1`, [id]);
  if (!rows[0]) throw erro(404, "NF de saída não encontrada.");
  const { rows: ev } = await pool.query("SELECT tipo, usuario, detalhe, criado_em FROM cd_fat_eventos WHERE nfs_id = $1 ORDER BY id", [id]);
  const nf = situacao(rows[0]);
  const cot = nf.status === "cancelada" ? [] : await cotacoes(pool, rows[0]);
  return { nf, eventos: ev, cotacoes: cot };
}

async function evento(db, id, tipo, usuario, detalhe = {}) {
  await db.query("INSERT INTO cd_fat_eventos (nfs_id, tipo, usuario, detalhe) VALUES ($1,$2,$3,$4)", [id, tipo, usuario, JSON.stringify(detalhe)]);
}

// recalcula frete e previsão da NF com a transportadora escolhida
async function recalcular(db, id) {
  const { rows } = await db.query("SELECT n.*, t.prazo_corridos FROM cd_fat_nfs n LEFT JOIN cd_transportadoras t ON t.id = n.transportadora_id WHERE n.id = $1", [id]);
  const n = rows[0]; if (!n) return null;
  let frete = null, prazo = n.prazo_manual ? n.prazo_dias : null, aviso = null;
  if (n.transportadora_id) {
    const { rows: ts } = await db.query("SELECT id, nome, prazo_corridos FROM cd_transportadoras WHERE id = $1", [n.transportadora_id]);
    const c = await cotarCom(db, ts[0], n);
    if (c.ok) { frete = c.frete; if (!n.prazo_manual) prazo = c.prazo_dias; if (prazo === null || prazo === undefined) aviso = "A tabela não traz prazo para essa faixa (informe o prazo à mão)."; }
    else { aviso = c.motivo; }
  }
  const prev = n.coleta_data && prazo !== null && prazo !== undefined ? addDias(dstr(n.coleta_data), prazo, n.prazo_corridos) : null;
  await db.query("UPDATE cd_fat_nfs SET frete_previsto = $2, prazo_dias = $3, previsao_entrega = $4, atualizada_em = now() WHERE id = $1", [id, frete, prazo, prev]);
  return { frete_previsto: frete, prazo_dias: prazo, previsao_entrega: prev, aviso };
}

async function acharTransportadoraXml(db, nome, cnpj) {
  const c = txt(cnpj).replace(/\D/g, "");
  if (c) { const { rows } = await db.query("SELECT id FROM cd_transportadoras WHERE regexp_replace(coalesce(cnpj,''), '\\D', '', 'g') = $1 AND ativa LIMIT 1", [c]); if (rows[0]) return Number(rows[0].id); }
  if (txt(nome)) {
    const { rows } = await db.query("SELECT id, nome FROM cd_transportadoras WHERE ativa ORDER BY nome");
    const k = (x) => semAcento(x).replace(/[^a-z0-9]/g, "");
    const alvo = k(nome);
    // 1) nome igual; 2) um contém o outro (ex.: "PATRUS" x "PATRUS TRANSPORTES LTDA"), com pelo menos 4 letras
    const igual = rows.find((r) => k(r.nome) === alvo);
    if (igual) return Number(igual.id);
    const parecido = rows.filter((r) => { const n = k(r.nome); return n.length >= 4 && alvo.length >= 4 && (alvo.includes(n) || n.includes(alvo)); });
    if (parecido.length === 1) return Number(parecido[0].id);
  }
  return null;
}

// Um arquivo por chamada (o navegador envia vários em fila). O corpo leva o arquivo em base64.
async function enviarNf(acc, b = {}) {
  exigirFat(acc);
  const nome = txt(b.nome).slice(0, 200) || "nf";
  const buf = Buffer.from(String(b.base64 || ""), "base64");
  if (!buf.length) throw erro(400, "Arquivo vazio.");
  if (buf.length > 10 * 1024 * 1024) throw erro(413, "Arquivo maior que 10 MB.");
  const ehPdf = buf.slice(0, 5).toString("latin1") === "%PDF-";
  const tipo = ehPdf ? "pdf" : "xml";
  let m = {};
  if (!ehPdf) {
    const lido = lerXmlSaida(buf.toString("utf8"));
    if (!lido) throw erro(422, `${nome}: não é um XML de NF-e (não achei <infNFe>).`);
    m = lido;
  } else {
    // PDF (DANFE): o navegador lê o texto de cada nota e manda os campos junto com o arquivo (cada nota já vem separada)
    const pos = (v) => { const n = numBR(v); return n !== null && n > 0 ? n : null; };
    const ufb = txt(b.destino_uf).toUpperCase();
    m = {
      numero: txt(b.numero) || null, serie: txt(b.serie) || null,
      chave: /^\d{44}$/.test(txt(b.chave).replace(/\D/g, "")) ? txt(b.chave).replace(/\D/g, "") : null,
      emitida_em: /^\d{4}-\d{2}-\d{2}$/.test(txt(b.emissao)) ? txt(b.emissao) + "T12:00:00-03:00" : null,
      destino_nome: txt(b.destino_nome).slice(0, 200) || null, destino_cnpj: txt(b.destino_cnpj).replace(/\D/g, "").slice(0, 14) || null,
      destino_uf: UFS.has(ufb) ? ufb : null, destino_cidade: txt(b.destino_cidade).slice(0, 120) || null, destino_cep: txt(b.destino_cep).replace(/\D/g, "").slice(0, 8) || null,
      volumes: pos(b.volumes) === null ? null : Math.round(pos(b.volumes)), peso_kg: pos(b.peso_kg), valor: pos(b.valor), pecas: pos(b.pecas) === null ? null : Math.round(pos(b.pecas)),
      transportadora_xml: txt(b.transportadora_nome).slice(0, 120) || null, transportadora_cnpj: txt(b.transportadora_cnpj).replace(/\D/g, "").slice(0, 14) || null,
    };
  }
  return comTransacao(async (c) => {
    if (m.chave) {
      const { rows: dup } = await c.query("SELECT id, numero FROM cd_fat_nfs WHERE chave = $1", [m.chave]);
      if (dup[0]) throw erro(409, `A NF ${m.numero || nome} já foi enviada (chave repetida).`);
    }
    const tid = await acharTransportadoraXml(c, m.transportadora_xml, m.transportadora_cnpj);
    const { rows } = await c.query(
      `INSERT INTO cd_fat_nfs (tipo, arquivo_nome, tamanho, numero, serie, chave, emitida_em, destino_nome, destino_cnpj, destino_uf, destino_cidade, destino_cep, volumes, peso_kg, valor, pecas, transportadora_xml, transportadora_id, enviada_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
      [tipo, nome, buf.length, m.numero || null, m.serie || null, m.chave || null, m.emitida_em || null, m.destino_nome || null, m.destino_cnpj || null, m.destino_uf || null, m.destino_cidade || null, m.destino_cep || null,
        m.volumes ?? null, m.peso_kg ?? null, m.valor ?? null, m.pecas ?? null, m.transportadora_xml || null, tid, acc.email]);
    const id = Number(rows[0].id);
    await c.query("INSERT INTO cd_fat_nfs_arq (nfs_id, conteudo) VALUES ($1,$2)", [id, buf]);
    await evento(c, id, "enviada", acc.email, { arquivo: nome, tipo, numero: m.numero || null, destino: m.destino_nome || null, uf: m.destino_uf || null, pecas: m.pecas ?? null, volumes: m.volumes ?? null, peso_kg: m.peso_kg ?? null, valor: m.valor ?? null });
    const calc = tid ? await recalcular(c, id) : null;
    const faltam = [];
    if (!(m.destino_nome)) faltam.push("loja"); if (!m.destino_uf) faltam.push("UF"); if (m.peso_kg === null || m.peso_kg === undefined) faltam.push("peso"); if (m.valor === null || m.valor === undefined) faltam.push("valor");
    return { ok: true, id, tipo, numero: m.numero || null, destino: m.destino_nome || null, uf: m.destino_uf || null, transportadora_id: tid, faltam, aviso: calc && calc.aviso };
  });
}

const EDITAVEIS = { numero: "txt", serie: "txt", destino_nome: "txt", destino_cnpj: "txt", destino_uf: "uf", destino_cidade: "txt", destino_cep: "txt", volumes: "int", peso_kg: "num", valor: "num", pecas: "int", obs: "txt", frete_real: "num", prazo_dias: "int" };
async function editarNf(acc, id, b = {}) {
  exigirFat(acc);
  return comTransacao(async (c) => {
    const { rows } = await c.query("SELECT * FROM cd_fat_nfs WHERE id = $1 FOR UPDATE", [id]);
    const cur = rows[0];
    if (!cur) throw erro(404, "NF de saída não encontrada.");
    if (cur.status === "cancelada") throw erro(409, "Essa NF foi cancelada.");
    const sets = [], vals = [id], mud = [];
    let recalc = false;
    for (const [k, tipo] of Object.entries(EDITAVEIS)) {
      if (b[k] === undefined) continue;
      let v;
      if (tipo === "txt") v = txt(b[k]) || null;
      else if (tipo === "uf") { v = txt(b[k]).toUpperCase() || null; if (v && !UFS.has(v)) throw erro(400, "UF inválida."); }
      else if (tipo === "int") { v = numBR(b[k]); if (v !== null) { v = Math.round(v); if (v < 0) throw erro(400, `${k}: não pode ser negativo.`); } }
      else { v = numBR(b[k]); if (v !== null && v < 0) throw erro(400, `${k}: não pode ser negativo.`); }
      const atual = cur[k] === null || cur[k] === undefined ? null : (tipo === "num" ? Number(cur[k]) : cur[k]);
      if (atual === v) continue;
      vals.push(v); sets.push(`${k} = $${vals.length}`);
      mud.push({ campo: k, de: atual, para: v });
      if (["destino_uf", "destino_cidade", "peso_kg", "valor", "prazo_dias"].includes(k)) recalc = true;
    }
    if (b.transportadora_id !== undefined) {
      const tid = b.transportadora_id ? Number(b.transportadora_id) : null;
      if (tid) { const { rows: t } = await c.query("SELECT id FROM cd_transportadoras WHERE id = $1", [tid]); if (!t[0]) throw erro(404, "Transportadora não encontrada."); }
      if ((cur.transportadora_id ? Number(cur.transportadora_id) : null) !== tid) {
        vals.push(tid); sets.push(`transportadora_id = $${vals.length}`);
        sets.push("prazo_manual = false"); sets.push("prazo_dias = NULL");
        mud.push({ campo: "transportadora_id", de: cur.transportadora_id, para: tid }); recalc = true;
      }
    }
    if (b.prazo_dias !== undefined && b.transportadora_id === undefined && mud.some((m) => m.campo === "prazo_dias")) sets.push("prazo_manual = true");
    if (!sets.length) return { ok: true, mudancas: 0 };
    await c.query(`UPDATE cd_fat_nfs SET ${sets.join(", ")}, atualizada_em = now() WHERE id = $1`, vals);
    await evento(c, id, "editada", acc.email, { mudancas: mud });
    let calc = null;
    if (recalc && cur.status !== "entregue") calc = await recalcular(c, id);
    return { ok: true, mudancas: mud.length, aviso: calc && calc.aviso };
  });
}

// define a transportadora de várias NFs de uma vez: uma transportadora fixa ou, por NF, a mais barata / a mais rápida
async function definirTransportadora(acc, b = {}) {
  exigirFat(acc);
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Boolean))];
  if (!ids.length) throw erro(400, "Selecione ao menos uma NF.");
  if (ids.length > 500) throw erro(400, "Selecione no máximo 500 NFs por vez.");
  const modo = b.modo === "mais_barata" || b.modo === "mais_rapida" ? b.modo : null;
  const tid = b.transportadora_id ? Number(b.transportadora_id) : null;
  if (!modo && !tid) throw erro(400, "Escolha a transportadora (ou o modo automático).");
  return comTransacao(async (c) => {
    const res = [];
    for (const id of ids) {
      const { rows } = await c.query("SELECT * FROM cd_fat_nfs WHERE id = $1 FOR UPDATE", [id]);
      const n = rows[0];
      if (!n || n.status === "cancelada") { res.push({ id, ok: false, motivo: "NF não encontrada." }); continue; }
      if (n.status === "entregue") { res.push({ id, numero: n.numero, ok: false, motivo: "Já foi entregue." }); continue; }
      let alvo = tid;
      if (modo) {
        const cot = (await cotacoes(c, n)).filter((x) => x.ok);
        if (!cot.length) { res.push({ id, numero: n.numero, ok: false, motivo: "Nenhuma tabela atende essa NF (confira UF, peso e tabelas)." }); continue; }
        const pool2 = modo === "mais_rapida" ? cot.filter((x) => x.prazo_dias !== null) : cot;
        if (!pool2.length) { res.push({ id, numero: n.numero, ok: false, motivo: "As tabelas não trazem prazo." }); continue; }
        pool2.sort((a, z) => modo === "mais_rapida" ? (a.prazo_dias - z.prazo_dias) || (a.frete - z.frete) : (a.frete - z.frete) || ((a.prazo_dias ?? 999) - (z.prazo_dias ?? 999)));
        alvo = pool2[0].transportadora_id;
      }
      await c.query("UPDATE cd_fat_nfs SET transportadora_id = $2, prazo_dias = NULL, prazo_manual = false WHERE id = $1", [id, alvo]);
      const calc = await recalcular(c, id);
      await evento(c, id, "transportadora", acc.email, { de: n.transportadora_id, para: alvo, modo: modo || "manual", frete: calc.frete_previsto, prazo_dias: calc.prazo_dias });
      res.push({ id, numero: n.numero, ok: true, transportadora_id: alvo, frete_previsto: calc.frete_previsto, prazo_dias: calc.prazo_dias, aviso: calc.aviso });
    }
    return { ok: true, resultados: res, definidas: res.filter((x) => x.ok).length };
  });
}

async function marcarColeta(acc, b = {}) {
  exigirFat(acc);
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Boolean))];
  if (!ids.length) throw erro(400, "Selecione ao menos uma NF.");
  const data = b.data || hoje();
  if (!dataValida(data)) throw erro(400, "Data de coleta inválida.");
  if (data > hoje()) throw erro(400, "A data de coleta não pode ser futura.");
  const tid = b.transportadora_id ? Number(b.transportadora_id) : null;
  return comTransacao(async (c) => {
    const res = [];
    for (const id of ids) {
      const { rows } = await c.query("SELECT * FROM cd_fat_nfs WHERE id = $1 FOR UPDATE", [id]);
      const n = rows[0];
      if (!n || n.status === "cancelada") { res.push({ id, ok: false, motivo: "NF não encontrada." }); continue; }
      if (n.status !== "emitida") { res.push({ id, numero: n.numero, ok: false, motivo: n.status === "entregue" ? "Já foi entregue." : "Já está em trânsito." }); continue; }
      const alvo = tid || n.transportadora_id;
      if (!alvo) { res.push({ id, numero: n.numero, ok: false, motivo: "Defina a transportadora antes da coleta." }); continue; }
      const emi = n.emitida_em ? diaLocal(n.emitida_em) : null;
      if (emi && data < emi) { res.push({ id, numero: n.numero, ok: false, motivo: `A coleta (${data}) é anterior à emissão da NF (${emi}).` }); continue; }
      if (alvo !== (n.transportadora_id ? Number(n.transportadora_id) : null)) await c.query("UPDATE cd_fat_nfs SET transportadora_id = $2, prazo_dias = NULL, prazo_manual = false WHERE id = $1", [id, alvo]);
      await c.query("UPDATE cd_fat_nfs SET status = 'em_transito', coleta_data = $2, atualizada_em = now() WHERE id = $1", [id, data]);
      const calc = await recalcular(c, id);
      await evento(c, id, "coleta", acc.email, { data, transportadora_id: alvo, previsao_entrega: calc.previsao_entrega, frete: calc.frete_previsto });
      res.push({ id, numero: n.numero, ok: true, previsao_entrega: calc.previsao_entrega, aviso: calc.previsao_entrega ? null : "Sem prazo na tabela: a NF fica sem previsão de entrega." });
    }
    return { ok: true, resultados: res, coletadas: res.filter((x) => x.ok).length };
  });
}

async function marcarEntregue(acc, b = {}) {
  exigirFat(acc);
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Boolean))];
  if (!ids.length) throw erro(400, "Selecione ao menos uma NF.");
  const data = b.data || hoje();
  if (!dataValida(data)) throw erro(400, "Data de entrega inválida.");
  if (data > hoje()) throw erro(400, "A data de entrega não pode ser futura.");
  const quem = txt(b.recebido_por).slice(0, 80) || null;
  return comTransacao(async (c) => {
    const res = [];
    for (const id of ids) {
      const { rows } = await c.query("SELECT * FROM cd_fat_nfs WHERE id = $1 FOR UPDATE", [id]);
      const n = rows[0];
      if (!n || n.status === "cancelada") { res.push({ id, ok: false, motivo: "NF não encontrada." }); continue; }
      if (n.status === "entregue") { res.push({ id, numero: n.numero, ok: false, motivo: "Já está marcada como entregue." }); continue; }
      if (n.status !== "em_transito") { res.push({ id, numero: n.numero, ok: false, motivo: "Marque a coleta antes de marcar a entrega." }); continue; }
      if (n.coleta_data && data < dstr(n.coleta_data)) { res.push({ id, numero: n.numero, ok: false, motivo: `A entrega (${data}) é anterior à coleta (${dstr(n.coleta_data)}).` }); continue; }
      await c.query("UPDATE cd_fat_nfs SET status = 'entregue', entregue_data = $2, entregue_marcada_em = now(), entregue_por = $3, recebido_por = $4, atualizada_em = now() WHERE id = $1", [id, data, acc.email, quem]);
      const prev = dstr(n.previsao_entrega);
      await evento(c, id, "entregue", acc.email, { data, recebido_por: quem, previsao_entrega: prev, no_prazo: prev ? data <= prev : null });
      res.push({ id, numero: n.numero, ok: true, no_prazo: prev ? data <= prev : null });
    }
    return { ok: true, resultados: res, entregues: res.filter((x) => x.ok).length };
  });
}

// volta uma etapa (entregue -> em trânsito; em trânsito -> aguardando coleta). Só o consolidado, com motivo.
async function voltarStatus(acc, id, b = {}) {
  exigirGestor(acc);
  const motivo = txt(b.motivo);
  if (motivo.length < 5) throw erro(422, "Explique o motivo.");
  return comTransacao(async (c) => {
    const { rows } = await c.query("SELECT * FROM cd_fat_nfs WHERE id = $1 FOR UPDATE", [id]);
    const n = rows[0];
    if (!n || n.status === "cancelada") throw erro(404, "NF de saída não encontrada.");
    if (n.status === "entregue") await c.query("UPDATE cd_fat_nfs SET status = 'em_transito', entregue_data = NULL, entregue_marcada_em = NULL, entregue_por = NULL, recebido_por = NULL, atualizada_em = now() WHERE id = $1", [id]);
    else if (n.status === "em_transito") await c.query("UPDATE cd_fat_nfs SET status = 'emitida', coleta_data = NULL, previsao_entrega = NULL, atualizada_em = now() WHERE id = $1", [id]);
    else throw erro(409, "A NF ainda está aguardando coleta.");
    await evento(c, id, "status_revertido", acc.email, { de: n.status, motivo });
    return { ok: true };
  });
}

// cancela (a chave fica livre para reenviar). Mesa de faturamento só cancela o que ainda não foi coletado.
async function cancelarNf(acc, id, b = {}) {
  exigirFat(acc);
  return comTransacao(async (c) => {
    const { rows } = await c.query("SELECT * FROM cd_fat_nfs WHERE id = $1 FOR UPDATE", [id]);
    const n = rows[0];
    if (!n || n.status === "cancelada") throw erro(404, "NF de saída não encontrada.");
    if (n.status !== "emitida" && !ehGestor(acc)) throw erro(403, "Depois da coleta só o consolidado (gestor) cancela a NF.");
    await c.query("UPDATE cd_fat_nfs SET status = 'cancelada', chave = NULL, atualizada_em = now() WHERE id = $1", [id]);
    await evento(c, id, "cancelada", acc.email, { motivo: txt(b.motivo) || null, chave: n.chave, numero: n.numero });
    return { ok: true };
  });
}

async function baixarArquivo(acc, id) {
  exigirFat(acc);
  const { rows } = await pool.query("SELECT n.arquivo_nome, n.tipo, a.conteudo FROM cd_fat_nfs n JOIN cd_fat_nfs_arq a ON a.nfs_id = n.id WHERE n.id = $1", [id]);
  if (!rows[0]) throw erro(404, "Arquivo não encontrado.");
  return { nome: rows[0].arquivo_nome, tipo: rows[0].tipo, conteudo: rows[0].conteudo };
}

// ---------- quadro de trânsito ----------
async function quadro(acc, { dias = 30, transportadora_id, uf } = {}) {
  exigirFat(acc);
  const d = Math.min(Math.max(Number(dias) || 30, 1), 365);
  const dia = hoje();
  const corte = new Date(Date.now() - d * 86400000).toISOString();
  const params = [corte];
  let extra = "";
  if (transportadora_id) { params.push(Number(transportadora_id)); extra += ` AND n.transportadora_id = $${params.length}`; }
  if (uf) { params.push(txt(uf).toUpperCase()); extra += ` AND n.destino_uf = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT ${COLS_LISTA} FROM cd_fat_nfs n LEFT JOIN cd_transportadoras t ON t.id = n.transportadora_id
      WHERE n.status <> 'cancelada' AND (n.status <> 'entregue' OR n.entregue_data >= ($1::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date) ${extra}
      ORDER BY n.id DESC LIMIT 5000`, params);
  const nfs = rows.map((r) => situacao(r, dia));
  const por = (s) => nfs.filter((n) => n.situacao === s);
  const abertas = nfs.filter((n) => n.status !== "entregue");
  const entregues = nfs.filter((n) => n.status === "entregue");
  const comPrev = entregues.filter((n) => n.previsao_entrega);
  const noPrazo = comPrev.filter((n) => n.situacao === "entregue").length;
  const soma = (arr, k) => Math.round(arr.reduce((a, n) => a + (Number(n[k]) || 0), 0) * 100) / 100;
  const media = (arr) => (arr.length ? Math.round(arr.reduce((a, x) => a + x, 0) / arr.length * 10) / 10 : null);
  const transp = {};
  nfs.forEach((n) => {
    const k = n.transportadora || "(sem transportadora)";
    const t = transp[k] || (transp[k] = { nome: k, aguardando: 0, em_transito: 0, atrasadas: 0, entregues: 0, no_prazo: 0, com_previsao: 0, frete_previsto: 0, prometido: [], real: [] });
    if (n.status === "emitida") t.aguardando++;
    if (n.status === "em_transito") { t.em_transito++; if (n.situacao === "atrasada") t.atrasadas++; }
    if (n.status === "entregue") { t.entregues++; if (n.previsao_entrega) { t.com_previsao++; if (n.situacao === "entregue") t.no_prazo++; } if (n.prazo_dias !== null && n.prazo_dias !== undefined) t.prometido.push(Number(n.prazo_dias)); if (n.dias_transito !== null) t.real.push(n.dias_transito); }
    if (n.status !== "entregue") t.frete_previsto += Number(n.frete_previsto) || 0;
  });
  const porTransp = Object.values(transp).map((t) => ({ nome: t.nome, aguardando: t.aguardando, em_transito: t.em_transito, atrasadas: t.atrasadas, entregues: t.entregues, no_prazo_pct: t.com_previsao ? Math.round(t.no_prazo / t.com_previsao * 100) : null, prazo_prometido_medio: media(t.prometido), prazo_real_medio: media(t.real), frete_previsto_aberto: Math.round(t.frete_previsto * 100) / 100 }))
    .sort((a, b) => (b.atrasadas - a.atrasadas) || (b.em_transito - a.em_transito));
  const porUf = {};
  abertas.forEach((n) => { const k = n.destino_uf || "?"; const u = porUf[k] || (porUf[k] = { uf: k, abertas: 0, atrasadas: 0 }); u.abertas++; if (n.situacao === "atrasada") u.atrasadas++; });
  const corta = (arr, k) => arr.slice(0, k);
  const ordem = {
    aguardando_coleta: por("aguardando_coleta").sort((a, b) => b.dias_aguardando - a.dias_aguardando),
    atrasadas: por("atrasada").sort((a, b) => b.dias_atraso - a.dias_atraso),
    vence_hoje: por("vence_hoje"),
    no_prazo: [...por("no_prazo"), ...por("sem_previsao")].sort((a, b) => String(a.previsao_entrega || "9999").localeCompare(String(b.previsao_entrega || "9999"))),
    entregues: entregues.sort((a, b) => String(b.entregue_data).localeCompare(String(a.entregue_data))),
  };
  return {
    hoje: dia, janela_dias: d,
    kpis: {
      aguardando_coleta: ordem.aguardando_coleta.length, paradas: ordem.aguardando_coleta.filter((n) => n.parada).length,
      em_transito: nfs.filter((n) => n.status === "em_transito").length, atrasadas: ordem.atrasadas.length, vence_hoje: ordem.vence_hoje.length,
      sem_previsao: por("sem_previsao").length, sem_transportadora: abertas.filter((n) => !n.transportadora_id).length,
      entregues: entregues.length, no_prazo_pct: comPrev.length ? Math.round(noPrazo / comPrev.length * 100) : null,
      frete_previsto_aberto: soma(abertas, "frete_previsto"), valor_aberto: soma(abertas, "valor"), pecas_abertas: soma(abertas, "pecas"),
      atraso_medio_dias: media(ordem.atrasadas.map((n) => n.dias_atraso)),
    },
    transportadoras: porTransp, ufs: Object.values(porUf).sort((a, b) => b.atrasadas - a.atrasadas || b.abertas - a.abertas),
    colunas: Object.fromEntries(Object.entries(ordem).map(([k, v]) => [k, { total: v.length, nfs: corta(v, 150) }])),
  };
}

// resumo para o painel do consolidado
async function resumo(acc) {
  exigirFat(acc);
  const q = await quadro(acc, { dias: 30 });
  return { kpis: q.kpis };
}

module.exports = {
  lerXmlSaida, calcFrete, addDias, numBR,
  listarTransportadoras, salvarTransportadora, importarTabela, verTabela, limparTabela, simular,
  listarNfs, detalheNf, enviarNf, editarNf, definirTransportadora, marcarColeta, marcarEntregue, voltarStatus, cancelarNf, baixarArquivo, quadro, resumo,
};

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

// modal do frete: cada tabela de frete é rodoviária ou aérea (a transportadora pode ter uma de cada)
const MODAIS = ["rodoviario", "aereo"];
function normModal(x) { const t = semAcento(x); if (/^a[ée]?r|aere|aviao|air/.test(t)) return "aereo"; return "rodoviario"; }
async function modaisDaTransp(db, tid) {
  const { rows } = await db.query("SELECT DISTINCT modal FROM cd_frete_tabela WHERE transportadora_id = $1 ORDER BY modal", [tid]);
  return rows.map((r) => r.modal);
}

// linha da tabela da transportadora que atende UF/cidade/peso (cidade específica vence a regra geral da UF)
async function linhaDaTabela(db, transportadoraId, uf, cidade, peso, modal = "rodoviario") {
  const { rows } = await db.query(
    `SELECT * FROM cd_frete_tabela WHERE transportadora_id = $1 AND uf = $2 AND modal = $5 AND peso_de <= $3 AND (peso_ate IS NULL OR peso_ate >= $3)
        AND (cidade_norm IS NULL OR cidade_norm = $4)
      ORDER BY (cidade_norm IS NULL), peso_de DESC LIMIT 1`, [transportadoraId, uf, peso, semAcento(cidade), modal]);
  return rows[0] || null;
}

async function prazoCadastrado(db, tid, uf, cidade) {
  const { rows } = await db.query(
    `SELECT prazo_dias, cidade_norm FROM cd_transportadora_prazos WHERE transportadora_id = $1 AND uf = $2 AND (cidade_norm IS NULL OR cidade_norm = $3) ORDER BY (cidade_norm IS NULL) LIMIT 1`, [tid, uf, semAcento(cidade)]);
  return rows[0] ? { prazo: Number(rows[0].prazo_dias), origem: rows[0].cidade_norm ? "prazo cadastrado (cidade)" : "prazo cadastrado (UF)" } : null;
}

// escolhe a melhor cotação: "mais_barata", "mais_rapida" ou "equilibrada" (nota ponderada de preço e prazo); prazo_max filtra quem entrega depois
function escolher(cots, modo, { peso_preco = 50, prazo_max = null } = {}) {
  let c = cots.filter((x) => x.ok);
  if (prazo_max !== null && prazo_max !== undefined) c = c.filter((x) => x.prazo_dias !== null && x.prazo_dias <= prazo_max);
  if (modo === "mais_rapida" || modo === "equilibrada") c = c.filter((x) => x.prazo_dias !== null);
  if (!c.length) return null;
  if (modo === "mais_rapida") return c.slice().sort((a, z) => (a.prazo_efetivo - z.prazo_efetivo) || (a.frete - z.frete))[0];
  if (modo === "equilibrada") {
    const w = Math.min(Math.max(Number(peso_preco), 0), 100) / 100;
    const fmin = Math.min(...c.map((x) => x.frete)), fmax = Math.max(...c.map((x) => x.frete)), pmin = Math.min(...c.map((x) => x.prazo_efetivo)), pmax = Math.max(...c.map((x) => x.prazo_efetivo));
    const nota = (x) => w * (fmax > fmin ? (x.frete - fmin) / (fmax - fmin) : 0) + (1 - w) * (pmax > pmin ? (x.prazo_efetivo - pmin) / (pmax - pmin) : 0);
    c.forEach((x) => { x.nota = Math.round(nota(x) * 1000) / 1000; });
    return c.slice().sort((a, z) => (a.nota - z.nota) || (a.frete - z.frete))[0];
  }
  return c.slice().sort((a, z) => (a.frete - z.frete) || ((a.prazo_efetivo ?? 999) - (z.prazo_efetivo ?? 999)))[0];
}
function opcoesBid(b = {}) {
  const pp = b.peso_preco === undefined || b.peso_preco === null || b.peso_preco === "" ? 50 : Math.min(Math.max(Number(b.peso_preco) || 0, 0), 100);
  const pm = b.prazo_max === undefined || b.prazo_max === null || b.prazo_max === "" ? null : Math.max(0, Math.round(Number(b.prazo_max)));
  return { peso_preco: pp, prazo_max: Number.isFinite(pm) ? pm : null };
}

async function cotarCom(db, t, nf, modal = "rodoviario") {
  // t: transportadora {id,nome,prazo_corridos}
  const base = { transportadora_id: Number(t.id), nome: t.nome, prazo_corridos: t.prazo_corridos, modal };
  if (!nf.destino_uf) return { ...base, ok: false, motivo: "Informe a UF do destino." };
  if (nf.peso_kg === null || nf.peso_kg === undefined || Number(nf.peso_kg) <= 0) return { ...base, ok: false, motivo: "Informe o peso da NF." };
  const row = await linhaDaTabela(db, t.id, nf.destino_uf, nf.destino_cidade, Number(nf.peso_kg), modal);
  if (!row) return { ...base, ok: false, motivo: `Sem faixa na tabela${modal === "aereo" ? " aérea" : ""} para ${nf.destino_uf}${nf.destino_cidade ? " / " + nf.destino_cidade : ""} com ${Number(nf.peso_kg)} kg.` };
  const c = calcFrete(row, nf.peso_kg, nf.valor);
  // prazo: o cadastrado por UF/cidade vence o da tabela de frete; sem nenhum dos dois, vale o prazo padrão da transportadora
  const cad = modal === "rodoviario" ? await prazoCadastrado(db, t.id, nf.destino_uf, nf.destino_cidade) : null; // os prazos cadastrados por UF/cidade valem para o rodoviário
  let prazo = null, origem = null;
  if (cad) { prazo = cad.prazo; origem = cad.origem; }
  else if (row.prazo_dias !== null && row.prazo_dias !== undefined) { prazo = Number(row.prazo_dias); origem = "tabela de frete"; }
  else if (modal === "rodoviario") { const pp = t.prazo_padrao !== undefined ? t.prazo_padrao : (await db.query("SELECT prazo_padrao FROM cd_transportadoras WHERE id = $1", [t.id])).rows[0]?.prazo_padrao; if (pp !== null && pp !== undefined) { prazo = Number(pp); origem = "prazo padrão"; } }
  const out = { ...base, ok: true, frete: c.total, memoria: c, prazo_dias: prazo, prazo_origem: origem, prazo_efetivo: prazo === null ? null : (t.prazo_corridos ? prazo : Math.round(prazo * 1.4 * 10) / 10), cidade_regra: row.cidade || null };
  if (nf.valor === null || nf.valor === undefined) out.aviso = "NF sem valor: ad valorem e GRIS não entraram.";
  return out;
}

async function cotacoes(db, nf, opts = {}) {
  const { rows: ts } = await db.query("SELECT id, nome, prazo_corridos, prazo_padrao FROM cd_transportadoras WHERE ativa ORDER BY nome");
  const out = [];
  for (const t of ts) {
    const modais = await modaisDaTransp(db, t.id);
    const cs = [];
    for (const m of (modais.length ? modais : ["rodoviario"])) {
      const c = await cotarCom(db, t, nf, m);
      if (c.ok) {
        const ini = hoje();
        c.previsao_se_coletar_hoje = c.prazo_dias === null ? null : addDias(ini, c.prazo_dias, t.prazo_corridos);
      }
      cs.push(c);
    }
    // se algum modal atende, os que não atendem não entram (evita ruído); senão mostra o motivo do primeiro
    const oks = cs.filter((x) => x.ok);
    if (oks.length) out.push(...oks); else out.push(cs[0]);
  }
  const ok = out.filter((x) => x.ok);
  if (ok.length) {
    const menor = Math.min(...ok.map((x) => x.frete)); ok.forEach((x) => { x.mais_barata = x.frete === menor; });
    const pz = ok.filter((x) => x.prazo_dias !== null);
    if (pz.length) { const mp = Math.min(...pz.map((x) => x.prazo_efetivo)); pz.forEach((x) => { x.mais_rapida = x.prazo_efetivo === mp; }); }
    const bid = opcoesBid(opts);
    if (bid.prazo_max !== null) ok.forEach((x) => { x.dentro_prazo = x.prazo_dias !== null && x.prazo_dias <= bid.prazo_max; });
    const eq = escolher(out, "equilibrada", bid); if (eq) eq.melhor_equilibrio = true;
    if (bid.prazo_max !== null) { const bn = escolher(out, "mais_barata", bid); if (bn) bn.melhor_no_prazo = true; }
  }
  out.sort((a, b) => (b.ok - a.ok) || ((a.frete ?? 1e12) - (b.frete ?? 1e12)));
  return out;
}

// ---------- transportadoras e tabelas ----------
async function listarTransportadoras(acc) {
  exigirFat(acc);
  const { rows } = await pool.query(
    `SELECT t.id, t.nome, t.cnpj, t.prazo_corridos, t.prazo_padrao, t.pag_ciclo, t.pag_base, t.pag_fecha_dow, t.pag_dias, t.pag_dia_fixo, t.ativa, t.tabela_importada_em, t.tabela_importada_por,
            (SELECT count(*)::int FROM cd_frete_tabela f WHERE f.transportadora_id = t.id) AS linhas,
            (SELECT count(DISTINCT uf)::int FROM cd_frete_tabela f WHERE f.transportadora_id = t.id) AS ufs,
            (SELECT count(*)::int FROM cd_transportadora_prazos p WHERE p.transportadora_id = t.id) AS prazos,
            (SELECT coalesce(json_agg(x ORDER BY x.modal), '[]'::json) FROM (SELECT f.modal, count(*)::int AS linhas, count(DISTINCT f.uf)::int AS ufs FROM cd_frete_tabela f WHERE f.transportadora_id = t.id GROUP BY f.modal) x) AS modais
       FROM cd_transportadoras t ORDER BY t.ativa DESC, lower(t.nome)`);
  return { transportadoras: rows };
}

// ---------- prazo de pagamento da transportadora ----------
// ciclo: "nenhum" (cada NF vence na data-base + dias) | "semanal" (fecha num dia da semana) | "quinzenal" (fecha dia 15 e último do mês) | "mensal" (fecha no último dia)
// base: data que entra no ciclo ("emissao", "coleta" ou "entrega"). Vencimento = fechamento + dias corridos, ou o próximo "dia fixo" do mês depois do fechamento.
function lerPagamento(b = {}) {
  const ciclo = ["nenhum", "semanal", "quinzenal", "mensal"].includes(b.pag_ciclo) ? b.pag_ciclo : "nenhum";
  const base = ["emissao", "coleta", "entrega"].includes(b.pag_base) ? b.pag_base : "emissao";
  const n = (v) => (v === undefined || v === null || txt(v) === "" ? null : numBR(v));
  let dow = n(b.pag_fecha_dow), dias = n(b.pag_dias), fixo = n(b.pag_dia_fixo);
  if (dias === null) dias = 0;
  if (!Number.isInteger(dias) || dias < 0 || dias > 365) throw erro(400, "O prazo de pagamento deve ser um número inteiro de dias (0 a 365).");
  if (fixo !== null && (!Number.isInteger(fixo) || fixo < 1 || fixo > 31)) throw erro(400, "O dia fixo de pagamento deve estar entre 1 e 31.");
  if (ciclo === "semanal") { if (dow === null) dow = 5; if (!Number.isInteger(dow) || dow < 0 || dow > 6) throw erro(400, "Dia de fechamento da semana inválido."); } else dow = null;
  if (fixo !== null) dias = 0;
  return { ciclo, base, dow, dias, dia_fixo: fixo };
}
const ymd = (d) => d.toISOString().slice(0, 10);
function somaCorridos(dataStr, n) { const d = new Date(dataStr + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
function ultimoDiaMes(y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }
// fechamento do ciclo que contém a data-base (a própria data, se ela cair no dia de fechamento)
function fechamento(t, base) {
  const d = new Date(base + "T00:00:00Z"), y = d.getUTCFullYear(), m = d.getUTCMonth(), dia = d.getUTCDate();
  if (t.pag_ciclo === "semanal") { const dow = t.pag_fecha_dow === null || t.pag_fecha_dow === undefined ? 5 : Number(t.pag_fecha_dow); return somaCorridos(base, (dow - d.getUTCDay() + 7) % 7); }
  if (t.pag_ciclo === "quinzenal") return dia <= 15 ? ymd(new Date(Date.UTC(y, m, 15))) : ymd(new Date(Date.UTC(y, m, ultimoDiaMes(y, m))));
  if (t.pag_ciclo === "mensal") return ymd(new Date(Date.UTC(y, m, ultimoDiaMes(y, m))));
  return base;
}
function vencimento(t, base) {
  const f = fechamento(t, base);
  if (t.pag_dia_fixo) {
    const d = new Date(f + "T00:00:00Z"); let y = d.getUTCFullYear(), m = d.getUTCMonth();
    for (let i = 0; i < 3; i++) { const alvo = ymd(new Date(Date.UTC(y, m, Math.min(Number(t.pag_dia_fixo), ultimoDiaMes(y, m))))); if (alvo > f) return { fechamento: f, vencimento: alvo }; m++; if (m > 11) { m = 0; y++; } }
  }
  return { fechamento: f, vencimento: somaCorridos(f, Number(t.pag_dias) || 0) };
}
async function salvarTransportadora(acc, id, b = {}) {
  exigirFat(acc);
  const nome = txt(b.nome).slice(0, 80);
  if (nome.length < 2) throw erro(400, "Informe o nome da transportadora.");
  const corr = b.prazo_corridos === true || b.prazo_corridos === "true";
  const ppn = b.prazo_padrao === undefined || b.prazo_padrao === null || txt(b.prazo_padrao) === "" ? null : numBR(b.prazo_padrao);
  if (ppn !== null && (ppn < 0 || ppn > 120 || Math.round(ppn) !== ppn)) throw erro(400, "O prazo padrão deve ser um número inteiro de dias (0 a 120).");
  const pp = ppn;
  let pg = lerPagamento(b);
  if (id && !["pag_ciclo", "pag_base", "pag_fecha_dow", "pag_dias", "pag_dia_fixo"].some((k) => b[k] !== undefined)) { // chamada antiga, sem os campos: mantém o que já está salvo
    const { rows: at } = await pool.query("SELECT pag_ciclo, pag_base, pag_fecha_dow AS dow, pag_dias AS dias, pag_dia_fixo AS dia_fixo FROM cd_transportadoras WHERE id = $1", [id]);
    if (at[0]) pg = { ciclo: at[0].pag_ciclo, base: at[0].pag_base, dow: at[0].dow, dias: at[0].dias, dia_fixo: at[0].dia_fixo };
  }
  try {
    if (id) {
      const { rows } = await pool.query("UPDATE cd_transportadoras SET nome = $2, cnpj = $3, prazo_corridos = $4, ativa = COALESCE($5, ativa), prazo_padrao = $6, pag_ciclo = $7, pag_base = $8, pag_fecha_dow = $9, pag_dias = $10, pag_dia_fixo = $11 WHERE id = $1 RETURNING id", [id, nome, opt(txt(b.cnpj)), corr, b.ativa === undefined ? null : !!b.ativa, pp, pg.ciclo, pg.base, pg.dow, pg.dias, pg.dia_fixo]);
      if (!rows[0]) throw erro(404, "Transportadora não encontrada.");
      const rl = await religarNfs(pool).catch(() => ({ vinculadas: 0 }));
      return { ok: true, id: Number(id), vinculadas: rl.vinculadas };
    }
    const { rows } = await pool.query("INSERT INTO cd_transportadoras (nome, cnpj, prazo_corridos, prazo_padrao, pag_ciclo, pag_base, pag_fecha_dow, pag_dias, pag_dia_fixo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id", [nome, opt(txt(b.cnpj)), corr, pp, pg.ciclo, pg.base, pg.dow, pg.dias, pg.dia_fixo]);
    const rl = await religarNfs(pool).catch(() => ({ vinculadas: 0 }));
    return { ok: true, id: Number(rows[0].id), vinculadas: rl.vinculadas };
  } catch (e) {
    if (e.code === "23505") throw erro(409, "Já existe uma transportadora com esse nome.");
    throw e;
  }
}

const UFS = new Set("AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split(" "));
// rows: [{uf, cidade, peso_de, peso_ate, frete, frete_kg, excedente_kg, adv_pct, gris_pct, taxa_fixa, frete_minimo, prazo_dias, [transportadora]}]
// A importação SUBSTITUI a tabela do(s) modal(is) importado(s) (rodoviário e aéreo são tabelas separadas; a nova vira a vigente).
async function importarTabela(acc, transportadoraId, b = {}) {
  exigirFat(acc);
  const linhas = Array.isArray(b.rows) ? b.rows : [];
  if (!linhas.length) throw erro(400, "A tabela veio vazia.");
  if (linhas.length > 60000) throw erro(413, "Tabela grande demais (máximo 60.000 linhas por transportadora).");
  const ok = [], ignoradas = [];
  const modalPadrao = normModal(b.modal || "rodoviario");
  linhas.forEach((r, i) => {
    const uf = txt(r.uf).toUpperCase();
    if (!UFS.has(uf)) { ignoradas.push({ linha: i + 1, motivo: `UF inválida: "${txt(r.uf)}"` }); return; }
    const peso_de = numBR(r.peso_de) ?? 0, peso_ate = numBR(r.peso_ate);
    if (peso_ate !== null && peso_ate < peso_de) { ignoradas.push({ linha: i + 1, motivo: "Peso final menor que o inicial." }); return; }
    const o = { modal: r.modal !== undefined && txt(r.modal) !== "" ? normModal(r.modal) : modalPadrao, uf, cidade: txt(r.cidade) || null, cidade_norm: semAcento(r.cidade) || null, peso_de, peso_ate, frete: numBR(r.frete), frete_kg: numBR(r.frete_kg), excedente_kg: numBR(r.excedente_kg), adv_pct: numBR(r.adv_pct), gris_pct: numBR(r.gris_pct), taxa_fixa: numBR(r.taxa_fixa), frete_minimo: numBR(r.frete_minimo), prazo_dias: numBR(r.prazo_dias) };
    if ([o.frete, o.frete_kg, o.excedente_kg, o.frete_minimo].every((x) => x === null)) { ignoradas.push({ linha: i + 1, motivo: "Linha sem nenhum valor de frete (frete, R$/kg, excedente ou mínimo)." }); return; }
    if (o.prazo_dias !== null) o.prazo_dias = Math.round(o.prazo_dias);
    ok.push(o);
  });
  if (!ok.length) throw erro(422, "Nenhuma linha válida na tabela.", { ignoradas: ignoradas.slice(0, 30) });
  return comTransacao(async (c) => {
    const { rows: t } = await c.query("SELECT id, nome FROM cd_transportadoras WHERE id = $1 FOR UPDATE", [transportadoraId]);
    if (!t[0]) throw erro(404, "Transportadora não encontrada.");
    const modaisNovos = [...new Set(ok.map((x) => x.modal))];
    await c.query("DELETE FROM cd_frete_tabela WHERE transportadora_id = $1 AND modal = ANY($2::text[])", [transportadoraId, modaisNovos]);
    const CH = 2000;
    for (let i = 0; i < ok.length; i += CH) {
      const p = ok.slice(i, i + CH), col = (k) => p.map((x) => x[k]);
      await c.query(
        `INSERT INTO cd_frete_tabela (transportadora_id, modal, uf, cidade, cidade_norm, peso_de, peso_ate, frete, frete_kg, excedente_kg, adv_pct, gris_pct, taxa_fixa, frete_minimo, prazo_dias)
         SELECT $1, modal, uf, cidade, cidade_norm, peso_de, peso_ate, frete, frete_kg, excedente_kg, adv_pct, gris_pct, taxa_fixa, frete_minimo, prazo_dias
           FROM unnest($15::text[], $2::text[], $3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[], $10::numeric[], $11::numeric[], $12::numeric[], $13::numeric[], $14::int[])
             AS u(modal, uf, cidade, cidade_norm, peso_de, peso_ate, frete, frete_kg, excedente_kg, adv_pct, gris_pct, taxa_fixa, frete_minimo, prazo_dias)`,
        [transportadoraId, col("uf"), col("cidade"), col("cidade_norm"), col("peso_de"), col("peso_ate"), col("frete"), col("frete_kg"), col("excedente_kg"), col("adv_pct"), col("gris_pct"), col("taxa_fixa"), col("frete_minimo"), col("prazo_dias"), col("modal")]);
    }
    await c.query("UPDATE cd_transportadoras SET tabela_importada_em = now(), tabela_importada_por = $2 WHERE id = $1", [transportadoraId, acc.email]);
    return { ok: true, transportadora: t[0].nome, modais: modaisNovos, linhas: ok.length, ignoradas: ignoradas.length, detalhe_ignoradas: ignoradas.slice(0, 30) };
  });
}

async function verTabela(acc, transportadoraId, { uf, modal } = {}) {
  exigirFat(acc);
  const modais = await modaisDaTransp(pool, transportadoraId);
  const md = modal ? normModal(modal) : (modais.includes("rodoviario") ? "rodoviario" : (modais[0] || "rodoviario"));
  const { rows: porUf } = await pool.query("SELECT uf, count(*)::int AS linhas, min(prazo_dias) AS prazo_min, max(prazo_dias) AS prazo_max FROM cd_frete_tabela WHERE transportadora_id = $1 AND modal = $2 GROUP BY uf ORDER BY uf", [transportadoraId, md]);
  const filtro = txt(uf).toUpperCase() || (porUf[0] && porUf[0].uf) || null;
  const { rows } = filtro
    ? await pool.query("SELECT uf, cidade, peso_de::float, peso_ate::float, frete::float, frete_kg::float, excedente_kg::float, adv_pct::float, gris_pct::float, taxa_fixa::float, frete_minimo::float, prazo_dias FROM cd_frete_tabela WHERE transportadora_id = $1 AND uf = $2 AND modal = $3 ORDER BY cidade NULLS FIRST, peso_de LIMIT 500", [transportadoraId, filtro, md])
    : { rows: [] };
  return { modais, modal: md, por_uf: porUf, uf: filtro, linhas: rows };
}

async function limparTabela(acc, transportadoraId, { modal } = {}) {
  exigirGestor(acc);
  if (modal) await pool.query("DELETE FROM cd_frete_tabela WHERE transportadora_id = $1 AND modal = $2", [transportadoraId, normModal(modal)]);
  else await pool.query("DELETE FROM cd_frete_tabela WHERE transportadora_id = $1", [transportadoraId]);
  if (!(await modaisDaTransp(pool, transportadoraId)).length) await pool.query("UPDATE cd_transportadoras SET tabela_importada_em = NULL, tabela_importada_por = NULL WHERE id = $1", [transportadoraId]);
  return { ok: true };
}

async function simular(acc, b = {}) {
  exigirFat(acc);
  const nf = { destino_uf: txt(b.uf).toUpperCase(), destino_cidade: txt(b.cidade), peso_kg: numBR(b.peso), valor: numBR(b.valor) };
  if (!UFS.has(nf.destino_uf)) throw erro(400, "Informe a UF do destino.");
  return { cotacoes: await cotacoes(pool, nf, opcoesBid(b)), bid: opcoesBid(b) };
}

// cotação em lote: várias linhas (UF, cidade, peso, valor) de uma vez contra todas as transportadoras ativas
async function simularLote(acc, b = {}) {
  exigirFat(acc);
  const linhas = Array.isArray(b.rows) ? b.rows : [];
  if (!linhas.length) throw erro(400, "A planilha veio vazia.");
  if (linhas.length > 1500) throw erro(413, "Máximo de 1.500 linhas por cotação em lote.");
  const bid = opcoesBid(b);
  const { rows: ts } = await pool.query("SELECT id::int AS id, nome, prazo_corridos FROM cd_transportadoras WHERE ativa ORDER BY nome");
  const cache = new Map();
  const itens = linhas.map((l, i) => ({ linha: i + 1, ref: txt(l.ref).slice(0, 80), uf: txt(l.uf).toUpperCase(), cidade: txt(l.cidade).slice(0, 120), peso: numBR(l.peso), valor: numBR(l.valor), volumes: l.volumes === undefined || l.volumes === null || l.volumes === "" ? null : numBR(l.volumes) }));
  async function cota(it) {
    if (!UFS.has(it.uf)) { it.erro = `UF inválida: "${it.uf || "vazia"}"`; return; }
    if (!(it.peso > 0)) { it.erro = "Peso inválido ou vazio."; return; }
    const k = [it.uf, semAcento(it.cidade), it.peso, it.valor ?? ""].join("|");
    let r = cache.get(k);
    if (!r) {
      const cots = await cotacoes(pool, { destino_uf: it.uf, destino_cidade: it.cidade, peso_kg: it.peso, valor: it.valor }, bid);
      const pick = (x) => (x ? { id: x.transportadora_id, nome: x.nome, modal: x.modal, frete: x.frete, prazo_dias: x.prazo_dias, prazo_corridos: x.prazo_corridos } : null);
      const umaPorTransp = []; const vistos = new Set();
      cots.slice().sort((a, z) => (z.ok - a.ok) || ((a.frete ?? 1e12) - (z.frete ?? 1e12))).forEach((x) => { if (!vistos.has(x.transportadora_id)) { vistos.add(x.transportadora_id); umaPorTransp.push(x); } });
      r = { cotacoes: umaPorTransp.map((x) => ({ id: x.transportadora_id, modal: x.modal, ok: x.ok, frete: x.ok ? x.frete : null, prazo_dias: x.ok ? x.prazo_dias : null, prazo_corridos: x.prazo_corridos, motivo: x.ok ? null : x.motivo, regra: x.cidade_regra || null })),
        barata: pick(escolher(cots, "mais_barata", { prazo_max: null })), barata_no_prazo: bid.prazo_max !== null ? pick(escolher(cots, "mais_barata", bid)) : null, rapida: pick(escolher(cots, "mais_rapida", { prazo_max: null })), equilibrada: pick(escolher(cots, "equilibrada", bid)) };
      cache.set(k, r);
    }
    Object.assign(it, r);
  }
  for (let i = 0; i < itens.length; i += 8) await Promise.all(itens.slice(i, i + 8).map(cota));
  const comCot = itens.filter((x) => !x.erro && x.cotacoes && x.cotacoes.some((c) => c.ok));
  const soma = (arr, f) => Math.round(arr.reduce((a, x) => a + (f(x) || 0), 0) * 100) / 100;
  const resumo = {
    linhas: itens.length, cotadas: comCot.length, sem_cotacao: itens.length - comCot.length, com_erro: itens.filter((x) => x.erro).length,
    total_mais_barata: soma(comCot, (x) => x.barata && x.barata.frete), total_equilibrada: soma(comCot.filter((x) => x.equilibrada), (x) => x.equilibrada.frete), total_mais_rapida: soma(comCot.filter((x) => x.rapida), (x) => x.rapida.frete),
    peso_kg: soma(comCot, (x) => x.peso), valor: soma(comCot, (x) => x.valor),
    por_transportadora: ts.map((t) => {
      const cs = comCot.map((x) => x.cotacoes.find((c) => c.id === t.id)).filter((c) => c && c.ok);
      const pz = cs.filter((c) => c.prazo_dias !== null).map((c) => c.prazo_dias);
      return { id: t.id, nome: t.nome, atende: cs.length, total_frete: soma(cs, (c) => c.frete), prazo_medio: pz.length ? Math.round(pz.reduce((a, b2) => a + b2, 0) / pz.length * 10) / 10 : null,
        vezes_mais_barata: comCot.filter((x) => x.barata && x.barata.id === t.id).length, vezes_equilibrada: comCot.filter((x) => x.equilibrada && x.equilibrada.id === t.id).length, vezes_mais_rapida: comCot.filter((x) => x.rapida && x.rapida.id === t.id).length };
    }),
  };
  return { transportadoras: ts, bid, resumo, itens };
}

// ---------- prazos de entrega cadastrados por transportadora ----------
async function listarPrazos(acc, id) {
  exigirFat(acc);
  const { rows: t } = await pool.query("SELECT id, nome, prazo_corridos, prazo_padrao FROM cd_transportadoras WHERE id = $1", [id]);
  if (!t[0]) throw erro(404, "Transportadora não encontrada.");
  const { rows } = await pool.query("SELECT uf, cidade, prazo_dias FROM cd_transportadora_prazos WHERE transportadora_id = $1 ORDER BY uf, (cidade IS NOT NULL), lower(coalesce(cidade,''))", [id]);
  return { transportadora: t[0], prazos: rows };
}
// rows: [{uf, cidade, prazo_dias}]. substituir=true troca tudo; senão grava/atualiza linha a linha (prazo vazio apaga a linha).
async function salvarPrazos(acc, id, b = {}) {
  exigirFat(acc);
  const linhas = Array.isArray(b.rows) ? b.rows : [];
  if (linhas.length > 20000) throw erro(413, "Máximo de 20.000 linhas.");
  const { rows: t } = await pool.query("SELECT id FROM cd_transportadoras WHERE id = $1", [id]);
  if (!t[0]) throw erro(404, "Transportadora não encontrada.");
  return comTransacao(async (c) => {
    if (b.substituir) await c.query("DELETE FROM cd_transportadora_prazos WHERE transportadora_id = $1", [id]);
    let gravados = 0, removidos = 0; const ignoradas = [];
    for (let i = 0; i < linhas.length; i++) {
      const l = linhas[i], uf = txt(l.uf).toUpperCase(), cidade = txt(l.cidade).slice(0, 120), cn = cidade ? semAcento(cidade) : null;
      if (!UFS.has(uf)) { ignoradas.push({ linha: i + 1, motivo: `UF inválida: "${txt(l.uf)}"` }); continue; }
      const vazio = l.prazo_dias === undefined || l.prazo_dias === null || txt(l.prazo_dias) === "";
      if (vazio) { const r = await c.query("DELETE FROM cd_transportadora_prazos WHERE transportadora_id = $1 AND uf = $2 AND coalesce(cidade_norm,'') = $3", [id, uf, cn || ""]); removidos += r.rowCount; continue; }
      const pz = numBR(l.prazo_dias);
      if (pz === null || pz < 0 || pz > 120 || Math.round(pz) !== pz) { ignoradas.push({ linha: i + 1, motivo: `Prazo inválido: "${txt(l.prazo_dias)}" (use dias inteiros, 0 a 120)` }); continue; }
      await c.query(`INSERT INTO cd_transportadora_prazos (transportadora_id, uf, cidade, cidade_norm, prazo_dias) VALUES ($1,$2,$3,$4,$5)
                     ON CONFLICT (transportadora_id, uf, coalesce(cidade_norm, '')) DO UPDATE SET prazo_dias = EXCLUDED.prazo_dias, cidade = EXCLUDED.cidade`, [id, uf, cidade || null, cn, pz]);
      gravados++;
    }
    // NFs ainda não coletadas passam a usar os prazos novos
    const { rows: nfs } = await c.query("SELECT id FROM cd_fat_nfs WHERE transportadora_id = $1 AND status = 'emitida' AND NOT prazo_manual", [id]);
    for (const n of nfs) await recalcular(c, Number(n.id)).catch(() => {});
    return { ok: true, gravados, removidos, ignoradas: ignoradas.slice(0, 50), total_ignoradas: ignoradas.length, nfs_recalculadas: nfs.length };
  });
}

// ---------- NFs de saída ----------
const COLS_LISTA = `n.id::int AS id, n.tipo, n.arquivo_nome, n.numero, n.serie, n.chave, n.emitida_em, n.destino_nome, n.destino_cnpj, n.destino_uf, n.destino_cidade, n.destino_cep,
  n.volumes, n.peso_kg::float AS peso_kg, n.valor::float AS valor, n.pecas, n.transportadora_xml, n.transportadora_cnpj, n.transportadora_id::int AS transportadora_id, t.nome AS transportadora, t.prazo_corridos,
  n.frete_previsto::float AS frete_previsto, n.frete_real::float AS frete_real, n.prazo_dias, n.prazo_manual, n.modal, n.status, n.coleta_data, n.previsao_entrega, n.entregue_data, n.entregue_por, n.recebido_por, n.obs, n.enviada_por, n.enviada_em`;

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
    // ainda sem coleta: previsão só estimada, contando da emissão; passa a contar da data da coleta quando ela for marcada
    o.previsao_estimada = n.prazo_dias !== null && n.prazo_dias !== undefined && emi ? addDias(emi, Number(n.prazo_dias), n.prazo_corridos) : null;
    o.estimada_vencida = !!(o.previsao_estimada && dia > o.previsao_estimada);
  }
  return o;
}

// data usada pelo filtro de período (no fuso de São Paulo)
const EXPR_DATA = {
  emissao: "(coalesce(n.emitida_em, n.enviada_em) AT TIME ZONE 'America/Sao_Paulo')::date",
  envio: "(n.enviada_em AT TIME ZONE 'America/Sao_Paulo')::date",
  coleta: "n.coleta_data",
  entrega: "n.entregue_data",
};
function filtrosSql(f, params) {
  const w = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  if (f.status && f.status !== "todas") w.push(`n.status = ${add(f.status)}`); else if (!f.status) w.push("n.status <> 'cancelada'"); else w.push("n.status <> 'cancelada'");
  if (f.transportadora_id) w.push(`n.transportadora_id = ${add(Number(f.transportadora_id))}`);
  if (f.sem_transportadora) w.push("n.transportadora_id IS NULL");
  if (f.uf) w.push(`n.destino_uf = ${add(txt(f.uf).toUpperCase())}`);
  const expr = EXPR_DATA[f.campo] || EXPR_DATA.emissao;
  if (/^\d{4}-\d{2}-\d{2}$/.test(txt(f.de))) w.push(`${expr} >= ${add(txt(f.de))}::date`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(txt(f.ate))) w.push(`${expr} <= ${add(txt(f.ate))}::date`);
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

// ---------- relatório de custos e envios ----------
const r2 = (x) => Math.round(x * 100) / 100;
function somar(list) {
  const o = { nfs: list.length, pecas: 0, volumes: 0, peso_kg: 0, valor: 0, frete: 0, frete_previsto: 0, frete_real: 0, com_frete: 0, com_frete_real: 0, valor_com_frete: 0, peso_com_frete: 0, sem_frete: 0 };
  for (const n of list) {
    o.pecas += Number(n.pecas) || 0; o.volumes += Number(n.volumes) || 0; o.peso_kg += Number(n.peso_kg) || 0; o.valor += Number(n.valor) || 0;
    if (n.custo !== null) { o.com_frete++; o.frete += n.custo; o.valor_com_frete += Number(n.valor) || 0; o.peso_com_frete += Number(n.peso_kg) || 0; } else o.sem_frete++;
    if (n.frete_previsto !== null && n.frete_previsto !== undefined) o.frete_previsto += Number(n.frete_previsto);
    if (n.frete_real !== null && n.frete_real !== undefined) { o.frete_real += Number(n.frete_real); o.com_frete_real++; }
  }
  o.frete_por_kg = o.peso_com_frete > 0 ? r2(o.frete / o.peso_com_frete) : null;
  o.frete_por_nf = o.com_frete > 0 ? r2(o.frete / o.com_frete) : null;
  o.frete_pct_valor = o.valor_com_frete > 0 ? Math.round(o.frete / o.valor_com_frete * 10000) / 100 : null;
  for (const k of ["peso_kg", "valor", "frete", "frete_previsto", "frete_real", "valor_com_frete", "peso_com_frete"]) o[k] = r2(o[k]);
  return o;
}
function agrupar(nfs, chaveFn, rotuloFn) {
  const m = new Map();
  for (const n of nfs) { const k = chaveFn(n); if (!m.has(k)) m.set(k, []); m.get(k).push(n); }
  return [...m.entries()].map(([k, list]) => {
    const e = list.filter((n) => n.status === "entregue");
    const comPrev = e.filter((n) => n.previsao_entrega);
    const reais = e.filter((n) => n.coleta_data && n.entregue_data).map((n) => difDias(n.coleta_data, n.entregue_data));
    const prom = list.filter((n) => n.prazo_dias !== null && n.prazo_dias !== undefined).map((n) => Number(n.prazo_dias));
    const med = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 10) / 10 : null);
    return { chave: k, rotulo: rotuloFn ? rotuloFn(k, list) : k, ...somar(list), entregues: e.length, no_prazo_pct: comPrev.length ? Math.round(comPrev.filter((n) => n.situacao === "entregue").length / comPrev.length * 100) : null,
      atrasadas: list.filter((n) => n.situacao === "atrasada" || n.situacao === "entregue_atrasada").length, prazo_prometido_medio: med(prom), prazo_real_medio: med(reais) };
  });
}
function segunda(d) { const t = new Date(d + "T12:00:00Z"); const dow = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - dow); return t.toISOString().slice(0, 10); }

async function relatorio(acc, f = {}) {
  exigirFat(acc);
  const params = [];
  const ff = { ...f, status: f.status && f.status !== "ativas" ? f.status : "todas" };
  const where = filtrosSql(ff, params);
  const { rows } = await pool.query(`SELECT ${COLS_LISTA} FROM cd_fat_nfs n LEFT JOIN cd_transportadoras t ON t.id = n.transportadora_id ${where} ORDER BY n.id LIMIT 20000`, params);
  const dia = hoje();
  const campo = EXPR_DATA[f.campo] ? f.campo : "emissao";
  const dataDe = (n) => (campo === "coleta" ? n.coleta_data : campo === "entrega" ? n.entregue_data : campo === "envio" ? diaLocal(n.enviada_em) : (n.emitida_em ? diaLocal(n.emitida_em) : diaLocal(n.enviada_em)));
  let nfs = rows.map((r) => situacao(r, dia)).map((n) => ({ ...n, data_ref: dataDe(n) || null, custo: n.frete_real !== null && n.frete_real !== undefined ? n.frete_real : (n.frete_previsto !== null && n.frete_previsto !== undefined ? n.frete_previsto : null),
    custo_tipo: n.frete_real !== null && n.frete_real !== undefined ? "real" : (n.frete_previsto !== null && n.frete_previsto !== undefined ? "previsto" : null) }));
  if (f.situacao) nfs = nfs.filter((n) => n.situacao === f.situacao);
  if (f.status === "ativas") nfs = nfs.filter((n) => n.status !== "entregue");

  // quanto se teria gasto usando a tabela mais barata para cada NF (só com até 1500 NFs, para não pesar)
  let economia = null;
  const alvo = nfs.filter((n) => n.custo !== null && n.destino_uf && Number(n.peso_kg) > 0);
  if (alvo.length && alvo.length <= 1500) {
    const cache = new Map();
    const key = (n) => [n.destino_uf, semAcento(n.destino_cidade || ""), n.peso_kg, n.valor].join("|");
    let ganho = 0, qtd = 0; const porTransp = {};
    for (let i = 0; i < alvo.length; i += 8) {
      await Promise.all(alvo.slice(i, i + 8).map(async (n) => {
        const k = key(n); let m = cache.get(k);
        if (!m) { m = (await cotacoes(pool, n)).filter((c) => c.ok).sort((a, b) => a.frete - b.frete)[0] || null; cache.set(k, m); }
        n.mais_barata = m ? { transportadora: m.nome, frete: m.frete } : null;
        if (m && m.frete < n.custo - 0.004) {
          n.economia_possivel = r2(n.custo - m.frete); ganho += n.economia_possivel; qtd++;
          const nome = n.transportadora || "(sem transportadora)"; porTransp[nome] = (porTransp[nome] || 0) + n.economia_possivel;
        }
      }));
    }
    economia = { total: r2(ganho), nfs: qtd, de: alvo.length, por_transportadora: Object.entries(porTransp).map(([nome, v]) => ({ nome, valor: r2(v) })).sort((a, b) => b.valor - a.valor) };
  }

  const resumo = somar(nfs);
  const stat = (st) => nfs.filter((n) => n.status === st).length;
  resumo.aguardando = stat("emitida"); resumo.em_transito = stat("em_transito"); resumo.entregues = stat("entregue");
  resumo.atrasadas = nfs.filter((n) => n.situacao === "atrasada" || n.situacao === "entregue_atrasada").length;
  const e = nfs.filter((n) => n.status === "entregue"), cp = e.filter((n) => n.previsao_entrega);
  resumo.no_prazo_pct = cp.length ? Math.round(cp.filter((n) => n.situacao === "entregue").length / cp.length * 100) : null;
  const reais = e.filter((n) => n.coleta_data && n.entregue_data).map((n) => difDias(n.coleta_data, n.entregue_data));
  resumo.prazo_real_medio = reais.length ? Math.round(reais.reduce((a, b) => a + b, 0) / reais.length * 10) / 10 : null;
  resumo.lojas = new Set(nfs.map((n) => n.destino_cnpj || n.destino_nome).filter(Boolean)).size;
  resumo.ufs = new Set(nfs.map((n) => n.destino_uf).filter(Boolean)).size;

  const porTransp = agrupar(nfs, (n) => n.transportadora || "(sem transportadora)").sort((a, b) => b.frete - a.frete || b.nfs - a.nfs);
  const porUf = agrupar(nfs, (n) => n.destino_uf || "?").sort((a, b) => b.frete - a.frete || b.nfs - a.nfs);
  const porLoja = agrupar(nfs, (n) => n.destino_cnpj || [n.destino_nome, n.destino_cidade].join("|") || "?", (k, list) => { const n = list[0]; return (n.destino_nome || "(sem loja)") + (n.destino_cidade ? " - " + n.destino_cidade + (n.destino_uf ? "/" + n.destino_uf : "") : n.destino_uf ? " - " + n.destino_uf : ""); }).sort((a, b) => b.frete - a.frete || b.nfs - a.nfs).slice(0, 15);
  // série no tempo: dia (até ~45 dias), semana (até ~200) ou mês
  const datas = nfs.map((n) => n.data_ref).filter(Boolean).sort();
  let gran = "dia";
  if (datas.length) { const span = difDias(datas[0], datas[datas.length - 1]); gran = span <= 45 ? "dia" : span <= 200 ? "semana" : "mes"; }
  const kk = (d) => (gran === "dia" ? d : gran === "semana" ? segunda(d) : d.slice(0, 7));
  const serie = agrupar(nfs.filter((n) => n.data_ref), (n) => kk(n.data_ref)).sort((a, b) => (a.chave < b.chave ? -1 : 1)).map((x) => ({ chave: x.chave, nfs: x.nfs, peso_kg: x.peso_kg, valor: x.valor, frete: x.frete, pecas: x.pecas }));
  const porStatus = [["emitida", "Aguardando coleta"], ["em_transito", "Em trânsito"], ["entregue", "Entregue"]].map(([k, r]) => ({ chave: k, rotulo: r, nfs: stat(k) }));
  return {
    periodo: { campo, de: /^\d{4}-\d{2}-\d{2}$/.test(txt(f.de)) ? f.de : null, ate: /^\d{4}-\d{2}-\d{2}$/.test(txt(f.ate)) ? f.ate : null, primeira: datas[0] || null, ultima: datas[datas.length - 1] || null, granularidade: gran },
    gerado_em: new Date().toISOString(), resumo, por_transportadora: porTransp, por_uf: porUf, por_loja: porLoja, serie, por_status: porStatus, economia,
    nfs: nfs.map((n) => ({ id: n.id, numero: n.numero, serie: n.serie, data_ref: n.data_ref, emitida_em: n.emitida_em, loja: n.destino_nome, cnpj: n.destino_cnpj, uf: n.destino_uf, cidade: n.destino_cidade, pecas: n.pecas, volumes: n.volumes, peso_kg: n.peso_kg, valor: n.valor,
      transportadora: n.transportadora || null, transportadora_na_nf: n.transportadora_xml || null, frete_previsto: n.frete_previsto, frete_real: n.frete_real, custo: n.custo, custo_tipo: n.custo_tipo, prazo_dias: n.prazo_dias, status: n.status, situacao: n.situacao,
      coleta_data: n.coleta_data, previsao_entrega: n.previsao_entrega, previsao_estimada: n.previsao_estimada || null, entregue_data: n.entregue_data, mais_barata: n.mais_barata ? n.mais_barata.transportadora : null, frete_mais_barata: n.mais_barata ? n.mais_barata.frete : null, economia_possivel: n.economia_possivel || 0 })),
  };
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
  let frete = null, prazo = n.prazo_manual ? n.prazo_dias : null, aviso = null, modal = n.modal || "rodoviario";
  if (n.transportadora_id) {
    const { rows: ts } = await db.query("SELECT id, nome, prazo_corridos, prazo_padrao FROM cd_transportadoras WHERE id = $1", [n.transportadora_id]);
    // a transportadora não tem tabela desse modal: usa o rodoviário (ou o único que ela tem)
    const mds = await modaisDaTransp(db, n.transportadora_id);
    if (mds.length && !mds.includes(modal)) modal = mds.includes("rodoviario") ? "rodoviario" : mds[0];
    const c = await cotarCom(db, ts[0], n, modal);
    if (c.ok) { frete = c.frete; if (!n.prazo_manual) prazo = c.prazo_dias; if (prazo === null || prazo === undefined) aviso = "A tabela não traz prazo para essa faixa (informe o prazo à mão)."; }
    else { aviso = c.motivo; }
  }
  const prev = n.coleta_data && prazo !== null && prazo !== undefined ? addDias(dstr(n.coleta_data), prazo, n.prazo_corridos) : null;
  await db.query("UPDATE cd_fat_nfs SET frete_previsto = $2, prazo_dias = $3, previsao_entrega = $4, modal = $5, atualizada_em = now() WHERE id = $1", [id, frete, prazo, prev, modal]);
  return { frete_previsto: frete, prazo_dias: prazo, previsao_entrega: prev, modal, aviso };
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

// Liga às transportadoras cadastradas as NFs que ainda não têm transportadora e cujo nome/CNPJ lido na nota bate com uma delas.
async function religarNfs(db) {
  const { rows: grupos } = await db.query(
    `SELECT transportadora_xml AS nome, coalesce(transportadora_cnpj,'') AS cnpj FROM cd_fat_nfs
      WHERE transportadora_id IS NULL AND status <> 'cancelada' AND (coalesce(transportadora_xml,'') <> '' OR coalesce(transportadora_cnpj,'') <> '') GROUP BY 1, 2`);
  let vinculadas = 0;
  for (const g of grupos) {
    const tid = await acharTransportadoraXml(db, g.nome, g.cnpj);
    if (!tid) continue;
    const { rows } = await db.query(
      `UPDATE cd_fat_nfs SET transportadora_id = $1, atualizada_em = now()
        WHERE transportadora_id IS NULL AND status <> 'cancelada' AND coalesce(transportadora_xml,'') = coalesce($2,'') AND coalesce(transportadora_cnpj,'') = $3 RETURNING id, status`,
      [tid, g.nome || null, g.cnpj]);
    for (const r of rows) { if (r.status !== "entregue") await recalcular(db, Number(r.id)).catch(() => {}); vinculadas++; }
  }
  return { vinculadas };
}

// Transportadoras que vieram escritas nas notas e ainda não estão ligadas a nenhuma cadastrada.
async function transportadorasLidas(acc) {
  exigirFat(acc);
  await religarNfs(pool);
  const { rows } = await pool.query(
    `SELECT coalesce(transportadora_xml,'') AS nome, coalesce(transportadora_cnpj,'') AS cnpj, count(*)::int AS qtd
       FROM cd_fat_nfs WHERE transportadora_id IS NULL AND status <> 'cancelada' AND (coalesce(transportadora_xml,'') <> '' OR coalesce(transportadora_cnpj,'') <> '')
      GROUP BY 1, 2 ORDER BY qtd DESC, nome`);
  const { rows: sem } = await pool.query("SELECT count(*)::int AS n FROM cd_fat_nfs WHERE transportadora_id IS NULL AND status <> 'cancelada' AND coalesce(transportadora_xml,'') = '' AND coalesce(transportadora_cnpj,'') = ''");
  return { lidas: rows, sem_leitura: sem[0].n };
}

// itens: [{nome, cnpj, transportadora_id?}] — sem transportadora_id cadastra uma nova com o nome lido; com id liga à existente
// (e, se ela ainda não tem CNPJ, guarda o lido para as próximas notas casarem sozinhas).
async function vincularLidas(acc, b = {}) {
  exigirFat(acc);
  const itens = Array.isArray(b.itens) ? b.itens.slice(0, 100) : [];
  return comTransacao(async (c) => {
    let criadas = 0, ligadas = 0;
    for (const it of itens) {
      const nome = txt(it.nome).slice(0, 80), cnpj = txt(it.cnpj).replace(/\D/g, "").slice(0, 14);
      if (!nome && !cnpj) continue;
      let tid = it.transportadora_id ? Number(it.transportadora_id) : null;
      if (tid) {
        const { rows } = await c.query("SELECT id, cnpj FROM cd_transportadoras WHERE id = $1", [tid]);
        if (!rows[0]) throw erro(404, "Transportadora escolhida não existe.");
        if (cnpj && !String(rows[0].cnpj || "").replace(/\D/g, "")) await c.query("UPDATE cd_transportadoras SET cnpj = $2 WHERE id = $1", [tid, cnpj]);
      } else {
        if (nome.length < 2) continue;
        const { rows } = await c.query(
          `INSERT INTO cd_transportadoras (nome, cnpj) VALUES ($1,$2)
             ON CONFLICT (lower(nome)) DO UPDATE SET ativa = true, cnpj = coalesce(cd_transportadoras.cnpj, EXCLUDED.cnpj) RETURNING id, (xmax = 0) AS nova`, [nome, cnpj || null]);
        tid = Number(rows[0].id); if (rows[0].nova) criadas++;
      }
      const { rows: up } = await c.query(
        `UPDATE cd_fat_nfs SET transportadora_id = $1, atualizada_em = now()
          WHERE transportadora_id IS NULL AND status <> 'cancelada' AND coalesce(transportadora_xml,'') = $2 AND coalesce(transportadora_cnpj,'') = $3 RETURNING id, status`, [tid, nome, cnpj]);
      for (const r of up) { if (r.status !== "entregue") await recalcular(c, Number(r.id)).catch(() => {}); ligadas++; }
      if (up.length) await c.query("INSERT INTO cd_fat_eventos (nfs_id, tipo, usuario, detalhe) SELECT id, 'transportadora', $2, $3::jsonb FROM cd_fat_nfs WHERE id = ANY($1)", [up.map((r) => Number(r.id)), acc.email, JSON.stringify({ transportadora_id: tid, origem: "lida na NF", lida: nome || cnpj })]);
    }
    const rl = await religarNfs(c);
    return { ok: true, criadas, vinculadas: ligadas + rl.vinculadas };
  });
}

// Exclui de vez NFs de saída anexadas (arquivo, dados e histórico); guarda só um registro de quem excluiu.
// Mesa de faturamento exclui o que ainda não foi coletado; depois disso só o consolidado (gestor).
async function excluirNfs(acc, b = {}) {
  exigirFat(acc);
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Boolean))];
  if (!ids.length) throw erro(400, "Selecione ao menos uma NF.");
  if (ids.length > 500) throw erro(400, "Selecione no máximo 500 NFs por vez.");
  const motivo = txt(b.motivo).slice(0, 300) || null;
  return comTransacao(async (c) => {
    const res = []; let n = 0;
    for (const id of ids) {
      const { rows } = await c.query("SELECT id, numero, serie, chave, destino_nome, status, arquivo_nome FROM cd_fat_nfs WHERE id = $1 FOR UPDATE", [id]);
      const x = rows[0];
      if (!x) { res.push({ id, ok: false, motivo: "NF não encontrada (talvez já excluída)." }); continue; }
      if (x.status !== "emitida" && x.status !== "cancelada" && !ehGestor(acc)) { res.push({ id, numero: x.numero, ok: false, motivo: "Já foi coletada/entregue: só o consolidado (gestor) exclui." }); continue; }
      await c.query("INSERT INTO cd_fat_excluidas (nfs_id, numero, serie, chave, destino, status, arquivo_nome, motivo, excluida_por) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [x.id, x.numero, x.serie, x.chave, x.destino_nome, x.status, x.arquivo_nome, motivo, acc.email]);
      await c.query("DELETE FROM cd_fat_nfs WHERE id = $1", [id]);
      res.push({ id, numero: x.numero, ok: true }); n++;
    }
    return { ok: true, excluidas: n, resultados: res };
  });
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
      `INSERT INTO cd_fat_nfs (tipo, arquivo_nome, tamanho, numero, serie, chave, emitida_em, destino_nome, destino_cnpj, destino_uf, destino_cidade, destino_cep, volumes, peso_kg, valor, pecas, transportadora_xml, transportadora_cnpj, transportadora_id, enviada_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
      [tipo, nome, buf.length, m.numero || null, m.serie || null, m.chave || null, m.emitida_em || null, m.destino_nome || null, m.destino_cnpj || null, m.destino_uf || null, m.destino_cidade || null, m.destino_cep || null,
        m.volumes ?? null, m.peso_kg ?? null, m.valor ?? null, m.pecas ?? null, m.transportadora_xml || null, m.transportadora_cnpj || null, tid, acc.email]);
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
        if (b.modal === undefined) sets.push("modal = 'rodoviario'");
        mud.push({ campo: "transportadora_id", de: cur.transportadora_id, para: tid }); recalc = true;
      }
    }
    if (b.modal !== undefined) {
      const md = normModal(b.modal);
      if (md !== (cur.modal || "rodoviario")) { vals.push(md); sets.push(`modal = $${vals.length}`); sets.push("prazo_manual = false"); sets.push("prazo_dias = NULL"); mud.push({ campo: "modal", de: cur.modal, para: md }); recalc = true; }
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
  const modo = ["mais_barata", "mais_rapida", "equilibrada"].includes(b.modo) ? b.modo : null;
  const bid = opcoesBid(b);
  const tid = b.transportadora_id ? Number(b.transportadora_id) : null;
  if (!modo && !tid) throw erro(400, "Escolha a transportadora (ou o modo automático).");
  return comTransacao(async (c) => {
    const res = [];
    for (const id of ids) {
      const { rows } = await c.query("SELECT * FROM cd_fat_nfs WHERE id = $1 FOR UPDATE", [id]);
      const n = rows[0];
      if (!n || n.status === "cancelada") { res.push({ id, ok: false, motivo: "NF não encontrada." }); continue; }
      if (n.status === "entregue") { res.push({ id, numero: n.numero, ok: false, motivo: "Já foi entregue." }); continue; }
      let alvo = tid, modalAlvo = "rodoviario";
      if (modo) {
        const cot = (await cotacoes(c, n)).filter((x) => x.ok);
        if (!cot.length) { res.push({ id, numero: n.numero, ok: false, motivo: "Nenhuma tabela atende essa NF (confira UF, peso e tabelas)." }); continue; }
        const esc = escolher(cot, modo, bid);
        if (!esc) { res.push({ id, numero: n.numero, ok: false, motivo: bid.prazo_max !== null ? `Nenhuma transportadora entrega em até ${bid.prazo_max} dia(s) para essa NF.` : "As transportadoras não têm prazo cadastrado para esse destino." }); continue; }
        alvo = esc.transportadora_id; modalAlvo = esc.modal || "rodoviario";
      }
      else modalAlvo = b.modal ? normModal(b.modal) : (alvo === (n.transportadora_id ? Number(n.transportadora_id) : null) ? (n.modal || "rodoviario") : "rodoviario");
      await c.query("UPDATE cd_fat_nfs SET transportadora_id = $2, modal = $3, prazo_dias = NULL, prazo_manual = false WHERE id = $1", [id, alvo, modalAlvo]);
      const calc = await recalcular(c, id);
      await evento(c, id, "transportadora", acc.email, { de: n.transportadora_id, para: alvo, modal: calc.modal, modo: modo || "manual", ...(modo === "equilibrada" ? { peso_preco: bid.peso_preco } : {}), ...(bid.prazo_max !== null && modo ? { prazo_max: bid.prazo_max } : {}), frete: calc.frete_previsto, prazo_dias: calc.prazo_dias });
      res.push({ id, numero: n.numero, ok: true, transportadora_id: alvo, modal: calc.modal, frete_previsto: calc.frete_previsto, prazo_dias: calc.prazo_dias, aviso: calc.aviso });
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
      if (alvo !== (n.transportadora_id ? Number(n.transportadora_id) : null)) await c.query("UPDATE cd_fat_nfs SET transportadora_id = $2, modal = 'rodoviario', prazo_dias = NULL, prazo_manual = false WHERE id = $1", [id, alvo]);
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
async function quadro(acc, { dias = 30, transportadora_id, uf, modal } = {}) {
  exigirFat(acc);
  const d = Math.min(Math.max(Number(dias) || 30, 1), 365);
  const dia = hoje();
  const corte = new Date(Date.now() - d * 86400000).toISOString();
  const params = [corte];
  let extra = "";
  if (transportadora_id) { params.push(Number(transportadora_id)); extra += ` AND n.transportadora_id = $${params.length}`; }
  if (uf) { params.push(txt(uf).toUpperCase()); extra += ` AND n.destino_uf = $${params.length}`; }
  if (modal && MODAIS.includes(normModal(modal))) { params.push(normModal(modal)); extra += ` AND n.transportadora_id IS NOT NULL AND n.modal = $${params.length}`; }
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
      aereo_abertas: abertas.filter((n) => n.transportadora_id && n.modal === "aereo").length, rodoviario_abertas: abertas.filter((n) => n.transportadora_id && n.modal !== "aereo").length,
    },
    transportadoras: porTransp, ufs: Object.values(porUf).sort((a, b) => b.atrasadas - a.atrasadas || b.abertas - a.abertas),
    colunas: Object.fromEntries(Object.entries(ordem).map(([k, v]) => [k, { total: v.length, nfs: corta(v, 150) }])),
  };
}

// fluxo de pagamento às transportadoras (consolidado): frete (real, senão previsto) de cada NF + regra de pagamento da transportadora
async function fluxoPagamento(acc, { dias = 90 } = {}) {
  exigirGestor(acc);
  const d = Math.min(Math.max(Number(dias) || 90, 7), 365), dia = hoje();
  const corte = new Date(Date.now() - d * 86400000).toISOString();
  const { rows } = await pool.query(
    `SELECT n.id::int AS id, n.numero, n.status, n.emitida_em, n.enviada_em, n.coleta_data, n.entregue_data, n.previsao_entrega, COALESCE(n.frete_real, n.frete_previsto)::float AS frete,
            t.id::int AS tid, t.nome, t.pag_ciclo, t.pag_base, t.pag_fecha_dow, t.pag_dias, t.pag_dia_fixo
       FROM cd_fat_nfs n JOIN cd_transportadoras t ON t.id = n.transportadora_id
      WHERE n.status <> 'cancelada' AND COALESCE(n.frete_real, n.frete_previsto) IS NOT NULL AND COALESCE(n.emitida_em, n.enviada_em) >= $1::timestamptz`, [corte]);
  const r2 = (x) => Math.round(x * 100) / 100;
  const seg = (ds) => { const x = new Date(ds + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return ymd(x); }; // segunda-feira da semana
  const porT = new Map(), semanas = new Map(), prox = new Map();
  const k = { total: 0, vencido: 0, em_7: 0, em_30: 0, depois: 0, sem_data: 0, estimado: 0 };
  const iniSem = seg(dia), NSEM = 8;
  rows.forEach((n) => {
    const t = porT.get(n.tid) || { id: n.tid, nome: n.nome, ciclo: n.pag_ciclo, base: n.pag_base, fecha_dow: n.pag_fecha_dow, dias: n.pag_dias, dia_fixo: n.pag_dia_fixo, configurada: !!(n.pag_ciclo !== "nenhum" || n.pag_dias || n.pag_dia_fixo), nfs: 0, total: 0, vencido: 0, em_7: 0, em_30: 0, depois: 0, sem_data: 0, soma_prazo: 0, soma_val: 0 };
    porT.set(n.tid, t);
    t.nfs++; t.total += n.frete;
    let base = null, estimada = false;
    if (n.pag_base === "entrega") { if (n.entregue_data) base = dstr(n.entregue_data); else if (n.previsao_entrega) { base = dstr(n.previsao_entrega); estimada = true; } }
    else if (n.pag_base === "coleta") base = n.coleta_data ? dstr(n.coleta_data) : null;
    else base = diaLocal(n.emitida_em || n.enviada_em);
    if (!base) { t.sem_data += n.frete; k.sem_data += n.frete; k.total += n.frete; return; }
    const v = vencimento(n, base).vencimento, dd = difDias(dia, v);
    k.total += n.frete; if (estimada) k.estimado += n.frete;
    t.soma_prazo += difDias(base, v) * n.frete; t.soma_val += n.frete;
    if (dd < 0) { t.vencido += n.frete; k.vencido += n.frete; }
    else if (dd <= 7) { t.em_7 += n.frete; k.em_7 += n.frete; t.em_30 += n.frete; k.em_30 += n.frete; }
    else if (dd <= 30) { t.em_30 += n.frete; k.em_30 += n.frete; }
    else { t.depois += n.frete; k.depois += n.frete; }
    if (dd >= 0) {
      const wk = difDias(iniSem, seg(v)) / 7;
      const chave = wk >= NSEM ? "depois" : String(wk);
      const w = semanas.get(chave) || { chave, inicio: wk >= NSEM ? null : somaCorridos(iniSem, wk * 7), total: 0, por: {} };
      w.total += n.frete; w.por[n.nome] = (w.por[n.nome] || 0) + n.frete; semanas.set(chave, w);
      const pk = v + "|" + n.tid; const p = prox.get(pk) || { vencimento: v, transportadora: n.nome, valor: 0, nfs: 0, estimado: false }; p.valor += n.frete; p.nfs++; if (estimada) p.estimado = true; prox.set(pk, p);
    }
    if (dd < 0) { const w = semanas.get("vencido") || { chave: "vencido", inicio: null, total: 0, por: {} }; w.total += n.frete; w.por[n.nome] = (w.por[n.nome] || 0) + n.frete; semanas.set("vencido", w); }
  });
  const ordem = ["vencido", ...Array.from({ length: NSEM }, (_, i) => String(i)), "depois"];
  const sem = ordem.map((c) => semanas.get(c) || { chave: c, inicio: c === "vencido" || c === "depois" ? null : somaCorridos(iniSem, Number(c) * 7), total: 0, por: {} })
    .map((w) => ({ ...w, total: r2(w.total), por: Object.fromEntries(Object.entries(w.por).map(([a, b]) => [a, r2(b)])) }));
  const tr = [...porT.values()].map((t) => ({ id: t.id, nome: t.nome, ciclo: t.ciclo, base: t.base, fecha_dow: t.fecha_dow, dias: t.dias, dia_fixo: t.dia_fixo, configurada: t.configurada, nfs: t.nfs, total: r2(t.total), vencido: r2(t.vencido), em_7: r2(t.em_7), em_30: r2(t.em_30), depois: r2(t.depois), sem_data: r2(t.sem_data), prazo_medio_dias: t.soma_val ? Math.round(t.soma_prazo / t.soma_val * 10) / 10 : null }))
    .sort((a, b) => b.total - a.total);
  // transportadoras ativas ainda sem regra de pagamento (aparecem como alerta)
  const { rows: sem_regra } = await pool.query("SELECT id::int AS id, nome FROM cd_transportadoras WHERE ativa AND pag_ciclo = 'nenhum' AND pag_dias = 0 AND pag_dia_fixo IS NULL ORDER BY nome");
  return { hoje: dia, janela_dias: d, semana_inicio: iniSem, kpis: Object.fromEntries(Object.entries(k).map(([a, b]) => [a, r2(b)])), semanas: sem, transportadoras: tr, proximos: [...prox.values()].map((p) => ({ ...p, valor: r2(p.valor) })).sort((a, b) => a.vencimento.localeCompare(b.vencimento) || b.valor - a.valor).slice(0, 40), sem_regra };
}

// resumo para o painel do consolidado
async function resumo(acc) {
  exigirFat(acc);
  const q = await quadro(acc, { dias: 30 });
  return { kpis: q.kpis };
}

const VERSAO = "2026-10-21.4";
module.exports = {
  VERSAO, lerXmlSaida, calcFrete, addDias, numBR,
  listarTransportadoras, salvarTransportadora, importarTabela, verTabela, limparTabela, simular,
  normModal, fluxoPagamento, vencimento, listarNfs, detalheNf, enviarNf, editarNf, definirTransportadora, marcarColeta, marcarEntregue, voltarStatus, cancelarNf, excluirNfs, relatorio, simularLote, listarPrazos, salvarPrazos, transportadorasLidas, vincularLidas, baixarArquivo, quadro, resumo,
};

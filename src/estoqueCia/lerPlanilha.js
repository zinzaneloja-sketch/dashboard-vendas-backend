// Lê a planilha "Estoque Omni" (a mesma que o time já gera todo dia) e devolve só o que o
// Estoque Cia precisa, em formato enxuto. Usa o leitor em streaming do exceljs pra não
// carregar o arquivo inteiro (16 MB+, ~70 mil linhas) na memória do servidor.
//
// As abas são reconhecidas pelo CABEÇALHO, não pelo nome, pra não quebrar se alguém
// renomear a aba:
//  - Estoque ............ tem as colunas "filial" e "ES1" (uma linha por produto × cor × filial,
//                         com ES1..ES11 = peças por posição de tamanho)
//  - Todos os produtos .. tem "produto" e "grupo_produto" (categoria, linha e flag de liquidação)
//  - OMNIS .............. primeira coluna "Omnis" (lista de lojas OMNI) — só usada se a coluna
//                         "Omni" da aba Estoque vier sem valor calculado
//
// As colunas calculadas por fórmula na planilha (Ref_Cor, Nome Produto, Preço atual, Omni,
// Foto na Pasta, Liqui) são lidas pelo VALOR já calculado que o Excel salva no arquivo.
const ExcelJS = require("exceljs");

const NUM_TAMANHOS = 11;

function valor(v) {
  if (v == null) return null;
  if (typeof v === "object") {
    if (v instanceof Date) return v;
    if ("result" in v) return valor(v.result); // célula com fórmula: usa o valor calculado
    if (v.richText) return v.richText.map((t) => t.text).join("");
    if ("text" in v) return v.text;
    if (v.error) return null; // #N/A, #REF! etc.
    return null;
  }
  return v;
}
const txt = (v) => {
  const x = valor(v);
  return x == null ? "" : String(x).trim();
};
const num = (v) => {
  const x = valor(v);
  if (x == null || x === "") return 0;
  const n = typeof x === "number" ? x : Number(String(x).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

function indexar(cabecalho) {
  const idx = {};
  cabecalho.forEach((c, i) => {
    const k = txt(c);
    if (k && !(k in idx)) idx[k] = i;
  });
  return idx;
}

/**
 * @param {string|import('stream').Readable} entrada caminho do arquivo ou stream
 * @returns {Promise<{itens: object[], produtos: Map, lojasOmni: Set, avisos: string[]}>}
 */
async function lerPlanilhaEstoque(entrada) {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(entrada, {
    sharedStrings: "cache",
    hyperlinks: "ignore",
    styles: "ignore",
    worksheets: "emit",
    entries: "emit",
  });

  const itens = [];
  const produtos = new Map();
  const lojasOmni = new Set();
  const avisos = [];
  let achouEstoque = false;

  for await (const ws of reader) {
    let tipo = null;
    let idx = null;
    for await (const row of ws) {
      const vals = row.values; // 1-indexado
      if (!idx) {
        const cab = indexar(vals);
        if ("filial" in cab && "ES1" in cab && "produto" in cab) tipo = "estoque";
        else if ("produto" in cab && "grupo_produto" in cab) tipo = "produtos";
        else if ("Omnis" in cab) tipo = "omnis";
        else break; // aba que não interessa: pula o resto dela
        idx = cab;
        continue;
      }
      if (tipo === "estoque") {
        const produto = txt(vals[idx.produto]);
        const filial = txt(vals[idx.filial]);
        if (!produto || !filial) continue;
        const cor = txt(vals[idx.cor_produto]);
        const tam = [];
        for (let i = 1; i <= NUM_TAMANHOS; i++) {
          const col = idx["ES" + i];
          tam.push(col == null ? 0 : Math.max(0, Math.round(num(vals[col]))));
        }
        const omniTxt = idx.Omni != null ? txt(vals[idx.Omni]).toUpperCase() : "";
        const fotoTxt = idx["Foto na Pasta"] != null ? txt(vals[idx["Foto na Pasta"]]).toUpperCase() : "";
        itens.push({
          produto,
          cor,
          refCor: txt(vals[idx.Ref_Cor]) || `${produto}_${cor}`,
          nome: txt(vals[idx["Nome Produto"]]).replace(/\s+/g, " "),
          filial,
          preco: num(vals[idx["Preço atual"]]),
          omni: omniTxt ? omniTxt === "OMNI" : null,
          foto: fotoTxt ? fotoTxt === "COM FOTO" : null,
          tam,
        });
        achouEstoque = true;
      } else if (tipo === "produtos") {
        const p = txt(vals[idx.produto]);
        if (!p || produtos.has(p)) continue;
        produtos.set(p, {
          nome: txt(vals[idx.desc_produto]).replace(/\s+/g, " "),
          grupo: txt(vals[idx.grupo_produto]) || "SEM GRUPO",
          linha: txt(vals[idx.linha]) || "SEM LINHA",
          liqui: idx.Liqui != null ? txt(vals[idx.Liqui]) === "Liqui" : false,
        });
      } else if (tipo === "omnis") {
        const l = txt(vals[idx.Omnis]);
        if (l) lojasOmni.add(l);
      }
    }
  }

  if (!achouEstoque) throw new Error('Não encontrei a aba de estoque (cabeçalho com "produto", "filial" e "ES1") na planilha.');
  // Coluna Omni sem valor calculado → usa a lista da aba OMNIS
  const semOmni = itens.filter((i) => i.omni == null).length;
  if (semOmni) {
    if (!lojasOmni.size) avisos.push(`${semOmni} linhas sem a coluna Omni calculada e sem aba OMNIS: tratadas como não OMNI.`);
    itens.forEach((i) => { if (i.omni == null) i.omni = lojasOmni.has(i.filial); });
  }
  itens.forEach((i) => { if (i.foto == null) i.foto = false; });
  if (!produtos.size) avisos.push('Aba "Todos os produtos" não encontrada: categoria, linha e liquidação ficam em branco.');
  return { itens, produtos, lojasOmni, avisos };
}

module.exports = { lerPlanilhaEstoque, NUM_TAMANHOS };

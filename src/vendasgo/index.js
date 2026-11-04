const v = require("./vendasgo");
const rel = require("./relatorio");
module.exports = { ...v, relatorioGeral: rel.geral, relatorioLojas: rel.lojas };

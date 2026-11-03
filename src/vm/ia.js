// Cliente da IA (Claude, API da Anthropic) usado pelo módulo de Visual Merchandising.
// A chave fica só no servidor (variável ANTHROPIC_API_KEY do Railway). O navegador nunca a vê.
const API_URL = () => process.env.VM_IA_URL || "https://api.anthropic.com/v1/messages";
const MODELO = () => process.env.VM_IA_MODELO || "claude-sonnet-4-5";
const PRECO_IN = () => Number(process.env.VM_IA_PRECO_IN || 3);    // US$ por milhão de tokens (entrada)
const PRECO_OUT = () => Number(process.env.VM_IA_PRECO_OUT || 15); // US$ por milhão de tokens (saída)
const TIMEOUT_MS = () => Number(process.env.VM_IA_TIMEOUT_MS || 120000);
const TENTATIVAS = () => Number(process.env.VM_IA_TENTATIVAS || 3);
const ESPERA_MS = () => Number(process.env.VM_IA_ESPERA_MS || 1500);

const PROMPT_MANUAL = "manual-v1";
const PROMPT_FOTO = "foto-v1";

const configurada = () => !!process.env.ANTHROPIC_API_KEY;
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

function erroIA(msg, indisponivel, extra) { const e = new Error(msg); e.status = indisponivel ? 503 : 502; e.ia_indisponivel = !!indisponivel; if (extra) e.extra = extra; return e; }

// Uma chamada com "ferramenta obrigatória": a IA só pode responder preenchendo o JSON da ferramenta.
async function chamar({ system, content, ferramenta, maxTokens = 4096 }) {
  if (!configurada()) throw erroIA("A IA ainda não foi configurada no servidor (falta a chave ANTHROPIC_API_KEY).", true);
  const corpo = {
    model: MODELO(), max_tokens: maxTokens, system,
    messages: [{ role: "user", content }],
    tools: [ferramenta], tool_choice: { type: "tool", name: ferramenta.name },
  };
  const ini = Date.now();
  let ultimo = null;
  for (let t = 1; t <= TENTATIVAS(); t++) {
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), TIMEOUT_MS());
      let r;
      try {
        r = await fetch(API_URL(), { method: "POST", signal: ctl.signal, headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, body: JSON.stringify(corpo) });
      } finally { clearTimeout(to); }
      if (r.status === 429 || r.status >= 500) { ultimo = erroIA("A IA está indisponível no momento (HTTP " + r.status + ").", true); await dorme(ESPERA_MS() * t); continue; }
      const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (_) { /* resposta inválida */ }
      if (r.status === 401 || r.status === 403) throw erroIA("A chave da IA foi recusada (HTTP " + r.status + "). Confira ANTHROPIC_API_KEY.", true);
      if (!r.ok) throw erroIA("A IA recusou o pedido (HTTP " + r.status + "): " + String((j && j.error && j.error.message) || txt).slice(0, 300), false);
      if (!j) throw erroIA("Resposta da IA ilegível.", false);
      const bloco = (j.content || []).find((b) => b.type === "tool_use" && b.name === ferramenta.name);
      if (!bloco || typeof bloco.input !== "object" || !bloco.input) throw erroIA("A IA não devolveu o resultado no formato esperado.", false);
      const tin = (j.usage && j.usage.input_tokens) || 0, tout = (j.usage && j.usage.output_tokens) || 0;
      return { input: bloco.input, modelo: j.model || MODELO(), tokens_in: tin, tokens_out: tout, custo_usd: Math.round(((tin * PRECO_IN() + tout * PRECO_OUT()) / 1e6) * 1e5) / 1e5, latencia_ms: Date.now() - ini };
    } catch (err) {
      if (err.ia_indisponivel === undefined && (err.name === "AbortError" || err.cause || /fetch failed/i.test(err.message))) { ultimo = erroIA("Não foi possível falar com a IA (" + (err.name === "AbortError" ? "tempo esgotado" : "rede") + ").", true); await dorme(ESPERA_MS() * t); continue; }
      err.latencia_ms = Date.now() - ini; throw err;
    }
  }
  if (ultimo) ultimo.latencia_ms = Date.now() - ini;
  throw ultimo || erroIA("Falha desconhecida na IA.", true);
}

const SISTEMA_MANUAL = `Você é um analista de Visual Merchandising (VM) da Zinzane, rede de moda feminina. Sua tarefa é LER páginas de um manual de VM e transformá-las em CRITÉRIOS DE AUDITORIA que possam ser conferidos olhando uma FOTO de loja.

Regras:
- Extraia apenas o que o manual afirma de forma explícita. Não invente regras, números ou exceções. Se uma página só traz inspiração ou texto institucional, não gere critério.
- Cada critério deve ser UMA condição verificável por foto, escrita em português do Brasil, curta e objetiva (ex.: "Manequins vestem looks completos, com no mínimo 3 peças e acessório").
- Associe cada critério a UM dos ambientes listados. Use exatamente o nome do ambiente da lista. Se uma regra se aplica a vários ambientes, gere um critério para cada um. Se não couber em nenhum, use o ambiente mais próximo e explique em "excecoes".
- "critico" = true somente se o manual disser que é obrigatório/inegociável/proibido, ou se o descumprimento comprometer claramente a marca ou a segurança. Na dúvida, false.
- "peso" de 1 a 10 conforme a ênfase do manual (padrão 5).
- "pagina" = número da página onde a regra aparece. "referencia_pagina" = número da página que mostra a IMAGEM de referência (exemplo correto) dessa regra, ou null.
- "excecoes" = exceções ou condições declaradas no manual (ex.: "exceto na coleção de inverno"), ou null.
- "tipo": visual, posicionamento, quantidade, medida, limpeza, comunicacao ou outro.
- Se algo for ambíguo ou ilegível, registre mesmo assim com a dúvida em "excecoes" — uma pessoa do VM vai revisar tudo antes de valer.
Responda SEMPRE usando a ferramenta registrar_criterios.`;

const FERRAMENTA_MANUAL = {
  name: "registrar_criterios",
  description: "Registra os critérios de auditoria extraídos das páginas do manual.",
  input_schema: {
    type: "object",
    properties: {
      criterios: { type: "array", items: { type: "object", properties: {
        ambiente: { type: "string" }, descricao: { type: "string" },
        tipo: { type: "string", enum: ["visual", "posicionamento", "quantidade", "medida", "limpeza", "comunicacao", "outro"] },
        peso: { type: "integer", minimum: 1, maximum: 10 }, critico: { type: "boolean" },
        pagina: { type: "integer" }, referencia_pagina: { type: ["integer", "null"] }, excecoes: { type: ["string", "null"] },
      }, required: ["ambiente", "descricao", "tipo", "peso", "critico", "pagina"] } },
      observacoes: { type: "string" },
    },
    required: ["criterios"],
  },
};

const SISTEMA_FOTO = `Você é auditor de Visual Merchandising (VM) da Zinzane. Avalie UMA foto de um ambiente de loja contra uma lista de critérios homologados do manual.

Regras:
- Avalie SOMENTE o que dá para ver na foto. Nunca presuma conformidade: se o item não aparece, está cortado, escuro, distante ou ambíguo, responda "nao_verificavel".
- Antes de tudo avalie a qualidade da foto: "utilizavel", "parcial" (dá para avaliar só parte) ou "inutilizavel" (borrada, escura, ambiente errado, sem relação com o ambiente pedido). Se inutilizável, explique em "motivo_qualidade" o que a pessoa da loja deve fazer para refazer a foto.
- Para cada critério devolva: resultado ("conforme", "nao_conforme" ou "nao_verificavel"), "evidencia" (o que você VIU que justifica, objetivo e concreto) e "orientacao" (o que a loja deve ajustar, em uma frase prática; null se conforme).
- Quando houver imagem de referência do manual, compare com ela, mas o critério escrito é o que vale.
- Respeite as exceções informadas em cada critério.
- Escreva em português do Brasil, tom respeitoso e direto. Não calcule nota nem diga se a loja passou: isso é feito pelo sistema.
Responda SEMPRE usando a ferramenta registrar_avaliacao, incluindo TODOS os critérios listados.`;

const FERRAMENTA_FOTO = {
  name: "registrar_avaliacao",
  description: "Registra a avaliação da foto contra os critérios.",
  input_schema: {
    type: "object",
    properties: {
      qualidade_foto: { type: "string", enum: ["utilizavel", "parcial", "inutilizavel"] },
      motivo_qualidade: { type: ["string", "null"] },
      avaliacoes: { type: "array", items: { type: "object", properties: {
        criterio_id: { type: "integer" }, resultado: { type: "string", enum: ["conforme", "nao_conforme", "nao_verificavel"] },
        evidencia: { type: "string" }, orientacao: { type: ["string", "null"] },
      }, required: ["criterio_id", "resultado", "evidencia"] } },
    },
    required: ["qualidade_foto", "avaliacoes"],
  },
};

// Fila simples: no máximo N chamadas à IA ao mesmo tempo (protege o limite de requisições da conta).
let ativos = 0; const espera = [];
const MAX_PARALELO = () => Number(process.env.VM_IA_PARALELO || 3);
function fila(fn) {
  return new Promise((resolve, reject) => {
    const rodar = () => { ativos++; Promise.resolve().then(fn).then(resolve, reject).finally(() => { ativos--; const prox = espera.shift(); if (prox) prox(); }); };
    if (ativos < MAX_PARALELO()) rodar(); else espera.push(rodar);
  });
}

module.exports = { fila, chamar, configurada, MODELO, PROMPT_MANUAL, PROMPT_FOTO, SISTEMA_MANUAL, FERRAMENTA_MANUAL, SISTEMA_FOTO, FERRAMENTA_FOTO };

// src/relatorio.js — Parser de relatório TXT (mensagens exportadas do grupo)
const fs = require('fs');

const CODIGOS_BAIXA_VALIDOS = new Set(['101','106','301','306','312','404','409','430','479','706','512']);
const CODIGOS_EXCLUIR_IMPROD = new Set(['106','409','430','706']);

function extrairBlocoRelatorio(block) {
  block = block.trim();
  if (!block) return null;
  const header = block.match(/\[[\d:, /]+\]\s*([^:]+):/);
  if (!header) return null;
  const remetente = header[1].trim();
  const msg = block.slice(header[0].length).trim();

  // Busca contrato (6-8 dígitos)
  let contrato = null;
  let m = msg.match(/[Cc]ontrato\s*[:|]\s*(\d{6,8})/);
  if (m) contrato = m[1];
  if (!contrato) {
    m = msg.match(/\b(\d{6,8})\s*[|]\s*(\d{3})\b/);
    if (m && CODIGOS_BAIXA_VALIDOS.has(m[2])) contrato = m[1];
  }
  if (!contrato) { m = msg.match(/\b(\d{6,8})\b/); if (m) contrato = m[1]; }
  if (!contrato) return null;

  // Busca código de baixa (só aceita conhecidos)
  let codigo = null;
  for (const cod of (msg.match(/\b(\d{3})\b/g) || [])) {
    if (CODIGOS_BAIXA_VALIDOS.has(cod)) { codigo = cod; break; }
  }
  if (!codigo) return null;

  // Observação: texto após o código
  const obsMatch = msg.match(new RegExp(`\\b${codigo}\\b\\s*[|.]?\\s*(.*)`));
  let obs = (obsMatch ? obsMatch[1] : '').trim().slice(0, 150);
  obs = obs.replace(/^\s*[|\-]\s*/, '').trim();
  obs = obs.replace(/\s*\|\s*\w+\s*$/, '').trim(); // remove nome do técnico no final

  return { remetente, contrato, codigo, obs };
}

function parseRelatorioTxt(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf8');
  const blocos = content.split(/[-]{4,}/);
  const seen = new Map();
  for (const b of blocos) {
    const r = extrairBlocoRelatorio(b);
    if (r) seen.set(r.contrato, r); // última ocorrência
  }
  return Array.from(seen.values());
}

module.exports = { CODIGOS_BAIXA_VALIDOS, CODIGOS_EXCLUIR_IMPROD, extrairBlocoRelatorio, parseRelatorioTxt };
const fs = require('fs');
let XLSX = null;

function getXLSX() {
  if (XLSX) return XLSX;
  try {
    XLSX = require('xlsx');
    return XLSX;
  } catch (err) {
    throw new Error('Dependência "xlsx" não encontrada. Rode: npm install xlsx');
  }
}

function normalizeText(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeName(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^\[[^\]]+\]\s*/g, ' ')
    .replace(/\b(desc|ntl|tecnico|tecnica|ftz)\b/gi, ' ')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function onlyDigits(value = '') {
  return String(value).replace(/\D+/g, '');
}

function findBestSheetName(workbook) {
  const sheetNames = workbook.SheetNames || [];
  if (!sheetNames.length) return null;

  const exact = sheetNames.find((name) => normalizeText(name) === 'devolucao pendente');
  if (exact) return exact;

  const partial = sheetNames.find((name) => {
    const n = normalizeText(name);
    return n.includes('devolucao') && n.includes('pendente');
  });

  return partial || null;
}

function getDatePartsInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const map = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

function isSameDateInTimeZone(input, refDate, timeZone) {
  if (!input) return false;
  const ref = getDatePartsInTimeZone(refDate, timeZone);

  if (input instanceof Date && !isNaN(input)) {
    const d = getDatePartsInTimeZone(input, timeZone);
    return d.year === ref.year && d.month === ref.month && d.day === ref.day;
  }

  const text = String(input).trim();
  const br = text.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (br) {
    const day = Number(br[1]);
    const month = Number(br[2]);
    const year = Number(br[3].length === 2 ? `20${br[3]}` : br[3]);
    return year === ref.year && month === ref.month && day === ref.day;
  }

  const parsed = new Date(text);
  if (!isNaN(parsed)) {
    const d = getDatePartsInTimeZone(parsed, timeZone);
    return d.year === ref.year && d.month === ref.month && d.day === ref.day;
  }

  return false;
}

function toDateFromExcel(raw) {
  if (typeof raw === 'number') {
    const parsed = getXLSX().SSF.parse_date_code(raw);
    if (parsed) {
      const dd = String(parsed.d).padStart(2, '0');
      const mm = String(parsed.m).padStart(2, '0');
      const yyyy = String(parsed.y);
      const hh = String(parsed.H || 0).padStart(2, '0');
      const mi = String(parsed.M || 0).padStart(2, '0');
      return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
    }
  }
  return raw;
}

function findColumnName(columns, candidates) {
  const normalized = columns.map((col) => ({ original: col, key: normalizeText(col) }));

  for (const candidate of candidates) {
    const key = normalizeText(candidate);
    const found = normalized.find((item) => item.key.includes(key) || key.includes(item.key));
    if (found) return found.original;
  }

  return null;
}

function inferColumnByData(rows, columns, scorer, minScore = 3) {
  let best = { col: null, score: 0 };
  for (const col of columns) {
    let score = 0;
    for (const row of rows.slice(0, 200)) {
      if (scorer(row[col])) score += 1;
    }
    if (score > best.score) best = { col, score };
  }
  return best.score >= minScore ? best.col : null;
}

function getOtherCodes(text, contrato) {
  const numbers = (String(text).match(/\b\d{2,8}\b/g) || []).filter((n) => n !== contrato);
  return numbers.filter((n) => n !== '430');
}

function is430LikeMessage(text, contrato) {
  const normalized = normalizeText(text);
  const has430 = /\b430\b/.test(normalized);
  const hasFrAlias = /\bfr\b|fora\s*toa|fora\s*t\b|f\s*toa/.test(normalized);

  if (!has430 && !hasFrAlias) return false;

  // Só desconsidera se houver código de baixa conflitante conhecido
  const codigosConflitantes = new Set(['101', '106', '301', '306', '404', '409', '479', '512']);
  const otherCodes = getOtherCodes(normalized, contrato);
  if (otherCodes.some((n) => codigosConflitantes.has(n))) return false;

  return true;
}

function extractWhatsRows(content) {
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const result = [];

  for (const line of lines) {
    const exportMatch = line.match(/^\[[^\]]+\]\s*([^:]+):\s*(.*)$/);
    const sender = exportMatch ? exportMatch[1].trim() : 'remetente_nao_identificado';
    const textToAnalyze = exportMatch ? exportMatch[2] : line;

    const contractMatch = textToAnalyze.match(/\b(\d{6,8})\b/) || line.match(/\b(\d{6,8})\b/);
    if (!contractMatch) continue;

    const contrato = contractMatch[1];
    if (!is430LikeMessage(textToAnalyze, contrato)) continue;

    result.push({ raw: line, contrato, remetente: sender, mensagem: textToAnalyze });
  }

  return result;
}

function isSameTechnician(whatsName, imperiumName) {
  const w = normalizeName(whatsName);
  const i = normalizeName(imperiumName);
  if (!w || !i) return false;
  return w === i;
}

function buildReport({
  divergencias,
  naoEncontrados,
  ok,
  totalContratosWhats430,
  totalWhats430,
  totalContratosXlsxFiltrados,
  totalLinhasXlsxFiltradas
}) {
  const parts = [];
  parts.push(`📊 Contratos únicos 430/FR no Whats: *${totalContratosWhats430}* (linhas: ${totalWhats430})`);
  parts.push(`📌 Base XLSX filtrada (DESC+hoje): contratos *${totalContratosXlsxFiltrados || 0}*, linhas *${totalLinhasXlsxFiltradas || 0}*`);

  if (divergencias.length) {
    parts.push('\n❌ *DIVERGÊNCIAS (Contrato | Instalador WhatsApp | Serial)*');
    parts.push(formatForCopy(divergencias));
  } else {
    parts.push('\n✅ *DIVERGÊNCIAS*\nNenhuma divergência de técnico encontrada.');
  }

  if (naoEncontrados.length) {
    parts.push('\n⚠️ *NÃO ENCONTRADOS NO XLSX (DESC + HOJE)*');
    parts.push(naoEncontrados.map((n) => `${n.contrato} - ${n.tecnicoWhats}`).join('\n'));
  }

  if (ok.length) {
    parts.push('\n✅ *OK (MESMO TÉCNICO)*');
    parts.push(ok.map((k) => `${k.contrato} - ${k.tecnicoWhats}`).join('\n'));
  }

  return parts.join('\n');
}

function compare430({ whatsPath, imperiumXlsxPath, timeZone = 'America/Sao_Paulo' }) {
  if (!fs.existsSync(whatsPath)) throw new Error(`Arquivo Whats não encontrado: ${whatsPath}`);
  if (!fs.existsSync(imperiumXlsxPath)) throw new Error(`Arquivo Imperium não encontrado: ${imperiumXlsxPath}`);

  const whatsContent = fs.readFileSync(whatsPath, 'utf8');
  const whatsRowsRaw = extractWhatsRows(whatsContent);

  const byContractWhats = new Map();
  for (const row of whatsRowsRaw) {
    // Mantém a última ocorrência do contrato no export (mensagem mais recente)
    byContractWhats.set(row.contrato, row);
  }
  const whatsRows = [...byContractWhats.values()];

  const xlsx = getXLSX();
  const workbook = xlsx.readFile(imperiumXlsxPath, { cellDates: true });
  const sheetName = findBestSheetName(workbook);
  if (!sheetName) {
    throw new Error(`Aba de devolução pendente não encontrada no XLSX. Abas disponíveis: ${workbook.SheetNames.join(', ')}`);
  }

  const sheet = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });
  const allColumns = rows.length ? Object.keys(rows[0]) : [];

  let contratoCol = findColumnName(allColumns, ['contrato']);
  let tecnicoCol = findColumnName(allColumns, ['instalador', 'tecnico', 'técnico', 'instalad']);
  let serialCol = findColumnName(allColumns, ['serial', 'numero serial', 'número serial', 'num serial']);
  let dataBaixaCol = findColumnName(allColumns, ['data da baixa', 'data baixa', 'data da b', 'baixa']);

  if (!contratoCol) contratoCol = inferColumnByData(rows, allColumns, (v) => /^\d{6,8}$/.test(onlyDigits(v)), 1);
  if (!serialCol) {
    serialCol = inferColumnByData(rows, allColumns, (v) => {
      const text = String(v || '').trim();
      return /[a-z]/i.test(text) && /\d/.test(text) && text.replace(/\W/g, '').length >= 6;
    }, 1);
  }
  if (!dataBaixaCol) {
    dataBaixaCol = inferColumnByData(rows, allColumns, (v) => isSameDateInTimeZone(toDateFromExcel(v), new Date(), timeZone), 1)
      || inferColumnByData(rows, allColumns, (v) => /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(String(v || '')), 1);
  }
  if (!tecnicoCol) tecnicoCol = inferColumnByData(rows, allColumns, (v) => {
    const t = normalizeText(v);
    return t.includes('desc') && !t.includes('desconex');
  }, 1);

  if (!contratoCol || !tecnicoCol || !serialCol || !dataBaixaCol) {
    throw new Error(`Colunas obrigatórias não encontradas na aba ${sheetName} (Contrato, Instalador/Técnico, Serial, Data da Baixa). Colunas lidas: ${allColumns.join(', ')}`);
  }

  const hoje = new Date();
  const imperiumFiltered = rows.filter((row) => {
    const tecnicoRaw = String(row[tecnicoCol] || '');
    const tecnicoValue = normalizeText(tecnicoRaw);
    const isDesc = tecnicoValue.includes('desc');
    const sameDay = isSameDateInTimeZone(toDateFromExcel(row[dataBaixaCol]), hoje, timeZone);
    return isDesc && sameDay;
  });

  const byContract = new Map();
  for (const row of imperiumFiltered) {
    const contrato = onlyDigits(row[contratoCol]);
    if (!/^\d{6,8}$/.test(contrato)) continue;

    if (!byContract.has(contrato)) byContract.set(contrato, []);
    byContract.get(contrato).push({
      tecnicoOriginal: String(row[tecnicoCol] || '').trim(),
      tecnicoNorm: normalizeName(row[tecnicoCol] || ''),
      serial: String(row[serialCol] || '').trim()
    });
  }

  const divergencias = [];
  const naoEncontrados = [];
  const ok = [];

  for (const item of whatsRows) {
    const tecnicoWhatsNorm = normalizeName(item.remetente);
    const registros = byContract.get(item.contrato) || [];

    if (!registros.length) {
      naoEncontrados.push({ contrato: item.contrato, tecnicoWhats: item.remetente });
      continue;
    }

    const sameTech = registros.some((r) => r.tecnicoNorm && isSameTechnician(tecnicoWhatsNorm, r.tecnicoNorm));
    if (sameTech) {
      ok.push({ contrato: item.contrato, tecnicoWhats: item.remetente });
      continue;
    }

    const serials = [...new Set(registros.map((r) => r.serial).filter(Boolean))];
    divergencias.push({
      contrato: item.contrato,
      serials,
      tecnicoWhats: item.remetente,
      tecnicosImperium: [...new Set(registros.map((r) => r.tecnicoOriginal).filter(Boolean))]
    });
  }

  const resultado = {
    totalWhats430: whatsRowsRaw.length,
    totalContratosWhats430: whatsRows.length,
    totalLinhasXlsxFiltradas: imperiumFiltered.length,
    totalContratosXlsxFiltrados: byContract.size,
    divergencias,
    naoEncontrados,
    ok
  };

  resultado.relatorio = buildReport(resultado);
  return resultado;
}

function formatForCopy(divergencias) {
  return divergencias
    .map((d) => `${d.contrato} | ${d.tecnicoWhats} | ${d.serials.join(', ') || 'SEM SERIAL'}`)
    .join('\n');
}

module.exports = {
  compare430,
  formatForCopy
};
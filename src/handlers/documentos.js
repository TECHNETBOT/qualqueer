// src/handlers/documentos.js — Captura de documentos, comparação 430, !improdutivas, !bater
const fs   = require('fs');
const path = require('path');
const pino = require('pino');
const AdmZip = require('adm-zip');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { compare430, formatForCopy } = require('../compare430');
const { parseRelatorioTxt, CODIGOS_EXCLUIR_IMPROD } = require('../relatorio');

function criarExecutarComparacao430({ sock, chatId, m, WHATS_TXT_PATH, WHATS_CSV_PATH, IMPERIUM_XLSX_PATH, limparArquivosComparacao430 }) {
  return async function executarComparacao430() {
    const hasWhats   = fs.existsSync(WHATS_TXT_PATH) || fs.existsSync(WHATS_CSV_PATH);
    const whatsPath  = fs.existsSync(WHATS_TXT_PATH) ? WHATS_TXT_PATH : WHATS_CSV_PATH;
    const hasImperium = fs.existsSync(IMPERIUM_XLSX_PATH);

    if (!hasWhats || !hasImperium) {
      const faltantes = [];
      if (!hasWhats)    faltantes.push('• Arquivo Whats (.txt ou .csv)');
      if (!hasImperium) faltantes.push('• Arquivo Imperium (.xlsx)');
      await sock.sendMessage(chatId, { text: `⚠️ Faltam arquivos para comparar:\n\n${faltantes.join('\n')}\n\nEnvie os dois documentos (.txt/.csv e .xlsx).` }, { quoted: m });
      return;
    }

    try {
      const resultado = compare430({ whatsPath, imperiumXlsxPath: IMPERIUM_XLSX_PATH, timeZone: 'America/Sao_Paulo' });
      if (resultado.totalWhats430 === 0) { await sock.sendMessage(chatId, { text: 'ℹ️ Não encontrei mensagens com *430/FR* no arquivo Whats informado.' }, { quoted: m }); return; }

      const blocos = [];
      blocos.push(`📊 Contratos únicos 430/FR no Whats: *${resultado.totalContratosWhats430 || resultado.totalWhats430}*`);
      if (resultado.relatorio) {
        blocos.push(`\n${resultado.relatorio}`);
      } else {
        if (resultado.divergencias.length > 0) blocos.push(`\n❌ *DIVERGÊNCIAS*\n${formatForCopy(resultado.divergencias)}`);
        else blocos.push('\n✅ Nenhuma divergência de técnico encontrada para os 430/FR.');
        if (resultado.naoEncontrados.length > 0) {
          const listaNaoEncontrados = resultado.naoEncontrados.map((n) => typeof n === 'object' ? `${n.contrato} - ${n.tecnicoWhats}` : String(n)).join('\n');
          blocos.push(`\n⚠️ *CONTRATOS 430/FR NÃO ENCONTRADOS NO XLSX (DESC + hoje)*\n${listaNaoEncontrados}`);
        }
      }

      const respostaFinal = blocos.join('\n');
      const TAMANHO_MAX = 3500;
      if (respostaFinal.length <= TAMANHO_MAX) {
        await sock.sendMessage(chatId, { text: respostaFinal }, { quoted: m });
      } else {
        const partes = [];
        let atual = '';
        for (const linha of respostaFinal.split('\n')) {
          const tentativa = atual ? `${atual}\n${linha}` : linha;
          if (tentativa.length > TAMANHO_MAX) { if (atual) partes.push(atual); atual = linha; }
          else { atual = tentativa; }
        }
        if (atual) partes.push(atual);
        for (let i = 0; i < partes.length; i++) {
          await sock.sendMessage(chatId, { text: `${i === 0 ? '' : `(continuação ${i + 1}/${partes.length})\n`}${partes[i]}` }, { quoted: m });
        }
      }
    } catch (err) {
      console.error('Erro comparar430:', err);
      await sock.sendMessage(chatId, { text: `❌ Erro ao comparar 430: ${err.message}` }, { quoted: m });
    } finally { limparArquivosComparacao430(); }
  };
}

async function handleDocumento({ sock, chatId, m, documentCaption, WHATS_TXT_PATH, WHATS_CSV_PATH, IMPERIUM_XLSX_PATH, RELATORIO_TXT_PATH, limparArquivosComparacao430 }) {
  const originalName = (m.message?.documentMessage?.fileName || '').toLowerCase().trim();
  const mimetype     = (m.message?.documentMessage?.mimetype  || '').toLowerCase();

  const isTxtOrCsv = originalName.endsWith('.txt') || originalName.endsWith('.csv') || mimetype.includes('text/') || mimetype.includes('csv');
  const isXlsx     = originalName.endsWith('.xlsx') || originalName.endsWith('.xls') || mimetype.includes('spreadsheetml') || mimetype.includes('ms-excel') || mimetype.includes('officedocument');
  const isZip      = originalName.endsWith('.zip') || mimetype.includes('zip');
  const legendaMarcaWhats     = documentCaption === 'whats';
  const legendaMarcaImperium  = documentCaption === 'imperium';
  const legendaMarcaRelatorio = documentCaption === 'relatorio' || documentCaption === 'relatório';

  if (!isTxtOrCsv && !isXlsx && !isZip && !legendaMarcaWhats && !legendaMarcaImperium && !legendaMarcaRelatorio) return false;

  const fileBuffer = await downloadMediaMessage(m, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
  if (!fileBuffer) { await sock.sendMessage(chatId, { text: '❌ Não consegui baixar o documento.' }, { quoted: m }); return true; }

  // .txt → relatório de mensagens do grupo
  if (isTxtOrCsv && (originalName.endsWith('.txt') || mimetype.includes('text/plain'))) {
    fs.writeFileSync(RELATORIO_TXT_PATH, fileBuffer);
    const dados = parseRelatorioTxt(RELATORIO_TXT_PATH);
    await sock.sendMessage(chatId, { text: `✅ Relatório salvo! *${dados ? dados.length : 0}* registros encontrados.\nUse *!improdutivas* ou *!bater [Técnico]*\n_contratos..._` }, { quoted: m });
    return true;
  }

  if (legendaMarcaRelatorio) {
    fs.writeFileSync(RELATORIO_TXT_PATH, fileBuffer);
    const dados = parseRelatorioTxt(RELATORIO_TXT_PATH);
    await sock.sendMessage(chatId, { text: `✅ Relatório salvo! *${dados ? dados.length : 0}* registros encontrados.\nUse *!improdutivas* ou *!bater [Técnico] contratos...* para analisar.` }, { quoted: m });
    return true;
  }

  const executarComparacao430 = criarExecutarComparacao430({ sock, chatId, m, WHATS_TXT_PATH, WHATS_CSV_PATH, IMPERIUM_XLSX_PATH, limparArquivosComparacao430 });

  let salvouAlgum = false;
  if (isZip) {
    try {
      const zip     = new AdmZip(fileBuffer);
      const entries = zip.getEntries().filter((e) => !e.isDirectory);
      const xlsxEntry  = entries.find((e) => e.entryName.toLowerCase().endsWith('.xlsx'));
      const whatsEntry = entries.find((e) => { const n = e.entryName.toLowerCase(); return n.endsWith('.txt') || n.endsWith('.csv'); });
      if (xlsxEntry)  { fs.writeFileSync(IMPERIUM_XLSX_PATH, xlsxEntry.getData()); salvouAlgum = true; }
      if (whatsEntry) { const lower = whatsEntry.entryName.toLowerCase(); fs.writeFileSync(lower.endsWith('.csv') ? WHATS_CSV_PATH : WHATS_TXT_PATH, whatsEntry.getData()); salvouAlgum = true; }
      if (!salvouAlgum) { await sock.sendMessage(chatId, { text: '⚠️ ZIP recebido, mas não encontrei .xlsx e/ou .txt/.csv dentro dele.' }, { quoted: m }); return true; }
      await sock.sendMessage(chatId, { text: '✅ ZIP processado. Arquivos internos salvos para comparação 430.' }, { quoted: m });
    } catch (zipErr) { await sock.sendMessage(chatId, { text: `❌ Erro ao ler ZIP: ${zipErr.message}` }, { quoted: m }); return true; }
  } else if (isTxtOrCsv || legendaMarcaWhats) {
    fs.writeFileSync(originalName.endsWith('.csv') ? WHATS_CSV_PATH : WHATS_TXT_PATH, fileBuffer); salvouAlgum = true;
    await sock.sendMessage(chatId, { text: `✅ Arquivo Whats salvo em: ${path.basename(originalName.endsWith('.csv') ? WHATS_CSV_PATH : WHATS_TXT_PATH)}` }, { quoted: m });
  } else if (isXlsx || legendaMarcaImperium) {
    fs.writeFileSync(IMPERIUM_XLSX_PATH, fileBuffer); salvouAlgum = true;
    await sock.sendMessage(chatId, { text: '✅ Arquivo Imperium salvo em: imperium.xlsx' }, { quoted: m });
  }

  if (salvouAlgum) {
    const hasWhats    = fs.existsSync(WHATS_TXT_PATH) || fs.existsSync(WHATS_CSV_PATH);
    const hasImperium = fs.existsSync(IMPERIUM_XLSX_PATH);
    if (hasWhats && hasImperium) {
      await sock.sendMessage(chatId, { text: '🤖 Arquivos detectados (.txt/.csv + .xlsx). Iniciando comparação 430...' }, { quoted: m });
      await executarComparacao430();
    } else {
      await sock.sendMessage(chatId, { text: '📥 Arquivo recebido. Aguardando o outro arquivo para comparar (Whats + Imperium).' }, { quoted: m });
    }
  }
  return true;
}

async function handleImprodutivas({ sock, chatId, m, RELATORIO_TXT_PATH }) {
  const dados = parseRelatorioTxt(RELATORIO_TXT_PATH);
  if (!dados) { await sock.sendMessage(chatId, { text: '⚠️ Nenhum relatório carregado. Envie o arquivo .txt com a legenda *relatorio*.' }, { quoted: m }); return; }
  const improd = dados.filter(r => !CODIGOS_EXCLUIR_IMPROD.has(r.codigo));
  if (!improd.length) { await sock.sendMessage(chatId, { text: '✅ Nenhuma improdutiva encontrada (excluídos 430/106/409/706).' }, { quoted: m }); return; }

  const descricaoCodigo = { '101': 'Endereço não localizado', '306': 'Cliente não reside mais', '312': 'Aguardando sinalização', '404': 'Recusa do assinante', '479': 'Equipamento já devolvido', '512': 'Outro' };
  let resposta = `📋 *IMPRODUTIVAS DO DIA* — ${improd.length} contratos\n_(excluídos: 430 / 106 / 409 / 706)_\n\n`;
  for (const r of improd) {
    const desc = descricaoCodigo[r.codigo] || '';
    const obs  = r.obs && r.obs !== desc ? ` — ${r.obs}` : (desc ? ` — ${desc}` : '');
    resposta += `*${r.contrato}* | ${r.codigo}${obs}\n`;
  }

  if (resposta.length > 3500) {
    const partes = [];
    let atual = `📋 *IMPRODUTIVAS DO DIA* — ${improd.length} contratos\n\n`;
    for (const r of improd) {
      const desc = descricaoCodigo[r.codigo] || '';
      const obs  = r.obs && r.obs !== desc ? ` — ${r.obs}` : (desc ? ` — ${desc}` : '');
      const linha = `*${r.contrato}* | ${r.codigo}${obs}\n`;
      if ((atual + linha).length > 3500) { partes.push(atual); atual = linha; }
      else atual += linha;
    }
    if (atual) partes.push(atual);
    for (let i = 0; i < partes.length; i++) await sock.sendMessage(chatId, { text: partes[i] }, { quoted: i === 0 ? m : undefined });
  } else {
    await sock.sendMessage(chatId, { text: resposta }, { quoted: m });
  }
}

async function handleBater({ sock, chatId, m, msgTextoRaw, RELATORIO_TXT_PATH }) {
  const dados = parseRelatorioTxt(RELATORIO_TXT_PATH);
  if (!dados) { await sock.sendMessage(chatId, { text: '⚠️ Nenhum relatório carregado. Envie o arquivo .txt.' }, { quoted: m }); return; }

  const linhasCmd = msgTextoRaw.slice(7).trim().split(/[\n\r]+/);
  let nomeTecnico, contratosInput;

  if (linhasCmd.length > 1) {
    nomeTecnico    = linhasCmd[0].trim();
    contratosInput = linhasCmd.slice(1).flatMap(l => l.trim().split(/\s+/)).filter(l => /^\d{6,8}$/.test(l));
  } else {
    const tokens       = linhasCmd[0].trim().split(/\s+/);
    const contratoTokens = tokens.filter(t =>  /^\d{6,8}$/.test(t));
    const nomeTokens     = tokens.filter(t => !/^\d{6,8}$/.test(t));
    nomeTecnico    = nomeTokens.join(' ').trim();
    contratosInput = contratoTokens;
  }

  if (!nomeTecnico || !contratosInput.length) {
    await sock.sendMessage(chatId, { text: '❌ Uso:\n*!bater NomeTecnico*\n123456\n789012\n\nOu: *!bater NomeTecnico 123456 789012*' }, { quoted: m }); return;
  }

  const byContrato = new Map(dados.map(r => [r.contrato, r]));
  const nomeNorm   = nomeTecnico.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  let resposta     = `🔍 *BATER — ${nomeTecnico}* (${contratosInput.length} contratos)\n\n`;
  let divergencias = 0;

  for (const contrato of contratosInput) {
    const reg = byContrato.get(contrato);
    if (!reg) { resposta += `*${contrato}:* ⚠️ Não encontrado no relatório\n`; continue; }
    const remNorm = reg.remetente.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
    const match   = remNorm.includes(nomeNorm) || nomeNorm.includes(remNorm.split(' ')[0]);
    if (match) {
      resposta += `*${contrato}:* ✅ Reportado por ${reg.remetente} com código ${reg.codigo}\n`;
    } else {
      resposta += `*${contrato}:* ❌ Reportado por *${reg.remetente}* com ${reg.codigo} *(DIVERGENTE)*\n`;
      divergencias++;
    }
  }
  if (divergencias === 0) resposta += `\n✅ Nenhuma divergência encontrada.`;
  else resposta += `\n⚠️ *${divergencias} divergência(s) encontrada(s).*`;

  await sock.sendMessage(chatId, { text: resposta }, { quoted: m });
}

module.exports = { handleDocumento, handleImprodutivas, handleBater, criarExecutarComparacao430 };
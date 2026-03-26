// src/handlers/comprovante.js — Geração de comprovante de devolução
const { gerarComprovanteDevolucao, getFollowupText } = require('../gerador');

// Detecta se a mensagem deve disparar o comprovante
function deveDisparar({ msgTextoRaw, msgTextoSemAcento, chatId, ID_GRUPO_COMPROVANTE }) {
  const raw = msgTextoRaw.replace(/\*/g, '');
  const temData     = /\bdata\s*:/i.test(raw);
  const temContrato = /\bcontrato\s*:/i.test(raw);
  if (!temData || !temContrato) return false;
  if (chatId === ID_GRUPO_COMPROVANTE) return true;
  if (/\b(serial\s*(equipamento)?|equipamentos?|numero\s*serial|modelo)\s*:/i.test(raw)) return true;
  if (msgTextoSemAcento.includes('tecnico') && (msgTextoSemAcento.includes('serial') || msgTextoSemAcento.includes('equipamento'))) return true;
  return false;
}

async function handleComprovante({ sock, chatId, m, msgTextoRaw, msgTextoSemAcento }) {
  const inferirModeloPorSerial = (serial) => {
    const base = String(serial || '').toUpperCase().replace(/\W/g, '');
    if (!base) return 'DECODER';
    if (/[A-Z]/.test(base) && /\d/.test(base)) return 'EMTA';
    if (/^\d+$/.test(base)) return 'DECODER';
    return 'DECODER';
  };

  const _linhas = msgTextoRaw.split(/\r?\n/).map(l => l.trim().replace(/\*/g, '')).filter(Boolean);
  const _norm = t => String(t||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();
  const _extrairPorChaves = (keys) => {
    const keysNorm = keys.map(_norm);
    for (let i = 0; i < _linhas.length; i++) {
      const linha = _linhas[i];
      const idx = linha.indexOf(':');
      if (idx > 0) {
        const key = _norm(linha.slice(0, idx)).trim();
        if (keysNorm.some(k => key === k || key.endsWith(k) || k.endsWith(key))) {
          const valor = linha.slice(idx + 1).trim();
          if (valor) return valor;
          if (i + 1 < _linhas.length) return _linhas[i + 1].trim();
        }
      } else {
        const key = _norm(linha).trim();
        if (keysNorm.some(k => key === k) && i + 1 < _linhas.length) return _linhas[i + 1].trim();
      }
    }
    return '';
  };

  const data     = _extrairPorChaves(['data']);
  const contrato = (_extrairPorChaves(['contrato']).match(/\d{6,12}/) || [])[0] || '';
  const nomeCliente = _extrairPorChaves(['nome do cliente','nome do client','cliente','nome']);
  const tecnico     = _extrairPorChaves(['nome do tecnico','nome do técnico','técnico','tecnico']).replace(/^\.\s*/, '');
  const modeloEquipamentoInformado = _extrairPorChaves(['modelo equipamento','modelo']).toUpperCase();

  const _fontesSeriais = [
    _extrairPorChaves(['serial equipamento','numero serial','número serial','serial']),
    _extrairPorChaves(['equipamentos','equipamento']),
  ].filter(Boolean);
  const _tokens = [];
  for (const fonte of _fontesSeriais) {
    const enc = String(fonte).toUpperCase().match(/\b[A-Z0-9]{6,25}\b/g) || [];
    _tokens.push(...enc);
  }
  for (const linha of _linhas) {
    const l = linha.trim().toUpperCase();
    const ehChave = /^(data|contrato|nome|tecnico|equipamento|serial|modelo|complemento|fora\s*rota)/i.test(l);
    if (!ehChave && /[A-Z]/.test(l) && /\d/.test(l) && l.length >= 6 && l.length <= 25 && !/\s{2,}/.test(l)) {
      const semEspacos = l.replace(/\s/g, '');
      if (/^[A-Z0-9]{6,25}$/.test(semEspacos) && !/^\d{2}\/\d{2}\/\d{2,4}$/.test(semEspacos)) {
        _tokens.push(semEspacos);
      }
    }
  }
  let rawEquips = [...new Set(_tokens.filter(t => !/^\d{1,5}$/.test(t) && !/^\d{2}\/\d{2}\/\d{2,4}$/.test(t) && t.length >= 6))].join(',');
  if (!contrato || !rawEquips) {
    await sock.sendMessage(chatId, { text: '⚠️ Faltou o Contrato ou os Equipamentos.' }, { quoted: m });
    return;
  }

  const palavrasChave = ['EMTA', 'DECODE', 'SMART', 'MASH', 'HGU', 'ONT', 'DECODER'];
  const equipamentosBrutos = rawEquips.split(',').map(item => item.trim().toUpperCase()).filter(Boolean);
  const hintSmartGlobal   = /\bSMART\b/.test(modeloEquipamentoInformado) || /\bSMART\b/.test(msgTextoSemAcento.toUpperCase());
  const hintDecoderGlobal = /DECO|DECODER/.test(modeloEquipamentoInformado) || /DECO|DECODER/.test(msgTextoSemAcento.toUpperCase());
  const smartHintIndex = (() => {
    if (!hintSmartGlobal) return -1;
    const candidatos = [];
    equipamentosBrutos.forEach((item, idx) => {
      const limpo = item.toUpperCase().replace(/^\*+\s*/, '');
      if (!palavrasChave.some((p) => limpo.startsWith(p)) && !limpo.includes(':') && /^\d+$/.test(limpo)) candidatos.push(idx);
    });
    return candidatos.length ? candidatos[candidatos.length - 1] : -1;
  })();

  const listaEquipamentosProcessada = equipamentosBrutos.map((item, idx) => {
    let itemLimpo = item.trim().toUpperCase();
    const smartForcado = itemLimpo.startsWith('*');
    if (smartForcado) itemLimpo = itemLimpo.replace(/^\*+\s*/, '');
    for (const modelo of palavrasChave) {
      if (itemLimpo.startsWith(modelo)) {
        const serialSobra = itemLimpo.substring(modelo.length).replace(/^[:;\s-]+/, '').trim().replace(/^\*+\s*/, '');
        if (!serialSobra) return null;
        return { modelo: smartForcado ? 'SMART' : (modelo === 'DECODE' ? 'DECODER' : modelo), serial: serialSobra };
      }
    }
    if (itemLimpo.includes(':')) {
      const parts = itemLimpo.split(':');
      const modeloDeclarado  = parts[0].trim().toUpperCase();
      const serialDeclarado  = parts.slice(1).join(':').trim().replace(/^\*+\s*/, '');
      return { modelo: smartForcado ? 'SMART' : (['EMTA', 'SMART', 'DECODER'].includes(modeloDeclarado) ? modeloDeclarado : inferirModeloPorSerial(serialDeclarado)), serial: serialDeclarado };
    }
    const serialFinal   = itemLimpo.replace(/^\*+\s*/, '');
    const smartPorHint  = idx === smartHintIndex || (hintSmartGlobal && !hintDecoderGlobal && /^\d+$/.test(serialFinal));
    return { modelo: (smartForcado || itemLimpo.includes('SMART') || smartPorHint) ? 'SMART' : inferirModeloPorSerial(serialFinal), serial: serialFinal };
  }).filter(i => i && i.serial);

  if (listaEquipamentosProcessada.length === 0) {
    await sock.sendMessage(chatId, { text: '⚠️ Nenhum serial válido.' }, { quoted: m });
    return;
  }

  await sock.sendMessage(chatId, { react: { text: '⏳', key: m.key } });
  const bufferImagem = await gerarComprovanteDevolucao({ data, contrato, nomeCliente, equipamentos: listaEquipamentosProcessada, tecnico });
  await sock.sendMessage(chatId, { image: bufferImagem, caption: `✅ Comprovante Gerado.\nCliente: ${nomeCliente}` }, { quoted: m });
  await sock.sendMessage(chatId, { text: getFollowupText() }, { quoted: m });
  // IA pós-comprovante desativada temporariamente
}

module.exports = { deveDisparar, handleComprovante };
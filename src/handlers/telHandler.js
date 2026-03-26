// src/handlers/telHandler.js
// !tel 1234567 1234568, 1234569 — registra contratos prioritários do dia
// Se alguém mencionar um desses contratos no grupo, avisa no grupo de testes
// Reseta todo dia às 23:00

const fs   = require('fs');
const path = require('path');

const DATA_DIR    = path.join(__dirname, '..', '..', 'data');
const TEL_PATH    = path.join(DATA_DIR, 'tel_contratos.json');
const ID_GRUPO_TESTES = '120363423496684075@g.us';

// Grupos monitorados — qualquer menção de contrato prioritário nesses grupos gera aviso
const GRUPOS_MONITORADOS = new Set([
  '120363397790697942@g.us', // DESC FORTALEZA/CE
  '120363420013377509@g.us', // DESC MOSSORO/RN
  '120363028547806621@g.us', // DESC NATAL/RN
  '120363423496684075@g.us', // DESC TESTE
]);

// ── Estado em memória ─────────────────────────────────────────────────────────
let _contratos = new Map(); // contrato → { addedAt, addedBy, addedByName, grupo }
let _ultimoReset = null;

function _salvar() {
  try {
    const obj = {
      contratos: Object.fromEntries(_contratos),
      ultimoReset: _ultimoReset,
    };
    fs.writeFileSync(TEL_PATH, JSON.stringify(obj, null, 2));
  } catch(e) {}
}

function _carregar() {
  try {
    if (!fs.existsSync(TEL_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(TEL_PATH, 'utf8'));
    if (raw.contratos) {
      _contratos = new Map(Object.entries(raw.contratos));
    }
    _ultimoReset = raw.ultimoReset || null;
    console.log(`[TEL] ${_contratos.size} contratos prioritários carregados`);
  } catch(e) {}
}

function resetar() {
  const qtd = _contratos.size;
  _contratos.clear();
  _ultimoReset = new Date().toISOString();
  _salvar();
  console.log(`[TEL] reset diário — ${qtd} contratos removidos`);
}

// Verifica se precisa resetar (às 23:00)
function _checarReset() {
  const agora  = new Date();
  const hora   = agora.getHours();
  const minuto = agora.getMinutes();
  if (hora === 23 && minuto === 0) {
    const hoje = agora.toDateString();
    if (_ultimoReset !== hoje) {
      _ultimoReset = hoje;
      resetar();
    }
  }
}

// Inicia verificação de reset a cada minuto
function iniciar() {
  _carregar();
  setInterval(_checarReset, 60000);
  console.log('[TEL] sistema de contratos prioritários ativo');
}

// ── Handler do comando !tel ───────────────────────────────────────────────────
async function handleTel({ sock, chatId, m, msgTextoRaw, usuarioId, nomeUsuario }) {
  const body = msgTextoRaw.trim().slice(4).trim(); // remove "!tel"
  if (!body) {
    const lista = [..._contratos.keys()];
    if (!lista.length) {
      await sock.sendMessage(chatId, { text: '📋 Nenhum contrato prioritário registrado hoje.' }, { quoted: m });
      return;
    }
    await sock.sendMessage(chatId, {
      text: `📋 *Contratos prioritários hoje (${lista.length}):*\n${lista.map((c, i) => `${i+1}. ${c}`).join('\n')}\n\n_Reseta às 23:00_`
    }, { quoted: m });
    return;
  }

  // Extrai todos os números de contrato (6-9 dígitos)
  const novos = (body.match(/\b\d{6,9}\b/g) || []);
  if (!novos.length) {
    await sock.sendMessage(chatId, { text: '❌ Não encontrei nenhum contrato válido. Use: *!tel 1234567 1234568*' }, { quoted: m });
    return;
  }

  let adicionados = 0;
  for (const c of novos) {
    if (!_contratos.has(c)) {
      _contratos.set(c, {
        addedAt:      new Date().toISOString(),
        addedBy:      usuarioId,
        addedByName:  nomeUsuario || usuarioId,
        grupo:        chatId,
      });
      adicionados++;
    }
  }
  _salvar();

  const total = _contratos.size;
  await sock.sendMessage(chatId, {
    text: `✅ *${adicionados} contrato(s) adicionado(s)!*\n📋 Total hoje: *${total}*\n\n${novos.map(c => `• ${c}`).join('\n')}\n\n_Serei avisado se alguém mencionar esses contratos no grupo._`
  }, { quoted: m });
}

// ── Comando !tel del para remover ────────────────────────────────────────────
async function handleTelDel({ sock, chatId, m, msgTextoRaw }) {
  const body = msgTextoRaw.trim().slice(8).trim();
  const nums = (body.match(/\b\d{6,9}\b/g) || []);
  if (!nums.length) return;
  let removidos = 0;
  for (const c of nums) { if (_contratos.delete(c)) removidos++; }
  _salvar();
  await sock.sendMessage(chatId, { text: `🗑️ ${removidos} contrato(s) removido(s). Total: ${_contratos.size}` }, { quoted: m });
}

// ── Verifica se uma mensagem menciona contrato prioritário ─────────────────────
async function verificarMencao({ sock, chatId, m, msgTextoRaw, usuarioId, nomeUsuario, toaBridge }) {
  if (!_contratos.size) return;
  if (!GRUPOS_MONITORADOS.has(chatId)) return; // só monitora grupos autorizados

  // Extrai números da mensagem
  const nums = (msgTextoRaw.match(/\b\d{6,9}\b/g) || []);
  if (!nums.length) return;

  for (const num of nums) {
    if (!_contratos.has(num)) continue;

    const info     = _contratos.get(num);
    const nome     = nomeUsuario || usuarioId?.replace('@s.whatsapp.net', '') || 'Alguém';
    const horario  = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    // Busca dados do contrato no TOA se disponível
    let dadosToa = '';
    if (toaBridge) {
      try {
        const found = toaBridge.findByContract(num);
        if (found) {
          dadosToa = `\n👤 *${found.nome || 'N/D'}*`;
          if (found.janela)  dadosToa += ` | 🕐 ${found.janela}`;
          if (found.tecnico) dadosToa += `\n👷 ${found.tecnico}`;
        }
      } catch(e) {}
    }

    const nomeGrupo = {
      '120363397790697942@g.us': 'DESC FORTALEZA/CE',
      '120363420013377509@g.us': 'DESC MOSSORO/RN',
      '120363028547806621@g.us': 'DESC NATAL/RN',
      '120363423496684075@g.us': 'DESC TESTE',
    }[chatId] || chatId;

    const aviso = `🔔 *CONTRATO PRIORITÁRIO MENCIONADO*\n` +
      `📋 Contrato: *${num}*${dadosToa}\n` +
      `👤 Mencionado por: *${nome}*\n` +
      `💬 Grupo: *${nomeGrupo}*\n` +
      `🕐 Horário: ${horario}\n\n` +
      `_"${msgTextoRaw.slice(0, 100)}"_`;

    await sock.sendMessage(ID_GRUPO_TESTES, { text: aviso });
    console.log(`[TEL] contrato prioritário ${num} mencionado por ${nome} em ${chatId}`);

    // Registra na planilha do Google Sheets
    // Extrai técnico e código de baixa da mensagem
    const tecnicoToa = (() => {
      try {
        const found = toaBridge?.findByContract(num);
        return found?.tecnico || '';
      } catch(e) { return ''; }
    })();

    // Tenta extrair código de baixa da mensagem (3 dígitos)
    const mCodMsg = msgTextoRaw.match(/(1\d{2}|2\d{2}|3\d{2}|4[0-3]\d)/g);
    const codBaixaMsg = mCodMsg ? mCodMsg[mCodMsg.length - 1] : '';

    try {
      const { registrarNaPlanilha } = require('./telSheetsHandler');
      await registrarNaPlanilha({
        contrato:  num,
        tecnico:   tecnicoToa,
        codBaixa:  codBaixaMsg,
        obs:       '',
        grupoId:   chatId,
      });
    } catch(e) {
      console.error('[TEL] erro ao registrar no Sheets:', e.message);
    }
  }
}

function temContrato(num) { return _contratos.has(String(num)); }
function listar()         { return [..._contratos.keys()]; }

module.exports = { iniciar, handleTel, handleTelDel, verificarMencao, resetar, temContrato, listar };
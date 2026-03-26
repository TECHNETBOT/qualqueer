const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { spawn } = require('child_process');

// IMPORTAÇÕES LOCAIS
const C = require('./src/config');
const Utils = require('./src/utils');
const Data = require('./src/data');
const Sheets = require('./src/sheets');
const Alerts = require('./src/alerts');
const { gerarComprovanteDevolucao, getFollowupText } = require('./src/gerador');
const { lerTextoDeImagem } = require('./src/ocr'); 
const { processarMensagemPonto, gerarRelatorioDia, gerarRelatorioCSV } = require('./src/ponto');
const { compare430, formatForCopy } = require('./src/compare430');
const { createToaBridge } = require('./src/toaBridge');
const { analisarMensagem: analisarNiveis, consultarNiveis, TEXTO_CIDADES } = require('./src/niveis');
const { chamarIAComHistorico, conversaIA } = require('./src/ia');
const { parseRelatorioTxt } = require('./src/relatorio');
const { deveDisparar: deveDispararComprovante, handleComprovante } = require('./src/handlers/comprovante');
const { handleAtivo, conversasAtivas } = require('./src/handlers/ativo');
const { responderClienteAtivo, encerrarConversaCliente, iniciarConversaCliente } = require('./src/ia');
const { handleNiveis } = require('./src/handlers/niveisHandler');
const { handleDocumento, handleImprodutivas, handleBater } = require('./src/handlers/documentos');
const { iniciar: iniciarTel, handleTel, handleTelDel, verificarMencao: verificarTel } = require('./src/handlers/telHandler');
const { handleCanal } = require('./src/handlers/canalHandler');
iniciarTel();
const { iniciarMonitorReset: iniciarSheetsReset } = require('./src/handlers/telSheetsHandler');
iniciarSheetsReset();

// CONFIGURAÇÃO DOS GRUPOS
const ID_GRUPO_TESTE = '120363423496684075@g.us';
const ID_GRUPO_RELATORIO = '120363423496684075@g.us'; 
const ID_GRUPO_ADESAO = '558496022125-1485433351@g.us';
const ID_GRUPO_TECNICOS = '120363422121095440@g.us'; 
const ID_GRUPO_CONTATOS = '120363422121095440@g.us'; 
const ID_GRUPO_CONTROLADORES_PONTO = '558488045008-1401380014@g.us';
const ID_GRUPO_COMPROVANTE = process.env.ID_GRUPO_COMPROVANTE || '120363406741761305@g.us';
const ID_GRUPO_DESCONEXAO_CONTATOS = '120363406791829383@g.us';

const GRUPOS_CONTATOS_TOA = new Set([
  ID_GRUPO_CONTROLADORES_PONTO,
  ID_GRUPO_CONTATOS,
  ID_GRUPO_TESTE,
  ID_GRUPO_DESCONEXAO_CONTATOS,
]);

const BOT_BUILD = process.env.BOT_BUILD || 'v30';
let PLANILHA_ATIVA = false;
const precisaValidarURA = (chatId) => chatId === ID_GRUPO_TECNICOS;

const DATA_DIR = path.join(__dirname, 'data');
const AUTH_DIR = path.join(__dirname, 'auth_baileys');
const WHATS_TXT_PATH = path.join(DATA_DIR, 'whats.txt');
const WHATS_CSV_PATH = path.join(DATA_DIR, 'whats.csv');
const IMPERIUM_XLSX_PATH = path.join(DATA_DIR, 'imperium.xlsx');
const RELATORIO_TXT_PATH = path.join(DATA_DIR, 'relatorio.txt');

const TOA_BRIDGE_PORT = Number(process.env.TOA_BRIDGE_PORT || 8787);
const TOA_BRIDGE_HOST = process.env.TOA_BRIDGE_HOST || '127.0.0.1';
const TOA_BRIDGE_TOKEN = process.env.TOA_BRIDGE_TOKEN || '';
const toaBridge = createToaBridge({ dataDir: DATA_DIR, port: TOA_BRIDGE_PORT, host: TOA_BRIDGE_HOST, token: TOA_BRIDGE_TOKEN });
toaBridge.start();

// ── Knowledge Loader — carrega arquivos da pasta data/knowledge/ na memória da IA
const { iniciarMonitor: iniciarKnowledge } = require('./src/knowledgeLoader');
iniciarKnowledge();

function limparSessaoWhatsApp() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('🗑️  Sessão antiga removida — aguardando novo QR...');
    }
  } catch (e) {
    console.error('❌ Erro ao limpar sessão:', e.message);
  }
}

function startToaChromeAutomation() {
  if (process.env.TOA_AUTO_LOGIN_ENABLED === '0') {
    console.log(`🌐 [${BOT_BUILD}] abertura automática do TOA desativada por env (TOA_AUTO_LOGIN_ENABLED=0)`);
    return;
  }
  const scriptPath = path.join(__dirname, 'src', 'toa_auto_login.py');
  const pythonCmd = process.env.PYTHON_BIN || 'python3';
  const child = spawn(pythonCmd, [scriptPath], { env: { ...process.env, BOT_BUILD }, stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`🌐 [${BOT_BUILD}] abrindo Chrome no TOA...`);
  child.stdout.on('data', (data) => { const t = data.toString().trim(); if (t) console.log(`🌐 [${BOT_BUILD}] toa-open: ${t}`); });
  child.stderr.on('data', (data) => { const t = data.toString().trim(); if (t) console.log(`🌐 [${BOT_BUILD}] toa-open-err: ${t}`); });
  child.on('error', (err) => { console.log(`🌐 [${BOT_BUILD}] falha ao abrir TOA: ${err.message}`); });
  child.on('close', (code) => { console.log(`🌐 [${BOT_BUILD}] rotina de abertura TOA finalizada (code=${code})`); });
}

startToaChromeAutomation();

const limparArquivosComparacao430 = () => {
  [WHATS_TXT_PATH, WHATS_CSV_PATH, IMPERIUM_XLSX_PATH].forEach((filePath) => {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }
    catch (e) { console.error('Erro ao limpar arquivo 430:', filePath, e.message); }
  });
};

// === CACHE E MEMÓRIA ===
let CACHE_CONTRATOS = []; 
let CACHE_FORAROTA = []; 
let CONTRATOS_USADOS = new Set(Data.listaForaRotaUsados || []); 
const esperaConfirmacaoURA = new Map(); 
const esperaNiveis = new Map();
const TEMPO_ATUALIZACAO_MINUTOS = 5; 
let ultimoAlertaEnviado = "";
let ultimoAlertaVT = "";
let ultimoAlertaAD = "";
let ultimoAvisoRota = ""; 
let alertaIntervalId = null;
let cacheIntervalId = null; 
let relatorioEnviadoHoje = false;
let sock;
let reconnectTimeout = null;
let reconnectAttempts = 0;

// ==================== LOGS TOA ====================
const TOA_LOG = {
  info:  (msg) => console.log(`🌐 [TOA] ${msg}`),
  warn:  (msg) => console.warn(`⚠️  [TOA] ${msg}`),
  error: (msg) => console.error(`❌ [TOA] ${msg}`),
};

// ==================== FUNÇÕES DE CACHE ====================
async function atualizarCache() {
  console.log('🔄 Atualizando caches...');
  try {
    const dadosGeral = await Sheets.obterBaseContratos();
    if (dadosGeral && dadosGeral.length > 0) { CACHE_CONTRATOS = dadosGeral; console.log(`✅ CACHE GERAL: ${CACHE_CONTRATOS.length} linhas.`); }
    const dadosForaRota = await Sheets.obterBaseForaRota();
    if (dadosForaRota && dadosForaRota.length > 0) { CACHE_FORAROTA = dadosForaRota; console.log(`✅ CACHE FORA ROTA: ${CACHE_FORAROTA.length} linhas.`); }
  } catch (e) { console.error('❌ Erro fatal ao atualizar cache:', e); }
}

// ==================== FUNÇÕES TOA ====================
async function toaBridgeLookupWithTimeout(termo, timeoutMs = 500) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { resolve(null); }, timeoutMs);
    Promise.resolve(toaBridge.findByContract(termo))
      .then((result) => { clearTimeout(timer); resolve(result); })
      .catch((err) => { clearTimeout(timer); TOA_LOG.error(`findByContract falhou: ${err.message}`); resolve(null); });
  });
}

const _pollingAtivos = new Map();

function iniciarPollingEResponder({ chatId, termo, message, timeoutMs = 25000, intervalMs = 2000 }) {
  if (_pollingAtivos.has(termo)) {
    TOA_LOG.warn(`polling já ativo para contrato=${termo} — ignorando duplicata`);
    return;
  }
  const inicio = Date.now();
  TOA_LOG.info(`iniciando polling contrato=${termo} timeout=${timeoutMs}ms`);
  _pollingAtivos.set(termo, true);
  const interval = setInterval(async () => {
    const decorrido = Date.now() - inicio;
    const achado = toaBridge.findByContract(termo);
    if (achado) {
      clearInterval(interval);
      _pollingAtivos.delete(termo);
      TOA_LOG.info(`polling encontrou contrato=${termo} após ${decorrido}ms`);
      try {
        if (precisaValidarURA(chatId)) {
          esperaConfirmacaoURA.set(chatId, { contrato: termo, dadosToa: achado });
          await sock.sendMessage(chatId, { text: `📄 *Contrato:* ${termo}\n\nJá confirmou com a URA?\n\n_Responda apenas *Sim* ou *Não*_` }, { quoted: message });
        } else {
          await sock.sendMessage(chatId, { text: formatToaContactMessage(chatId, termo, achado) }, { quoted: message });
        }
      }
      catch (e) { TOA_LOG.error(`erro ao enviar resposta polling: ${e.message}`); }
      return;
    }
    if (decorrido >= timeoutMs) {
      clearInterval(interval);
      _pollingAtivos.delete(termo);
      TOA_LOG.warn(`polling expirado contrato=${termo} após ${decorrido}ms`);
      try {
        await sock.sendMessage(chatId, {
          text: `⚠️ Contrato *${termo}* não encontrado no TOA. Verifique manualmente.`
        }, { quoted: message });
      } catch (e) { TOA_LOG.error(`erro ao enviar timeout msg: ${e.message}`); }
    }
  }, intervalMs);
}

// ==================== FUNÇÕES AUXILIARES ====================
const enviarMensagemComMarcacaoLista = async (grupoId, textoBase, listaNumeros) => {
  try {
    if (!listaNumeros || listaNumeros.length === 0) { await sock.sendMessage(grupoId, { text: textoBase }); return; }
    const mentions = listaNumeros.map(num => `${num}@s.whatsapp.net`);
    const textoFinal = `${textoBase}\n\n${listaNumeros.map(num => `@${num}`).join(' ')}`;
    await sock.sendMessage(grupoId, { text: textoFinal, mentions });
    console.log(`📢 Aviso enviado para ${grupoId} (Marcados: ${listaNumeros.length})`);
  } catch (e) { console.error(`❌ Erro ao marcar lista no grupo ${grupoId}:`, e); }
};

const enviarMensagemComMarcacaoGeral = async (grupoId, textoBase) => {
  try {
    const metadata = await sock.groupMetadata(grupoId);
    const participantes = metadata.participants.map(p => p.id);
    const textoFinal = `${textoBase}\n\n${participantes.map(p => `@${p.split('@')[0]}`).join(' ')}`;
    await sock.sendMessage(grupoId, { text: textoFinal, mentions: participantes });
  } catch (e) { console.error(e); }
};

const validarNumero = async (chatId, numero, comandoExemplo) => {
  if (numero.length < 10) { await sock.sendMessage(chatId, { text: `❌ Número inválido. Use: ${comandoExemplo}` }); return false; }
  return true;
};

const adicionarNaLista = async (chatId, numero, arrayLista, funcaoSalvar, nomeLista, exemplo) => {
  if (!(await validarNumero(chatId, numero, exemplo))) return;
  if (arrayLista.includes(numero)) { await sock.sendMessage(chatId, { text: `⚠️ ${numero} já está na lista ${nomeLista}.` }); return; }
  arrayLista.push(numero); funcaoSalvar();
  await sock.sendMessage(chatId, { text: `✅ ${numero} adicionado em ${nomeLista}!\n📋 Total: ${arrayLista.length}` });
};

const removerDaLista = async (chatId, numero, arrayLista, funcaoSalvar, nomeLista) => {
  const index = arrayLista.indexOf(numero);
  if (index === -1) { await sock.sendMessage(chatId, { text: `⚠️ ${numero} não está na lista ${nomeLista}.` }); return; }
  arrayLista.splice(index, 1); funcaoSalvar();
  await sock.sendMessage(chatId, { text: `✅ ${numero} removido de ${nomeLista}!\n📋 Total: ${arrayLista.length}` });
};

const listarNumeros = async (chatId, lista, nomeLista) => {
  if (lista.length === 0) { await sock.sendMessage(chatId, { text: `📋 *${nomeLista}* - Vazio.` }); return; }
  let resposta = `📋 *LISTA ${nomeLista}:*\n\n`;
  lista.forEach((num, i) => { resposta += `${i + 1}. ${num}\n`; });
  resposta += `\n✅ Total: ${lista.length}`;
  await sock.sendMessage(chatId, { text: resposta });
};

async function exibirDadosContrato(chatId, encontrado, termoBusca, message) {
  let resposta = '';
  if (chatId === ID_GRUPO_CONTATOS || chatId === ID_GRUPO_TECNICOS) {
    resposta = `✅ *CONTATOS LIBERADOS* \n\n📄 *Contrato:* ${termoBusca}\n────────────────────\n`;
    if (encontrado['Telefone 1']) resposta += `📞 *Tel 1:* ${encontrado['Telefone 1']}\n`;
    if (encontrado['Telefone 2']) resposta += `📞 *Tel 2:* ${encontrado['Telefone 2']}\n`;
    if (encontrado['Telefone 3']) resposta += `📞 *Tel 3:* ${encontrado['Telefone 3']}\n`;
    resposta += `\nCaso não consiga contato, retornar com evidências.`;
  } else {
    resposta = `📄 *Contrato:* ${termoBusca}\n────────────────────\n`;
    if (encontrado['Telefone 1']) resposta += `📞 *Tel 1:* ${encontrado['Telefone 1']}\n`;
    if (encontrado['Telefone 2']) resposta += `📞 *Tel 2:* ${encontrado['Telefone 2']}\n`;
    if (encontrado['Telefone 3']) resposta += `📞 *Tel 3:* ${encontrado['Telefone 3']}`;
  }
  await sock.sendMessage(chatId, { text: resposta }, { quoted: message });
}

function formatToaContactMessage(chatId, termoBusca, data) {
  let resposta = '';
  if (chatId === ID_GRUPO_CONTATOS || chatId === ID_GRUPO_TECNICOS) resposta = `✅ *CONTATOS LIBERADOS (TOA)*\n\n`;
  resposta += `📄 *Contrato:* ${termoBusca}\n────────────────────\n`;
  data.telefones.forEach((tel, index) => { resposta += `📞 *Tel ${index + 1}:* ${tel}\n`; });
  resposta += `────────────────────\n`;
  if (data.janela) resposta += `🕐 *Janela:* ${data.janela}\n`;
  if (data.tecnico) resposta += `👷 *Técnico:* ${data.tecnico}\n`;
  return resposta.trim();
}

function runPythonToaLookup(contract) {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, 'src', 'toa_lookup.py');
    const pythonCmd = process.env.PYTHON_BIN || 'python3';
    const child = spawn(pythonCmd, [scriptPath, String(contract)], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('error', (err) => { resolve({ ok: false, error: err.message, stdout, stderr }); });
    child.on('close', (code) => { resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }); });
  });
}

// ==================== MAIN ====================
async function connectToWhatsApp() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`📦 Versão WhatsApp Web usada: ${version.join('.')} (latest: ${isLatest})`);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'fatal' }),
    browser: ['Bot Consulta', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    version,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📱 QR Code recebido! Escaneie com o WhatsApp.');
      qrcode.generate(qr, { small: true }, (qrCode) => console.log(qrCode));
    }

    if (connection === 'close') {
      const err = lastDisconnect?.error;
      const statusCode = (err instanceof Boom) ? err.output.statusCode : 'desconhecido';
      console.log(`🔌 Conexão fechada. Motivo: ${statusCode}`);

      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const isBadSession = statusCode === DisconnectReason.badSession || statusCode === 500;

      if (isLoggedOut || isBadSession) {
        console.log(`🔑 Sessão inválida (${statusCode}) — limpando credenciais para gerar novo QR...`);
        limparSessaoWhatsApp();
        reconnectAttempts = 0;
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(() => connectToWhatsApp(), 2000);
        return;
      }

      if (statusCode === DisconnectReason.restartRequired) {
        console.log('🔄 Restart required — reconectando...');
        reconnectAttempts = 0;
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(() => connectToWhatsApp(), 1000);
        return;
      }

      reconnectAttempts += 1;
      const retryDelayMs = Math.min(3000 * reconnectAttempts, 15000);
      console.log(`🔄 Tentando reconectar em ${Math.round(retryDelayMs / 1000)}s...`);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      reconnectTimeout = setTimeout(() => connectToWhatsApp(), retryDelayMs);

    } else if (connection === 'open') {
      reconnectAttempts = 0;
      if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
      console.log(`--- BOT ATIVO (FINAL HYBRID VERSION) [${BOT_BUILD}] ---`);
      await atualizarCache();
      console.log(`💾 Histórico Fora Rota carregado: ${CONTRATOS_USADOS.size} contratos já enviados.`);

      if (cacheIntervalId) clearInterval(cacheIntervalId);
      cacheIntervalId = setInterval(async () => { await atualizarCache(); }, TEMPO_ATUALIZACAO_MINUTOS * 60 * 1000);

      if (alertaIntervalId) clearInterval(alertaIntervalId);
      alertaIntervalId = setInterval(async () => {
        const agora = new Date();
        const horaAtual = agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });
        
        const horariosAlertaTec1 = { "11:45": "das 08h às 12h", "14:45": "das 12h às 15h", "17:45": "das 15h às 18h" };
        if (horariosAlertaTec1[horaAtual] && ultimoAlertaEnviado !== horaAtual) { Alerts.enviarAlertaJanela(sock, horariosAlertaTec1[horaAtual], C.ID_GRUPO_ALERTAS); ultimoAlertaEnviado = horaAtual; }
        
        const horariosAlertaVT = { "09:45": ["08:00 às 10:00"], "10:45": ["08:00 às 11:00"], "11:45": ["10:00 às 12:00"], "13:45": ["11:00 às 14:00", "12:00 às 14:00"], "15:45": ["14:00 às 16:00"], "16:45": ["14:00 às 17:00"], "17:45": ["16:00 às 18:00"], "19:45": ["17:00 às 20:00", "18:00 às 20:00"] };
        if (horariosAlertaVT[horaAtual] && ultimoAlertaVT !== horaAtual) { Alerts.enviarAlertaGenerico(sock, { titulo: 'VISITA TÉCNICA (VT)', janelas: horariosAlertaVT[horaAtual], idDestino: C.ID_GRUPO_ALERTAS, lista: Data.listaVT, logPrefixo: 'VT' }); ultimoAlertaVT = horaAtual; }

        const horariosAlertaAD = { "11:45": ["08:00 às 12:00"], "14:45": ["12:00 às 15:00"], "17:45": ["15:00 às 18:00"] };
        if (horariosAlertaAD[horaAtual] && ultimoAlertaAD !== horaAtual) { Alerts.enviarAlertaGenerico(sock, { titulo: 'ADESÃO', janelas: horariosAlertaAD[horaAtual], idDestino: C.ID_GRUPO_ALERTAS, lista: Data.listaAD, logPrefixo: 'ADESÃO' }); ultimoAlertaAD = horaAtual; }

        const horariosRota = ["07:40", "07:50", "08:00"];
        if (horariosRota.includes(horaAtual) && ultimoAvisoRota !== horaAtual) {
          const mensagemRota = "Bom dia a todos!\n\nLembrando que é necessário ativar a rota até às 8h.\nÀs 8h05, o sistema desativa automaticamente as rotas não ativas.\n\nContamos com a colaboração de todos.";
          // Marca TODOS no grupo de adesão (não só a lista AD)
          await enviarMensagemComMarcacaoGeral('558496022125-1485433351@g.us', mensagemRota);
          ultimoAvisoRota = horaAtual;
        }

        if (horaAtual === "23:00" && !relatorioEnviadoHoje) {
          const csv = gerarRelatorioCSV();
          if (csv) { await sock.sendMessage(ID_GRUPO_RELATORIO, { text: `📋 *FECHAMENTO DO DIA*\n\n\`\`\`${csv}\`\`\`` }); }
          relatorioEnviadoHoje = true;
        }
        if (horaAtual === "00:00") relatorioEnviadoHoje = false;
      }, 30000);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      const m = messages[0];
      if (type !== 'notify' || m.key.fromMe) return;
      const msgTextoRaw = m.message?.conversation || m.message?.extendedTextMessage?.text || m.message?.imageMessage?.caption || m.message?.documentMessage?.caption || '';
      const msgTexto = msgTextoRaw.toLowerCase().trim();
      const msgTextoSemAcento = msgTexto.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const chatId = m.key.remoteJid;

      // ── INTERCEPTAR RESPOSTA DE CLIENTE (conversa ativa via !ativo ou IA) ──
      // Checa tanto conversasAtivas (ativo.js) quanto historicoClientes (ia.js)
      const { getConversaCliente: _getConvCliente } = require('./src/ia');
      const _convIaAtiva = !chatId.endsWith('@g.us') ? _getConvCliente(chatId) : null;
      const _isClienteAtivo = !chatId.endsWith('@g.us') && (conversasAtivas.has(chatId) || !!_convIaAtiva);

      if (_isClienteAtivo) {
        // Garante que conversasAtivas também tem o registro (sincroniza os dois maps)
        if (_convIaAtiva && !conversasAtivas.has(chatId)) {
          conversasAtivas.set(chatId, {
            contrato:              _convIaAtiva.contrato,
            nomeCliente:           _convIaAtiva.nomeCliente,
            tecnico:               _convIaAtiva.tecnico,
            chatOrigemControlador: _convIaAtiva.chatOrigemControlador,
          });
        }
        const dadosConv = conversasAtivas.get(chatId) || _convIaAtiva;
        const isAudio   = !!(m.message?.audioMessage || m.message?.pttMessage);

        const nomeExib  = m.pushName || dadosConv.nomeCliente;
        const grupoAviso = dadosConv.chatOrigemControlador || ID_GRUPO_TESTE;

        // Se for áudio — avisa no grupo e não responde
        if (isAudio) {
          await sock.sendMessage(grupoAviso, {
            text: `🎵 *${nomeExib}* mandou um áudio!
📋 Contrato: *${dadosConv.contrato}*
📞 Número: *${chatId.replace('@s.whatsapp.net', '')}*
👷 Técnico: *${dadosConv.tecnico || 'N/D'}*

_Abra o chat pra ouvir e responder manualmente._`
          });
          return;
        }

        if (!msgTextoRaw.trim()) return;

        try {
          const resultado = await responderClienteAtivo(chatId, msgTextoRaw);
          if (resultado && resultado.resposta) {
            await sock.sendMessage(chatId, { text: resultado.resposta }, { quoted: m });
          }

          if (resultado && resultado.agendamentoConfirmado && resultado.resumo) {
            const ID_GRUPO_CONFIRMACAO = '120363426723812164@g.us';
            // 1. Manda no privado do cliente
            await sock.sendMessage(chatId, { text: resultado.resumo });
            // 2. Manda sempre no grupo fixo de confirmações
            await sock.sendMessage(ID_GRUPO_CONFIRMACAO, { text: resultado.resumo });
            // 3. Se o grupo de origem for diferente dos dois acima, manda lá também
            if (grupoAviso !== ID_GRUPO_CONFIRMACAO && grupoAviso !== chatId) {
              await sock.sendMessage(grupoAviso, { text: resultado.resumo });
            }
            console.log(`[IA-ATIVO] ⭕ CONFIRMADA — contrato ${dadosConv.contrato}`);
            conversasAtivas.delete(chatId);
            encerrarConversaCliente(chatId);
          }
        } catch (e) { console.error('[IA-ATIVO] erro ao responder cliente:', e.message); }
        return;
      }

      let usuarioId = m.key.participant || chatId;
      const nomeUsuario = m.key.participant ? m.pushName : null; 
      const isGrupo = chatId.endsWith('@g.us');
      const isGrupoAutorizado = Data.isGrupoAutorizado(chatId) || chatId === ID_GRUPO_TESTE;
      const isGrupoControladoresPonto = chatId === ID_GRUPO_CONTROLADORES_PONTO;
      const isImage = !!m.message?.imageMessage;
      const isQuotedImage = !!m.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
      const isDocument = !!m.message?.documentMessage;
      const documentCaption = (m.message?.documentMessage?.caption || '').toLowerCase().trim();

      const { criarExecutarComparacao430 } = require('./src/handlers/documentos');
      const executarComparacao430 = criarExecutarComparacao430({ sock, chatId, m, WHATS_TXT_PATH, WHATS_CSV_PATH, IMPERIUM_XLSX_PATH, limparArquivosComparacao430 });

      // ==================== COMANDO !TEL ====================
      if (msgTexto.startsWith('!tel del ')) {
        await handleTelDel({ sock, chatId, m, msgTextoRaw });
        return;
      }
      if (msgTexto.startsWith('!tel') && isGrupo) {
        await handleTel({ sock, chatId, m, msgTextoRaw, usuarioId, nomeUsuario });
        return;
      }

      // ==================== COMANDO !MENU ====================
      if (msgTexto === '!menu' || msgTexto === '!ajuda') {
        const menu = `🤖 *MENU DE COMANDOS* 🤖 (${BOT_BUILD})

🚛 *FORA ROTA*
• !forarota [Tecnico], [Bairro], [Qtd]
• !forarota-raw [Tecnico], [Texto]

📋 *LISTAS & MARCAÇÃO*
• !addvt [Numero] - Add na lista VT
• !unaddvt [Numero] - Remove VT
• !listavt - Ver lista VT
• !addad [Numero] - Add na lista Adesão (Rota)
• !unaddad [Numero] - Remove Adesão
• !listaad - Ver lista Adesão

🛠️ *FERRAMENTAS*
• !ler / !barcode - Ler código de barras
• !controlador - Relatório do dia
• !planilha - CSV do ponto
• !marcar - Marca TODOS (Cuidado!)
• !comparar430 / !relatorio430 - Compara Whats x Imperium

📎 *ARQUIVOS (documento)*
• Envie .txt/.csv + .xlsx — bot compara automático

🔍 *CONSULTA*
• "contatos 1234567" — busca no TOA
• ia faz ativo com esse 1234567 — manda mensagem ativa pro cliente
• !toastatus - Status do cache TOA
`;
        await sock.sendMessage(chatId, { text: menu }, { quoted: m });
        return;
      }

      // ==================== LISTAS DE MARCAÇÃO (VT / AD) ====================
      if (msgTexto.startsWith('!addvt ')) { await adicionarNaLista(chatId, Utils.normalizeDigits(msgTextoRaw.slice(7)), Data.listaVT, Data.salvarVT, 'VT', '!addvt 5584...'); return; }
      if (msgTexto.startsWith('!unaddvt ')) { await removerDaLista(chatId, Utils.normalizeDigits(msgTextoRaw.slice(9)), Data.listaVT, Data.salvarVT, 'VT'); return; }
      if (msgTexto === '!listavt') { await listarNumeros(chatId, Data.listaVT, 'VT'); return; }
      if (msgTexto.startsWith('!addad ')) { await adicionarNaLista(chatId, Utils.normalizeDigits(msgTextoRaw.slice(7)), Data.listaAD, Data.salvarAD, 'ADESÃO', '!addad 5584...'); return; }
      if (msgTexto.startsWith('!unaddad ')) { await removerDaLista(chatId, Utils.normalizeDigits(msgTextoRaw.slice(9)), Data.listaAD, Data.salvarAD, 'ADESÃO'); return; }
      if (msgTexto === '!listaad') { await listarNumeros(chatId, Data.listaAD, 'ADESÃO'); return; }

      // ==================== CAPTURA DE DOCUMENTOS ====================
      // ==================== CANAL DE VENDA (OCR foto marcando mensagem) ====================
      const _canalConsumido = await handleCanal({ sock, chatId, m, msgTextoRaw, toaBridge });
      if (_canalConsumido) return;

      if (isDocument) {
        const consumido = await handleDocumento({ sock, chatId, m, documentCaption, WHATS_TXT_PATH, WHATS_CSV_PATH, IMPERIUM_XLSX_PATH, RELATORIO_TXT_PATH, limparArquivosComparacao430 });
        if (consumido) return;
      }

      if (msgTexto === '!comparar430' || msgTexto === '!relatorio430' || msgTextoSemAcento === 'relatorio' || msgTextoSemAcento.startsWith('relatorio')) {
        await sock.sendMessage(chatId, { text: '📊 Gerando relatório 430/FR, aguarde...' }, { quoted: m });
        await executarComparacao430();
        return;
      }

      // ==================== COMANDOS RELATÓRIO: !improdutivas / !bater ====================
      if (msgTexto === '!improdutivas' || msgTexto === '!improdutiva') {
        await handleImprodutivas({ sock, chatId, m, RELATORIO_TXT_PATH });
        return;
      }

      if (msgTexto.startsWith('!bater ')) {
        await handleBater({ sock, chatId, m, msgTextoRaw, RELATORIO_TXT_PATH });
        return;
      }

      // ==================== [PRIORIDADE -2] GATILHO IA ====================
      const _quotedParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
      const _quotedMsg         = m.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      const _botJid            = sock.user?.id?.replace(/:.*@/, '@') || '';
      const isCitandoBot       = !!_quotedMsg && (!_quotedParticipant || _quotedParticipant.replace(/:.*@/, '@') === _botJid);
      const isPrivado          = !chatId.endsWith('@g.us');

      // Gatilhos fixos — em grupos exige palavra-chave, no privado responde tudo
      const { getGatilhosExtra, getNomeIA } = require('./src/ia');
      const nomeIA         = getNomeIA().toLowerCase();
      const gatilhosExtras = getGatilhosExtra();
      const _GATILHO_RE    = new RegExp(`^(ia|bot|rob[oô]|robozinho|robot|assistente|${nomeIA}|${gatilhosExtras.join('|') || 'zzz'})([\\s,!?]|$)`, 'i');
      const _GATILHO_EXATO = new RegExp(`^(ia|bot|robo|robozinho|robot|${nomeIA}|${gatilhosExtras.join('|') || 'zzz'})$`, 'i');

      const gatilhoIA = isPrivado
        ? true
        : (_GATILHO_RE.test(msgTextoRaw.trim()) || _GATILHO_EXATO.test(msgTextoSemAcento.trim()) || isCitandoBot);

      const IA_KEY = process.env.MISTRAL_API_KEY || process.env.OR_API_KEY || '';
      if (gatilhoIA && IA_KEY) {
        const pergunta = isPrivado
          ? msgTextoRaw.trim()
          : (msgTextoRaw.replace(_GATILHO_RE, '').trim() || msgTextoRaw.trim());

        if (!pergunta) return;
        const motivo = isPrivado ? 'privado' : (isCitandoBot ? 'citacao' : 'gatilho');
        console.log(`[IA] ${motivo} em ${chatId}: "${pergunta.slice(0, 60)}"`);
        try {
          const { iaConversaAtiva } = require('./src/ia');
          iaConversaAtiva.set(chatId, { lastAt: Date.now() });

          // Passa sock para que ativo_ia possa enviar feedback imediato
          const resposta = await chamarIAComHistorico(chatId, pergunta, { toaBridge, isPrivado, sock });

          // ── Ativo disparado pela IA (handleAtivo já enviou tudo, resposta é null) ─
          // null = handleAtivo tratou, não faz nada
          // objeto _tipo ativo_ia = fallback legado (não deve acontecer mais)
          if (resposta === null || resposta === undefined) {
            // handleAtivo já enviou feedback no grupo — não faz nada
          } else if (resposta && typeof resposta === 'object' && resposta._tipo === 'ativo_ia') {
            // Fallback legado — não deve chegar aqui mais
            console.log('[IA] resposta ativo_ia legado ignorada');
          // ── Resposta texto normal ────────────────────────────────────────
          } else if (typeof resposta === 'string' && resposta.trim()) {
            await sock.sendMessage(chatId, { text: resposta }, { quoted: m });
          }
          // null silencioso no privado — não manda erro

        } catch (e) { console.error('[IA] erro:', e.message); }
        return;
      }

      // ==================== [PRIORIDADE 0] VERIFICAÇÃO URA ====================
      if (esperaConfirmacaoURA.has(chatId)) {
        const contexto = esperaConfirmacaoURA.get(chatId);
        if (msgTextoSemAcento === 'sim') {
          if (contexto.dadosToa) {
            await sock.sendMessage(chatId, { text: formatToaContactMessage(chatId, contexto.contrato, contexto.dadosToa) }, { quoted: m });
          } else {
            await exibirDadosContrato(chatId, contexto.dados, contexto.contrato, m);
          }
          esperaConfirmacaoURA.delete(chatId); return; 
        } else if (msgTextoSemAcento === 'nao' || msgTextoSemAcento === 'não') {
          await sock.sendMessage(chatId, { text: '⚠️ Por favor valide na URA antes de pegar o contato.' }, { quoted: m });
          esperaConfirmacaoURA.delete(chatId); return;
        }
      }

      // ==================== CONTRATOS PRIORITÁRIOS (verificação silenciosa) ====================
      if (isGrupo && msgTextoRaw.trim()) {
        await verificarTel({ sock, chatId, m, msgTextoRaw, usuarioId, nomeUsuario: m.pushName, toaBridge }).catch(() => {});
      }

      // ==================== [PRIORIDADE 1] !FORAROTA ====================
      if (msgTexto.startsWith('!forarota ')) {
        const params = msgTextoRaw.slice(10).split(',').map(p => p.trim());
        if (params.length < 2) { await sock.sendMessage(chatId, { text: '❌ Uso: !forarota [Tecnico], [Bairro], [Quantidade (opcional)]' }, { quoted: m }); return; }
        const [tecnico, bairroBusca, qtdStr] = params;
        const qtd = parseInt(qtdStr) || 1;
        const disponiveis = CACHE_FORAROTA.filter(r => r.bairro && r.bairro.toLowerCase().includes(bairroBusca.toLowerCase()) && !CONTRATOS_USADOS.has(r.contrato));
        if (disponiveis.length === 0) { await sock.sendMessage(chatId, { text: `⚠️ Nenhuma OS disponível para *${bairroBusca}* (ou todas já foram enviadas).` }, { quoted: m }); return; }
        const selecionados = disponiveis.slice(0, qtd);
        selecionados.forEach(r => CONTRATOS_USADOS.add(r.contrato));
        Data.salvarForaRotaUsados(Array.from(CONTRATOS_USADOS));
        for (let item of selecionados) {
          await sock.sendMessage(chatId, { text: `⭕ FORA ROTA ⭕\n\nCONTRATO: ${item.contrato}\nNOME: ${item.cliente}\nEND: ${item.endereco}\nTEL: ${item.telefone}\nTECNICO: ${tecnico}` });
          await new Promise(r => setTimeout(r, 800));
        }
        return;
      }

      // ==================== [PRIORIDADE 2] !FORAROTA-RAW ====================
      if (msgTexto.startsWith('!forarota-raw ')) {
        const content = msgTextoRaw.slice(14);
        const primeiroVirgula = content.indexOf(',');
        if (primeiroVirgula === -1) return;
        const tecnico = content.substring(0, primeiroVirgula).trim();
        const textoBruto = content.substring(primeiroVirgula + 1).trim();
        const regexContrato = /(\d{7,})([A-Z\s.]+)/g;
        let matchRaw, resultados = [];
        while ((matchRaw = regexContrato.exec(textoBruto)) !== null) {
          const contrato = matchRaw[1], resto = matchRaw[2];
          const telefoneMatch = resto.match(/(859\d{8})/);
          const telefone = telefoneMatch ? telefoneMatch[0] : 'N/D';
          resultados.push({ contrato, info: resto.replace(telefone, '').trim(), telefone });
        }
        if (resultados.length === 0) { await sock.sendMessage(chatId, { text: '⚠️ Não identifiquei dados no texto.' }, { quoted: m }); return; }
        for (let item of resultados) {
          await sock.sendMessage(chatId, { text: `⭕ FORA ROTA ⭕\n\nCONTRATO: ${item.contrato}\nDADOS: ${item.info}\nTEL: ${item.telefone}\nTECNICO: ${tecnico}` });
          await new Promise(r => setTimeout(r, 800));
        }
        return;
      }

      // ==================== [PRIORIDADE 3] COMPROVANTE ====================
      if (deveDispararComprovante({ msgTextoRaw, msgTextoSemAcento, chatId, ID_GRUPO_COMPROVANTE })) {
        try {
          await handleComprovante({ sock, chatId, m, msgTextoRaw, msgTextoSemAcento });
        } catch (err) {
          console.error('Erro comprovante:', err);
          await sock.sendMessage(chatId, { text: `❌ Erro ao gerar comprovante: ${err.message}` }, { quoted: m });
        }
        return;
      }

      // ==================== [PRIORIDADE 3B] !ATIVO — MENSAGEM ATIVA MANUAL ====================
      if (msgTextoRaw.trim().toLowerCase().startsWith('!ativo ')) {
        await handleAtivo({ sock, chatId, m, msgTextoRaw, toaBridge });
        return;
      }

      // ==================== [PRIORIDADE 4] ADMIN/PONTO/OCR ====================
      if (isGrupo && msgTexto === '!marcar') { await enviarMensagemComMarcacaoGeral(chatId, "⚠️ *TESTE DE MARCAÇÃO GERAL*"); return; }
      if (msgTexto === '!id') { await sock.sendMessage(chatId, { text: `🆔 Chat: ${chatId}\n👤 User: ${usuarioId}` }, { quoted: m }); return; }
      if (msgTexto === '!controlador') { if (!isGrupoControladoresPonto) return; await sock.sendMessage(chatId, { text: gerarRelatorioDia() }, { quoted: m }); return; }
      if (msgTexto === '!planilha') { if (!isGrupoControladoresPonto) return; const csv = gerarRelatorioCSV(); await sock.sendMessage(chatId, { text: `📋 *HORÁRIOS DO DIA*\n\n_Copie o bloco abaixo:_\n\n\`\`\`${csv}\`\`\`` }, { quoted: m }); return; }
      if (msgTexto === '!ligarplanilha') { if (!GRUPOS_CONTATOS_TOA.has(chatId)) return; PLANILHA_ATIVA = true; await sock.sendMessage(chatId, { text: '✅ Fallback da planilha *ativado*.' }, { quoted: m }); return; }
      if (msgTexto === '!desligarplanilha') { if (!GRUPOS_CONTATOS_TOA.has(chatId)) return; PLANILHA_ATIVA = false; await sock.sendMessage(chatId, { text: '⛔ Fallback da planilha *desativado*.' }, { quoted: m }); return; }
      if (msgTexto === '!toastatus') {
        if (!GRUPOS_CONTATOS_TOA.has(chatId)) return;
        const stats = toaBridge.stats();
        await sock.sendMessage(chatId, { text: `🌐 *TOA Bridge* [${BOT_BUILD}]\nContratos: *${stats.contracts}*\nTelefones: *${stats.phones}*\nPorta: *${stats.port}*\nPendentes: *${stats.pendingLookups || 0}*` }, { quoted: m });
        return;
      }

      if (isGrupoControladoresPonto && msgTextoRaw.length > 0 && msgTextoRaw.length < 200) {
        const resultadoPonto = processarMensagemPonto(nomeUsuario, msgTextoRaw, m.messageTimestamp);
        if (resultadoPonto) { await sock.sendMessage(chatId, { react: { text: '✅', key: m.key } }); console.log(`⏰ Ponto: ${resultadoPonto.nome} (${resultadoPonto.horario})`); }
      }

      if (msgTexto === '!ler' || msgTexto === '!barcode' || msgTexto === '!codigo') {
        let buffer = null;
        if (isImage) {
          buffer = await downloadMediaMessage(m, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        } else if (isQuotedImage) {
          const msgCitada = { message: m.message.extendedTextMessage.contextInfo.quotedMessage, key: { id: m.message.extendedTextMessage.contextInfo.stanzaId, remoteJid: chatId, participant: m.message.extendedTextMessage.contextInfo.participant } };
          buffer = await downloadMediaMessage(msgCitada, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        }
        if (buffer) {
          await sock.sendMessage(chatId, { react: { text: '👀', key: m.key } });
          const tmpImg = path.join(DATA_DIR, `barcode_tmp_${Date.now()}.png`);
          fs.writeFileSync(tmpImg, buffer);
          const barcodeResult = await new Promise((resolve) => {
            const py = spawn(process.env.PYTHON_BIN || 'python3', [path.join(__dirname, 'src', 'barcode.py'), tmpImg]);
            let out = '';
            py.stdout.on('data', d => out += d.toString());
            py.on('close', () => {
              try { fs.unlinkSync(tmpImg); } catch(e) {}
              try { resolve(JSON.parse(out.trim())); } catch(e) { resolve(null); }
            });
          });
          if (barcodeResult && Array.isArray(barcodeResult) && barcodeResult.length > 0) {
            let resposta = `📡 *CÓDIGOS ENCONTRADOS:*\n`;
            barcodeResult.forEach(c => { resposta += `\n🏷️ *${c.tipo}:* \`${c.valor}\``; });
            await sock.sendMessage(chatId, { text: resposta }, { quoted: m });
          } else if (barcodeResult && barcodeResult.error) {
            await sock.sendMessage(chatId, { text: `❌ ${barcodeResult.error}` }, { quoted: m });
          } else {
            await sock.sendMessage(chatId, { text: '❌ Não consegui ler nenhum código de barras.' }, { quoted: m });
          }
        } else {
          await sock.sendMessage(chatId, { text: '📸 Manda a foto junto com *!barcode*, ou cite uma imagem e manda o comando.' }, { quoted: m });
        }
        return;
      }

      // ==================== [PRIORIDADE 4B] NÍVEIS DE SINAL ====================
      // Só dispara se tiver "niveis" ou "sinais" explícito na mensagem
      if (chatId === ID_GRUPO_CONTROLADORES_PONTO || chatId === ID_GRUPO_TESTE) {
        const consumidoPorNiveis = await handleNiveis({ sock, chatId, m, msgTexto, usuarioId, esperaNiveis });
        if (consumidoPorNiveis) return;
      }

      // ==================== [PRIORIDADE 5A] CONTATOS TOA (3 GRUPOS) ====================
      const msgToaNorm = msgTextoRaw.replace(/\r?\n/g, ' ').toLowerCase().trim();

      const ID_GRUPO_CONTROLADORES = '558488045008-1401380014@g.us';

      const regexTecnicos      = /(?:c[o0]ntr?a?t+[oa]s?|contt\w*|contats?|contactos?|ctt|cct)\D*(\d{6,9})|(\d{6,9})\D*(?:c[o0]ntr?a?t+[oa]s?|contt\w*|contats?|contactos?|ctt|cct)/i;
      // Grupo controladores: APENAS "contatos NUMERO" ou "NUMERO contatos" — nada mais
      const regexControladores = /\bcontatos?\s+\D{0,5}(\d{6,9})\b|(\d{6,9})\b\s*\D{0,5}contatos?\b/i;
      const regexDesconexao    = /(?:c[o0]ntr?a?t+[oa]s?|contt\w*|contats?|ctt|cct)\D*(\d{6,9})|(\d{6,9})\D*(?:c[o0]ntr?a?t+[oa]s?|contt\w*|contats?|ctt|cct)|^(\d{6,9})$/i;

      const matchControladores = chatId === ID_GRUPO_CONTROLADORES
        ? msgToaNorm.match(regexControladores)
        : chatId === ID_GRUPO_DESCONEXAO_CONTATOS
          ? msgToaNorm.trim().match(regexDesconexao)
          : msgToaNorm.match(regexTecnicos);

      if (GRUPOS_CONTATOS_TOA.has(chatId) && matchControladores) {
        const termo = matchControladores[1] || matchControladores[2] || matchControladores[3];
        TOA_LOG.info(`busca disparada — grupo=${chatId} contrato=${termo} build=${BOT_BUILD}`);

        const achadoCache = await toaBridgeLookupWithTimeout(termo, 500);
        if (achadoCache) {
          TOA_LOG.info(`cache hit — contrato=${termo} telefones=${achadoCache.telefones.length}`);
          if (precisaValidarURA(chatId)) {
            esperaConfirmacaoURA.set(chatId, { contrato: termo, dadosToa: achadoCache });
            await sock.sendMessage(chatId, { text: `📄 *Contrato:* ${termo}\n\nJá confirmou com a URA?\n\n_Responda apenas *Sim* ou *Não*_` }, { quoted: m });
          } else {
            await sock.sendMessage(chatId, { text: formatToaContactMessage(chatId, termo, achadoCache) }, { quoted: m });
          }
          return;
        }

        TOA_LOG.warn(`cache miss — contrato=${termo}; enfileirando auto-lookup`);
        const lookupQueued = toaBridge.queueLookup(termo);
        TOA_LOG.info(`queue-lookup contrato=${termo} queued=${lookupQueued}`);

        runPythonToaLookup(termo)
          .then((py) => { TOA_LOG.info(`python lookup ${py.ok ? '✅' : '⚠️'} contrato=${termo} code=${py.code ?? 'n/a'}`); })
          .catch((err) => TOA_LOG.error(`python erro: ${err.message}`));

        iniciarPollingEResponder({ chatId, termo, message: m, timeoutMs: 45000, intervalMs: 2000 });

        if (PLANILHA_ATIVA) {
          if (CACHE_CONTRATOS.length === 0) await atualizarCache();
          const achadoPlanilha = CACHE_CONTRATOS.find(r => r['Contrato'] === termo);
          if (achadoPlanilha) {
            TOA_LOG.info(`fallback planilha encontrou contrato=${termo}`);
            if (precisaValidarURA(chatId)) {
              esperaConfirmacaoURA.set(chatId, { contrato: termo, dados: achadoPlanilha });
              await sock.sendMessage(chatId, { text: `📄 *Contrato:* ${termo}\n\nJá confirmou com a URA?\n\n_Responda apenas *Sim* ou *Não*_` }, { quoted: m });
            } else {
              await exibirDadosContrato(chatId, achadoPlanilha, termo, m);
            }
          }
        }
        return;
      }

      // ==================== [PRIORIDADE 5] BUSCA DE CONTRATO (PLANILHA) ====================
      const match = msgTexto.match(/(?:contatos?|conttatos|contats)\D*(\d{6,9})|(\d{6,9})\D*(?:contatos?|conttatos|contats)/i);
      
      if (match && GRUPOS_CONTATOS_TOA.has(chatId)) {
        const termo = match[1] || match[2];
        console.log(`🔍 [${BOT_BUILD}] busca contrato autorizada em ${chatId}: ${termo}`);
        if (CACHE_CONTRATOS.length === 0) {
          await sock.sendMessage(chatId, { text: `⚠️ Estou atualizando a base de dados agora, tente novamente em 1 minuto.` }, { quoted: m });
          await atualizarCache(); return;
        }
        const achado = CACHE_CONTRATOS.find(r => r['Contrato'] === termo);
        if (achado) {
          if (precisaValidarURA(chatId)) {
            esperaConfirmacaoURA.set(chatId, { contrato: termo, dados: achado });
            await sock.sendMessage(chatId, { text: `📄 *Contrato:* ${termo}\n\nJá confirmou com a URA?\n\n_Responda apenas *Sim* ou *Não*_` }, { quoted: m });
          } else {
            await exibirDadosContrato(chatId, achado, termo, m);
          }
        } else if (chatId === ID_GRUPO_CONTATOS) {
          await sock.sendMessage(chatId, { text: `⚠️ [${BOT_BUILD}] Contatos não encontrado na Base de Dados, favor retornar ao seu controlador.` }, { quoted: m });
        }
        return; 
      }

    } catch (e) { console.error('Erro msg:', e); }
  });
  return sock;
}

connectToWhatsApp();
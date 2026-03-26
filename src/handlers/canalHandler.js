// src/handlers/canalHandler.js
// Fluxo:
// 1. Alguém manda "097/5190103 canal" no grupo
// 2. Outra pessoa responde MARCANDO essa mensagem com uma foto
// 3. Bot faz OCR na foto → extrai campos → gera template formatado

const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// Grupos que ativam o fluxo de canal
const GRUPOS_CANAL = new Set([
  '558488045008-1401380014@g.us', // Controladores
  '120363423496684075@g.us',      // Teste
]);

// Cidades por código
const CIDADES = {
  '095': 'NATAL/RN',
  '097': 'FORTALEZA/CE',
  '947': 'MOSSORÓ/RN',
  '637': 'PARNAMIRIM/RN',
  '136': 'RECIFE/PE',
};

// Guarda mensagens pendentes de canal: msgId → { contrato, cidade, solicitanteId, solicitanteNome, ts }
const _pendentesCanal = new Map();
const TTL_CANAL = 30 * 60 * 1000; // 30 minutos

// Limpa pendentes expirados
setInterval(() => {
  const agora = Date.now();
  for (const [k, v] of _pendentesCanal.entries()) {
    if (agora - v.ts > TTL_CANAL) _pendentesCanal.delete(k);
  }
}, 5 * 60 * 1000);

// ── Detecta se mensagem é pedido de canal ─────────────────────────────────────
// Padrão: "097/5190103 canal" ou "095/3909710 dados" etc.
// Mapeia nomes de cidade para código (compartilhado)
const NOMES_CIDADES = {
  'natal':       '095',
  'fortaleza':   '097',
  'fortal':      '097',
  'mossoro':     '947',
  'mossoró':     '947',
  'parnamirim':  '637',
  'recife':      '136',
};

// Extrai cidade+contrato de uma mensagem (usado por canal e dados)
function _extrairCidadeContrato(msgTextoRaw, keyword) {
  const norm = msgTextoRaw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const kw   = keyword.toLowerCase();

  // Código numérico: "095/999 canal" | "097 999, dados"
  let m = msgTextoRaw.match(new RegExp(`\\b(095|097|947|637|136)\\s*[\\/\\s,]\\s*(\\d{6,9})\\b[\\s\\S]*?\\b${kw}\\b`, 'i'));

  // Nome de cidade: "natal/999 dados" | "fortaleza 999 canal"
  if (!m) {
    for (const [nome, cod] of Object.entries(NOMES_CIDADES)) {
      const re = new RegExp(`\\b${nome}\\b[\\s\\/,]+(\\d{6,9})\\b[\\s\\S]*?\\b${kw}\\b`, 'i');
      const mn = norm.match(re);
      if (mn) { m = [null, cod, mn[1]]; break; }
    }
  }
  return m ? { codCidade: m[1], contrato: m[2], cidade: CIDADES[m[1]] || m[1] } : null;
}

function detectarPedidoCanal(msgTextoRaw) {
  const base = _extrairCidadeContrato(msgTextoRaw, 'canal');
  if (!base) return null;

  const { codCidade, contrato, cidade } = base;

  // Detecta código de baixa (3 dígitos, 100-499, diferente do cod cidade)
  const semBase = msgTextoRaw.replace(codCidade, '').replace(contrato, '');
  let codBaixa = null;
  const mCod = semBase.match(/[,\s]+0*(\d{3})\b(?!\d)/g);
  if (mCod) {
    for (const t of mCod) {
      const n = parseInt(t.replace(/[^\d]/g, ''));
      if (n >= 100 && n <= 499 && String(n) !== codCidade) { codBaixa = n; break; }
    }
  }
  return { codCidade, contrato, cidade, codBaixa, modo: 'canal' };
}

function detectarPedidoDados(msgTextoRaw) {
  const base = _extrairCidadeContrato(msgTextoRaw, 'dados');
  if (!base) return null;
  return { ...base, modo: 'dados' };
}

// ── OCR via Mistral Vision (mais preciso para texto em imagem) ────────────────
async function _ocrMistral(imageBuffer) {
  const apiKey = process.env.MISTRAL_API_KEY || '';
  if (!apiKey) return null;
  try {
    const axios = require('axios');
    const b64   = imageBuffer.toString('base64');
    const resp  = await axios.post('https://api.mistral.ai/v1/chat/completions', {
      model: 'pixtral-12b-2409',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${b64}` },
          },
          {
            type: 'text',
            text: `Extraia APENAS os dados desse formulário/imagem. Pode ser uma tela do sistema TOA (Oracle) ou uma tabela de dados de venda.

Responda em JSON com esses campos (use null se não encontrar):
{
  "data_venda": "...",
  "empresa": "...",
  "equipe": "...",
  "midia": "...",
  "promocao": "...",
  "tipo_venda": "...",
  "vendedor": "...",
  "campanha": "...",
  "tipo_atividade": "..."
}

Exemplos de onde encontrar "tipo_atividade": campo "Tipo de Atividade" na tela do TOA (ex: "Instalacao", "Subs de controle Streaming", "Retirada").
Responda APENAS o JSON, sem explicação.`,
          },
        ],
      }],
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    });
    const texto = resp.data?.choices?.[0]?.message?.content?.trim();
    if (!texto) return null;
    const clean = texto.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('[CANAL] Mistral OCR erro:', e.message);
    return null;
  }
}

// ── OCR com prompt customizado (para NetHome/dados) ─────────────────────────
async function _ocrMistralComPrompt(imageBuffer, promptText) {
  const apiKey = process.env.MISTRAL_API_KEY || '';
  if (!apiKey) return null;
  try {
    const axios = require('axios');
    const b64   = imageBuffer.toString('base64');
    const resp  = await axios.post('https://api.mistral.ai/v1/chat/completions', {
      model: 'pixtral-12b-2409',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
          { type: 'text', text: promptText },
        ],
      }],
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    });
    const texto = resp.data?.choices?.[0]?.message?.content?.trim();
    if (!texto) return null;
    return JSON.parse(texto.replace(/```json|```/g, '').trim());
  } catch (e) {
    console.error('[CANAL] OCR dados erro:', e.message);
    return null;
  }
}

// ── OCR via Tesseract (fallback local) ───────────────────────────────────────
async function _ocrTesseract(imageBuffer) {
  try {
    const Tesseract = require('tesseract.js');
    const { data: { text } } = await Tesseract.recognize(imageBuffer, 'por', { logger: () => {} });
    return text;
  } catch (e) {
    console.error('[CANAL] Tesseract erro:', e.message);
    return null;
  }
}

// ── Parseia texto bruto (fallback se vision falhar) ──────────────────────────
function _parsearTexto(texto) {
  const t = texto.toUpperCase();
  const get = (patterns) => {
    for (const p of patterns) {
      const m = t.match(p);
      if (m && m[1]?.trim()) return m[1].trim();
    }
    return null;
  };
  return {
    empresa:    get([/EMPRESA[:\s]+([^\n]+)/, /LTDA[:\s]+([^\n]+)/]),
    tipo_venda: get([/TIPO DE VENDA[:\s]+([^\n]+)/, /TIPO_VENDA[:\s]+([^\n]+)/]),
    vendedor:   get([/VENDEDOR[:\s]+([^\n]+)/]),
    campanha:   get([/CAMPANHA[:\s]+([^\n]+)/]),
    promocao:   get([/PROMOÇÃO[:\s]+([^\n]+)/, /PROMOCAO[:\s]+([^\n]+)/]),
    midia:      get([/MÍDIA[:\s]+([^\n]+)/, /MIDIA[:\s]+([^\n]+)/]),
    equipe:     get([/EQUIPE[:\s]+([^\n]+)/]),
    data_venda: get([/DATA DA VENDA[:\s]+([^\n]+)/, /DATA[:\s]+(\d{2}\/\d{2}\/\d{4})/]),
  };
}

// ── Gera template formatado ──────────────────────────────────────────────────
const DESC_CODIGOS = {
  100: 'AGENDAMENTO NAO CUMPRIDO',
  101: 'ENDERECO NAO LOCALIZADO',
  103: 'CHUVA',
  104: 'FALTA DE MATERIAL',
  105: 'SEM ENERGIA ELETRICA NA REGIAO/PREDIO/RESIDENCIA',
  106: 'CLIENTE  AUSENTE',
  107: 'ENTRADA NAO AUTORIZADA',
  109: 'PAGAMENTO APRESENTADO',
  110: 'PROBLEMA NA TUBULACAO',
  111: 'REAGENDAMENTO SOLICITADO PELO CLIENTE',
  112: 'SEM ACESSO AO DG / SOTAO / COMODO',
  113: 'SEM TV / COMPUTADOR NA RESIDENCIA/ CELULAR',
  114: 'HABILITAÇÃO DE TELEFONE NÃO LIBERADA',
  125: 'CLIENTE DESISTE DA AGENDA',
  126: 'SITUACAO PONTUAL DE RISCO',
  127: 'AREA DE RISCO BLOQUEIO DE ENDERECO',
  128: 'TUB. GPON OBSTRUÍDA SEM SOLUÇÃO COM CABO HFC',
  129: 'ANALISE DE SEGURANCA PUBLICA',
  130: 'SEM ACESSO A BANDA LARGA',
  131: 'CONTRATO CADASTRADO NAO REGULARIZADO',
  169: 'EXEC. SEM SUCESSO APÓS VÁRIAS TENTATIVAS​',
  201: 'PROVEDOR COM PROBLEMA',
  202: 'NODE EM OUTAGE',
  203: 'REDE MOVEL COM PROBLEMA',
  204: 'BACKBONE COM PROBLEMA',
  205: 'FALTA TAP OU PASSIVO / TAP OU PASSIVO LOTADO',
  206: 'PREDIO SEM BACKBONE',
  207: 'PREDIO SEM RETORNO ATIVADO',
  208: 'PROBLEMA NO NOW',
  209: 'NAP LOTADA EM MDU',
  211: 'FALTA NAP / NAP LOTADA',
  217: 'BACKBONE GPON COM PROBLEMA',
  301: 'TIPO DE OS INCORRETA',
  302: 'DESISTENCIA DA ASSINATURA / SERVICO',
  304: 'CLIENTE NAO PAGOU TAXA INSTALACAO',
  305: 'RUA NAO CABEADA',
  306: 'NAO RESIDE NO ENDERECO',
  307: 'RESIDENCIA EM CONSTRUCAO / REFORMA',
  308: 'INSTALACAO NAO CONTEMPLARA PADRAO',
  309: 'COMPUTADOR NAO POSSUI CONFIGURACAO MINIMA',
  311: 'DEFEITO INTERMITENTE - NÃO RESOLVIDO',
  312: 'CLIENTE NÃO SOLICITOU O SERVICO',
  314: 'MUDOU-SE',
  315: 'RETIRADO LOJA CLARO',
  316: 'RUA NAO CABEADA GPON',
  317: 'INVIABILIDADE DE SINAL 3G / 4G INSUFICIENTE',
  318: 'SEM VISADA',
  319: 'CLIENTE NÃO POSSUI COMPROVANTE DE ENDEREÇO',
  320: 'CLIENTE RECUSA-SE A ENTREGAR COMPROVANTE DE ENDEREÇO',
  321: 'INSTALAÇÃO NÃO AUTORIZADA PELO SINDICO',
  322: 'EM NEGOCIAÇÃO COM SINDICO',
  323: 'SUSPEITA DE SERVIÇO IRREGULAR',
  324: 'SEM SINAL 3G/4G NA REGIÃO',
  325: 'CLIENTE SOLICITA REAGENDAMENTO DA VISITA',
  328: 'ENTREGA CONCLUIDA',
  400: 'INFORMACAO / CORRECAO CADASTRAL',
  401: 'CABO NAO IDENTIFICADO',
  402: 'DIVERGENCIA DE DADOS CADASTRAIS',
  404: 'CLIENTE RECUSA-SE DEVOLVER O DECODER / CABLE MODEM',
  408: 'SERVIÇO CONCLUÍDO SEM MOVIMENTAÇÃO DE TERMINAL',
  409: 'SERVICO CONCLUIDO',
  410: 'AUTO INSTALACAO CONCLUIDA',
  412: 'INSTALACAO / RETIRADA DE TRAP',
  420: 'ENTREGA LOJA CONCLUIDA',
  425: 'TROCA DE TECNOLOGIA',
  426: 'TROCA DE PLACA DE REDE',
  428: 'DESCONEXAO EFETUADA COM RETIRADA DE EQUIPAMENTO',
  429: 'DESCONEXAO EFETUADA SEM RETIRADA DE EQUIPAMENTO',
  430: 'EQUIPAMENTO RETIRADO',
  433: 'MANUTENCAO AP REALIZADA',
  440: 'EQUIPAMENTO ROUBADO / FURTADO / EXTRAVIADO',
  441: 'REDE DE DADOS WI-FI OU MISTA EXECUTADA COM SUCESSO',
  442: 'REDE DE DADOS FISICA EXECUTADA COM SUCESSO',
  452: 'STAND BY DO CABLE MODEM - EMTA',
  453: 'CYBER ANJO CONFIGURACAO EFETUADA',
  467: 'RESOLVIDO DURANTE A VISTORIA',
  469: 'CASO INDEFINIDO',
  470: 'CASO IMPROCEDENTE',
  471: 'RECONFIGURACAO DO SSID - SENHA EXTENSOR',
  472: 'INSTRUCOES DE USO DO EQUIPAMENTO - EXTENSOR',
  473: 'NECESSIDADE DE INSTALACAO VIA CABO ETHERNET',
  474: 'REPOSICIONADO O EXTENSOR',
  475: 'VELOCIDADE DO EXTENSOR CONFORME CONTRATADO',
  476: 'RECONFIGURADO - PAREAMENTO EXTENSORES',
  477: 'INSTALACAO MESH CABEADA',
  478: 'CONFIGURACAO CONCLUIDA',
  479: 'CLIENTE INFORMA JÁ TER DEVOLVIDO O EQUIPAMENTO',
  480: 'DIVERGENCIA POLITICA PRODUTO MESH',
  481: 'DEVOLUCAO DO BEM AO CLIENTE',
  482: 'SOLICITACAO DE REEMBOLSO',
  483: 'TROCA DE EXTENSOR MESH TRAVADO',
  484: 'TROCA DE EXTENSOR MESH QUEIMADO',
  500: 'READEQUAÇÃO DE SINAL - PASSIVOS',
  501: 'AMPLIFICADOR EQUALIZADO',
  502: 'AMPLIFICADOR COM DEFEITO - TROCA',
  503: 'AMPLIFICADOR QUEIMADO - TROCA',
  504: 'INSTALAÇÃO DE AMPLIFICADOR',
  505: 'PASSIVO INTERNO QUEIM./DEGRAD. - TROCA',
  506: 'PASSIVO INTERNO FORA DO PADRÃO - TROCA',
  507: 'PASSIVO MDU QUEIM./DEGRAD. - TROCA',
  508: 'PASSIVO MDU FORA DO PADRÃO - TROCA',
  509: 'CABLE ISOLATOR DANIFICADO/QUEIMADO - TROCA',
  510: 'FONTE COM DEFEITO - TROCA',
  511: 'CONTROLE REMOTO/DANIFICADO/EXTRAVIADO - TROCA',
  512: 'CONTROLE REMOTO COM DEFEITO - TROCA',
  513: 'INCOMPATIBILIDADE DA TECNOLOGIA / TV',
  514: 'ENVIO DE HIT - HABILITAR CANAIS',
  515: 'ENVIO DE HIT - CORREÇÃO DO UPDATE ID',
  516: 'T.T - TRAVADO',
  517: 'T.T - QUEIMADO',
  518: 'T.T - NÃO HABILITA / NÃO SINCRONIZA',
  519: 'T.T - NÃO GRAVA',
  520: 'T.T - NÃO ATUALIZA SW',
  521: 'T.T - INTERMITENTE',
  522: 'T.T - IN / OUT QUEIMADAS',
  523: 'T.T - ALCANCE WIFI',
  524: 'T.T - SOLIC. CLIENTE',
  525: 'T.T - FALHA EM IMAGEM/QUADRICULANDO',
  526: 'T.T - ERRO DE LEITURA SMART',
  527: 'T.T - NÃO NAVEGA',
  528: 'T.T - PROBLEMA DE FALHA NO ÁUDIO',
  529: 'T.T - MODELO NÃO COMPATÍVEL',
  530: 'T.T POR OUTRO COLOCADO NO MESMO SERVIÇO',
  531: 'SMART QUE NÃO HABILITA - TROCA',
  532: 'SMART COM TELA PRETA - TROCA',
  533: 'RESET NA CONFIG TERMINAL - TRAVADO',
  534: 'RESET NA CONFIG TERMINAL - SOLICIT SENHA',
  535: 'RESET NA CONFIG TERMINAL - NÃO ATUALIZA',
  536: 'RECONFIGURADO ROTEADOR DO CLIENTE',
  537: 'RECONFIGURADO EMTA/ROTEADOR NET-WIFI',
  538: 'RECONFIGURAÇÃO DO FORMATO DA IMAGEM',
  539: 'RECONFIGURAÇÃO DE AUDIO',
  540: 'CONECTOR INTERNO OXIDADO - TROCA',
  541: 'CONECTOR INTERNO MAL FEITO - TROCA',
  542: 'CONECTOR INTERNO FORA DO PADRÃO - TROCA',
  543: 'CONECTOR TAP OXIDADO  - TROCA',
  544: 'CONECTOR TAP MAL FEITO - TROCA',
  545: 'CONECTOR TAP - FORA DO PADRÃO - TROCA',
  546: 'CONECTOR MDU OXIDADO - TROCA',
  547: 'CONECTOR MDU MAL FEITO - TROCA',
  548: 'CONECTOR MDU FORA DO PADRÃO - TROCA',
  549: 'VELOCIDADE DO VIRTUA CONFORME CONTRATADA',
  550: 'CANAL NÃO PERTECE AO PACOTE CONTRATADO',
  551: 'SINTONIA EFETUADA - AV/HDMI',
  552: 'INSTRUÇÕES DO USO DA INTERATIVIDADE',
  553: 'INSTRUÇÕES DE USO DO CONTROLE REMOTO',
  554: 'INSTRUÇÕES SOBRE SMART CARD',
  555: 'SEM DEFEITO NO PRODUTO VIRTUA RECLAMADO',
  556: 'SEM DEFEITO NO PRODUTO TV RECLAMADO',
  557: 'SEM DEFEITO NO PRODUTO NETFONE RECLAMADO',
  558: 'BOOT NO TERMINAL',
  559: 'RECONFIGURADO COMPUTADOR',
  560: 'EQUIPAMENTO / REDE DE DADOS CLIENTE COM DEFEITO',
  561: 'PONTO SEM CADASTRO NÃO REGULARIZADO',
  562: 'CABO RECONECTADO/IDENTIFICADO',
  563: 'RECONEXÃO DOS CABOS NO EQUIPAMENTO DO CLIENTE',
  564: 'CABOS ESPECIAIS COM DEFEITO - TROCA',
  565: 'ENTREGA DE CABOS ESPECIAIS',
  566: 'REFEITO DROP',
  567: 'REFEITO CABEAMENTO COAXIAL',
  568: 'CABEAMENTO TELEFÔNICO REFEITO',
  569: 'NECESSÁRIO REFAZER CABEAMENTO TELEFÔNICO',
  570: 'NECESSÁRIO REFAZER CABEAMENTO COAXIAL',
  571: 'ENCAMINHADO À EMBRATEL',
  572: 'PROBLEMA IDENTIFICADO NO CIRCUITO DE VIDEO',
  573: 'DATA CENTER / HEADEND COM PROBLEMA',
  574: 'CORREÇÃO EFETUADA NO DATA CENTER',
  575: 'TOMADA TELEFONE COM PROBLEMA - TROCA',
  576: 'DISTRIBUIDOR T COM PROBLEMA - TROCA',
  577: 'CONECTOR RJ11 OXIDADO - TROCA',
  578: 'CONECTOR RJ11 MAL FEITO - TROCA',
  579: 'LIMPEZA DE RUÍDO EXECUTADA',
  580: 'CONECTOR RJ45 OXIDADO/MAL FEITO - TROCA',
  581: 'CABEAMENTO RJ45 REFEITO',
  582: 'ROTEADOR COM PROBLEMA',
  583: 'NECESSARIO REFAZER CABEAMENTO OPTICO',
  584: 'CONECTOR OPTICO INTERNO DANIFICADO',
  585: 'TROCA DE PAINEL',
  586: 'TROCA DE SENSOR',
  587: 'TROCA DE CAMERA',
  588: 'CONECTOR OPTICO MDU/DIO DANIFICADO',
  589: 'CONECTOR OPTICO REDE EXTERNA NAP DANIFICADO',
  590: 'PTO COM DEFEITO TROCA',
  591: 'PATCH CORD COM DEFEITO TROCA',
  592: 'VISITA TECNICA UHU PROCEDE',
  593: 'VISITA TECNICA UHU NAO PROCEDE',
  594: 'RECONFIGURACAO DA SENHA DE WIFI',
  595: 'EQPTO CLIENTE NAO POSSUI TECN PARA PROD CONTRATADO',
  597: 'TROCA DE PILHA',
  598: 'SERVIÇO CONCLUIDO PARA CONTRUCAO DE MDU',
  599: 'REFAZER DROP BSOD',
  600: 'CANCELADO POR ATIVO-INSTRUÇÕES AO CLIENTE',
  601: 'CANCELADO POR ATIVO-ENVIO DE HIT',
  602: 'CANCELADO POR ATIVO-SINAL NORMALIZOU',
  603: 'CANCELADO POR ATIVO-REDE EXTERNA COM PROBLEMA',
  604: 'CANCELADO POR ATIVO-CLIENTE NÃO ESTARÁ DISPONÍVEL',
  605: 'CANCELADO POR ATIVO / TIPO DE OS INCORRETA',
  606: 'CANCELADO POR ATIVO / SINTONIA EFETUADA',
  607: 'CANC POR ATIVO/CANAL NAO PERTENCE PACOTE CONTRATO',
  608: 'CANCELADA POR ATIVO/ROTEADOR',
  609: 'CANC POR ATIVO/VELOC DO VIRTUA CONFORME CONTRATADA',
  610: 'CANC. POR ATIVO/STAND BY DO CABLE MODEM - EMTA',
  611: 'CANCELADO POR ATIVO / UPGRADE DATA CENTER',
  612: 'CANCELADO POR ATIVO / RECONEXAO DOS CABOS',
  613: 'CANCELADO POR ATIVO / DESISTENCIA DA ASS OU SERV',
  614: 'CANCELADO POR ATIVO / COMPUTADOR RECONFIGURADO',
  615: 'CANCELADO POR ATIVO /CLIENTE NÃO SOLICITOU SERVIÇO',
  616: 'CANCELADO POR ATIVO / EQUIPAMENTO DO CLIENTE COM DEFEITO',
  617: 'CANCELADO POR ATIVO / RECONFIGURADO SEGURANÇA DE REDE',
  618: 'CANC POR ATIVO / INSTRUÇÕES INTERATIVIDADE',
  619: 'CANCELADO POR ATIVO / INSTRUÇÕES NOW',
  620: 'CANC POR ATIVO /INSTRUÇÕES FRANQUIA EXCEDIDA',
  621: 'CANCELADO POR ATIVO / INSTRUÇÕES SMART CARD',
  622: '622 - CANC POR ATIVO / INSTRUÇÕES CONTROLE REMOTO',
  623: '623 - CANCELADO POR CONF DO EQUIPAMENTO CLIENTE',
  625: '625 - CANC POR ATIVO / CONFIG DE FORMATO DE IMAGEM',
  626: '626 - CANC POR ATIVO / CONFIGURAÇÃO DO DECODER',
  628: '628 - CANCELADO POR ATIVO / CONFIGURAÇÃO DE ÁUDIO',
  629: '629 - CANCELADO POR ATIVO / ROTEADOR COM PROBLEMA',
  631: '631 - CANCELADO POR ATIVO / CORREÇÃO DE CADASTRO',
  632: 'CANCELADA POR ATIVO/CORREÇÃO DE CADASTRO',
  633: '633 - CANC POR ATIVO / ABERTO CHAMADO PARA OS / OC',
  634: '634 - CANCELADO POR ATIVO IDENT. PROBLEMA MASSIVO',
  635: 'CANCELADA POR ATIVO/ ERRO DE PORTABILIDADE FONE HABILIT',
  636: 'CANCELADA POR ATIVO/ NÃO RESIDE NO ENDEREÇO',
  638: 'CANCELADA POR ATIVO/VT AGENDADA COM PROBLEMA MASSIVO',
  705: 'ENTREGA CHIP SEM SUCESSO',
  706: 'ENTREGA CHIP COM SUCESSO',
  710: 'TROCA DE ANTENA DANIFICADA/FURTO/EXTRAVIO',
  711: 'REAPONTAMENTO DE ANTENA UHF',
  712: 'REAPONTAMENTO DE ANTENA KU OBST. DE SINAL',
  713: 'TROCA DE LNB DANIFICADO/QUEIMADO',
  714: 'PROBLEMA DE UHF-MDU',
  715: 'CORREÇÃO CEP PARA HABILITAÇÃO DO CANAL GLOBO',
  716: 'CEP SEM CANAL GLOBO DISPONIVEL',
  717: 'REAPONTAMENTO DE ANTENA KU DESALINHADA',
  721: 'TROCA DE PAR ANTENA/LNB (SERIALIZADO)',
  800: 'TRATAMENTO DE BACK LOG AUTOMATICO',
  850: 'BKO-ALTERAÇÃO APÓS BLOQUEIO',
  851: 'CRN-ALTERAÇÃO APÓS BLOQUEIO',
  853: 'VISTORIA DE MUDANCA DE ENDERECO',
  903: 'CAUSAS NATURAIS',
  999: 'CONTINGENCIA',
};

function gerarTemplate({ contrato, cidade, dados, codBaixa, tipoAtividade }) {
  const empresa3  = (dados.empresa || '').split(/\s+/).slice(0, 3).join(' ').trim() || 'N/D';
  const tipoVenda = (dados.tipo_venda || '').toUpperCase() || 'N/D';

  // TIPO OS: prioridade → TOA pré-buscado → tipo_atividade da foto → campanha da foto
  const campanha      = (dados.campanha      || '').toUpperCase() || '';
  const tipoFoto      = (dados.tipo_atividade || '').toUpperCase() || '';
  const tipoOs        = tipoAtividade || tipoFoto || campanha || 'N/D';

  // COD_BAIXA e OBS
  let linhaObs = `𝑶𝑩𝑺:`;
  let linhaCod = `𝑪𝑶𝑫_𝑩𝑨𝑰𝑿𝑨:`;
  if (codBaixa) {
    const desc = DESC_CODIGOS[codBaixa] || '';
    linhaCod = `𝑪𝑶𝑫_𝑩𝑨𝑰𝑿𝑨: ${codBaixa}`;
    linhaObs = `𝑶𝑩𝑺: ${desc}`;
  }

  return (
    `𝑪𝑰𝑫𝑨𝑫𝑬: ${cidade || 'N/D'}\n` +
    `𝑻𝑰𝑷𝑶 𝑶𝑺: ${tipoOs}\n` +
    `𝑪𝑶𝑵𝑻𝑹𝑨𝑻𝑶: ${contrato}\n` +
    `𝑻𝑬𝑳𝑬𝑭𝑶𝑵𝑬: URA\n` +
    `𝑪𝑨𝑵𝑨𝑳 𝑫𝑬 𝑽𝑬𝑵𝑫𝑨: ${tipoVenda}\n` +
    `𝑷𝑨𝑹𝑪𝑬𝑰𝑹𝑶: ${empresa3}\n` +
    `${linhaCod}\n` +
    `${linhaObs}`
  );
}

// ── Handler principal ─────────────────────────────────────────────────────────
async function handleCanal({ sock, chatId, m, msgTextoRaw, toaBridge }) {
  if (!GRUPOS_CANAL.has(chatId)) return false;

  const isImage       = !!m.message?.imageMessage;
  const quotedMsgId   = m.message?.extendedTextMessage?.contextInfo?.stanzaId
                     || m.message?.imageMessage?.contextInfo?.stanzaId;
  const quotedPartic  = m.message?.extendedTextMessage?.contextInfo?.participant
                     || m.message?.imageMessage?.contextInfo?.participant;

  // ── Caso 1: mensagem com "canal" ou "dados" + contrato → registra como pendente ──
  const pedido = detectarPedidoCanal(msgTextoRaw) || detectarPedidoDados(msgTextoRaw);
  if (pedido && !isImage) {
    const msgId = m.key.id;
    _pendentesCanal.set(msgId, {
      contrato:        pedido.contrato,
      cidade:          pedido.cidade,
      codCidade:       pedido.codCidade,
      codBaixa:        pedido.codBaixa || null,
      modo:            pedido.modo,  // 'canal' ou 'dados'
      solicitanteId:   m.key.participant || chatId,
      solicitanteNome: m.pushName || '',
      ts:              Date.now(),
    });
    // Busca antecipada no TOA — guarda no contexto para usar no template
    let toaInfo = null;
    if (toaBridge) {
      try {
        toaBridge.queueLookup(pedido.contrato);
        // Aguarda até 20s em background (não bloqueia a resposta)
        const _buscarToa = async () => {
          const deadline = Date.now() + 20000;
          while (Date.now() < deadline) {
            const found = toaBridge.findByContract(pedido.contrato);
            if (found) {
              // tipoAtividade não vem no cache — fica null por enquanto
              // A extensão não exporta esse campo, então usa a campanha da foto como fallback
              toaInfo = {
                tipoAtividade: null, // preenchido pela foto via OCR
                nome:          found.nome    || null,
                janela:        found.janela  || null,
                tecnico:       found.tecnico || null,
              };
              // Atualiza o contexto pendente com os dados do TOA
              const ctx = _pendentesCanal.get(msgId);
              if (ctx) ctx.toaInfo = toaInfo;
              console.log(`[CANAL] TOA encontrado para ${pedido.contrato}: tipo=${toaInfo.tipoAtividade}`);
              break;
            }
            await new Promise(r => setTimeout(r, 1500));
          }
        };
        _buscarToa().catch(() => {});
      } catch(e) {}
    }

    console.log(`[CANAL] pedido registrado: ${pedido.contrato} (${pedido.cidade}) msgId=${msgId}`);
    // Reage com 📋 pra indicar que registrou e está aguardando a foto
    await sock.sendMessage(chatId, { react: { text: '📋', key: m.key } });
    return true; // consome a mensagem — bloqueia o TOA de responder
  }

  // ── Caso 2: foto que marca uma mensagem pendente de canal ──────────────────
  if (isImage && quotedMsgId && _pendentesCanal.has(quotedMsgId)) {
    const ctx = _pendentesCanal.get(quotedMsgId);
    _pendentesCanal.delete(quotedMsgId);

    await sock.sendMessage(chatId, { react: { text: '🔍', key: m.key } });

    // Baixa a imagem
    let imageBuffer;
    try {
      imageBuffer = await downloadMediaMessage(m, 'buffer', {}, {
        logger: pino({ level: 'silent' }),
        reuploadRequest: sock.updateMediaMessage,
      });
    } catch (e) {
      console.error('[CANAL] erro ao baixar imagem:', e.message);
      await sock.sendMessage(chatId, { text: '❌ Não consegui baixar a imagem.' }, { quoted: m });
      return true;
    }

    // ── OCR da imagem ──────────────────────────────────────────────────────────
    // Prompt muda conforme o modo: canal (dados de venda) ou dados (NetHome)
    const promptOcr = ctx.modo === 'dados'
      ? `Extraia os dados desta tela do sistema NetHome/Claro. Responda APENAS em JSON:
{
  "nome": "...",
  "tel_cel": "...",
  "tel_res": "...",
  "tel_com": "...",
  "endereco": "...",
  "node": "...",
  "email": "..."
}
Use null se não encontrar. Sem explicação.`
      : null; // usa prompt padrão do _ocrMistral

    let dados;
    if (ctx.modo === 'dados') {
      dados = await _ocrMistralComPrompt(imageBuffer, promptOcr);
    } else {
      dados = await _ocrMistral(imageBuffer);
    }

    // Fallback: Tesseract
    if (!dados) {
      console.log('[CANAL] Mistral Vision falhou, tentando Tesseract...');
      const textoOcr = await _ocrTesseract(imageBuffer);
      if (textoOcr) dados = _parsearTexto(textoOcr);
    }

    if (!dados) {
      await sock.sendMessage(chatId, {
        text: `❌ Não consegui ler os dados da imagem.\nVerifique se a foto está nítida.`
      }, { quoted: m });
      return true;
    }

    await sock.sendMessage(chatId, { react: { text: '✅', key: m.key } });

    // ── Gera resposta conforme o modo ──────────────────────────────────────────
    if (ctx.modo === 'dados') {
      // Modo DADOS: exibe nome, telefones, endereço
      const nome    = (dados.nome    || 'N/D').trim();
      const telCel  = (dados.tel_cel || '').replace(/\D/g, '');
      const telRes  = (dados.tel_res || '').replace(/\D/g, '');
      const telCom  = (dados.tel_com || '').replace(/\D/g, '');
      const end     = (dados.endereco || 'N/D').trim();
      const node    = (dados.node || '').trim();

      let tels = [];
      if (telCel) tels.push(`📱 Cel: ${telCel}`);
      if (telRes) tels.push(`☎️ Res: ${telRes}`);
      if (telCom) tels.push(`🏢 Com: ${telCom}`);
      if (!tels.length) tels.push('📞 N/D');

      const respDados =
        `📋 *Dados do Assinante — Contrato ${ctx.contrato}*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 *Nome:* ${nome}\n` +
        tels.join('\n') + '\n' +
        `📍 *Endereço:* ${end}` +
        (node ? `\n🔌 *Node:* ${node}` : '');

      await sock.sendMessage(chatId, { text: respDados }, { quoted: m });
      console.log(`[CANAL] dados extraídos para contrato ${ctx.contrato}`);

    } else {
      // Modo CANAL: gera template completo
      let tipoAtividade = ctx.toaInfo?.tipoAtividade || null;
      if (!tipoAtividade && toaBridge) {
        try {
          const toa = toaBridge.findByContract(ctx.contrato);
          if (toa) {
            const tipo = toa.tipoAtividade || toa.activityType || toa.tipo || null;
            tipoAtividade = tipo ? String(tipo).trim().toUpperCase() : null;
          }
        } catch(e) {}
      }

      const template = gerarTemplate({
        contrato:      ctx.contrato,
        cidade:        ctx.cidade,
        codBaixa:      ctx.codBaixa || null,
        tipoAtividade: tipoAtividade,
        dados,
      });

      await sock.sendMessage(chatId, { text: template }, { quoted: m });
      console.log(`[CANAL] template gerado para contrato ${ctx.contrato}`);
    }

    return true;
  }

  return false;
}

module.exports = { handleCanal, detectarPedidoCanal, detectarPedidoDados, GRUPOS_CANAL };
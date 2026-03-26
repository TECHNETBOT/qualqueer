// src/ia.js — IA via Mistral com memória permanente e auto-aprendizado
const fs      = require('fs');
const path    = require('path');
const axios   = require('axios');
const Memoria = require('./memoria');

const DATA_DIR          = path.join(__dirname, '..', 'data');
const HISTORICO_IA_PATH = path.join(DATA_DIR, 'historico_ia.json');
const CONFIG_IA_PATH    = path.join(DATA_DIR, 'config_ia.json');

const MISTRAL_URL   = 'https://api.mistral.ai/v1/chat/completions';
const MISTRAL_MODEL = 'mistral-small-latest';

// ── Config maleável (nome, gatilhos personalizados) ───────────────────────────
function _carregarConfig() {
  try {
    if (fs.existsSync(CONFIG_IA_PATH)) return JSON.parse(fs.readFileSync(CONFIG_IA_PATH, 'utf8'));
  } catch (e) {}
  return { nome: 'IA', gatilhosExtra: [] };
}
function _salvarConfig(cfg) {
  try { fs.writeFileSync(CONFIG_IA_PATH, JSON.stringify(cfg, null, 2)); } catch(e) {}
}
function getNomeIA() { return _carregarConfig().nome || 'IA'; }
function setNomeIA(novoNome) {
  const cfg = _carregarConfig();
  cfg.nome = novoNome;
  _salvarConfig(cfg);
  console.log(`[IA] nome atualizado: ${novoNome}`);
}
function getGatilhosExtra() { return _carregarConfig().gatilhosExtra || []; }
function addGatilhoExtra(gatilho) {
  const cfg = _carregarConfig();
  if (!cfg.gatilhosExtra) cfg.gatilhosExtra = [];
  const g = gatilho.toLowerCase().trim();
  if (!cfg.gatilhosExtra.includes(g)) { cfg.gatilhosExtra.push(g); _salvarConfig(cfg); }
}

// ── System prompts ────────────────────────────────────────────────────────────
function _getSystemBase(isPrivado = false) {
  const nome = getNomeIA();

  // Modo PRIVADO — sempre cliente da Claro (nunca técnico nesse número)
  if (isPrivado) {
    return `Você é um atendente humano da Claro falando com um cliente via WhatsApp.
Seja simpático, natural, informal. Máximo 2-3 linhas por resposta.

REGRAS ABSOLUTAS:
- NUNCA fale código de baixa, processo interno, OS ou qualquer termo técnico
- NUNCA mencione que é IA, robô ou assistente virtual
- NUNCA peça CPF, número de contrato ou dado pessoal
- Se o cliente perguntar sobre serviço ou problema: "Deixa eu verificar isso pra você 😊"
- Português brasileiro informal`;
  }

  // Modo GRUPO — responde com mais detalhes técnicos
  return `Você é ${nome}, assistente da equipe Claro/Technet no Ceará.
Tem memória permanente e aprende com cada conversa.

FUNÇÕES:
- Responder sobre processos, códigos de baixa, equipamentos, MDU/GPON
- Buscar contatos: "contrato 1234567"
- Aprender: "aprende que X"
- Ver memória: "memória" ou "categorias"

EQUIPAMENTOS CLARO:
- DECODER: serial só números | EMTA: modem telefonia
- SMART/ONT/HGU: roteador fibra GPON | MASH: repetidor WiFi
- MDU: prédio GPON | DIO: distribuidor óptico | NAP MDU: splitter 1:8
- DROP: cabo externo → DIO | LOW FRICTION cinza: DIO→NAP | branco: NAP→PTO

CÓDIGOS PRINCIPAIS:
430=Fora de Rota | 106=Cliente ausente | 101=End. não localizado
125=Reagendamento | 409=Instalação concluída | 404=Envio de HIT
202=Node em outage | 211=Falta NAP | 302=Desistência

REGRAS:
- Use a memória antes de responder
- Máximo 4 linhas por resposta
- Se não souber: "não sei — me ensine: aprende que..."
- Português brasileiro
- NUNCA explique como fazer ativo manualmente`;
}

const SYSTEM_EXTRATOR = `Você é um extrator de conhecimento técnico sobre a Claro/Technet.
Analise a conversa e extraia fatos técnicos permanentes e úteis.

REGRAS:
- Só extraia sobre: códigos, equipamentos, processos, GPON, MDU, fibra óptica, clientes/contratos
- Frase curta — máx 150 caracteres
- Formato: "FATO[categoria]: texto"
- Categorias: codigo_baixa | equipamento | processo | tecnico | sistema | cliente
- Se não houver: NENHUM
- Máximo 3 fatos

Exemplos:
FATO[codigo_baixa]: Código 106 significa cliente ausente — não estava em casa
FATO[cliente]: Contrato 3713076 - Maria do Livramento - R da Campina 140 Apt 304 - P Negra Natal/RN`;

// Grupo fixo que sempre recebe o resumo de confirmação
const ID_GRUPO_CONFIRMACAO = '120363426723812164@g.us';

const SYSTEM_ATIVO_CLIENTE = `Você é um atendente humano da Claro falando com um cliente via WhatsApp.
O objetivo é confirmar a visita técnica na casa do cliente (retirada de equipamentos ou instalação).

REGRAS ABSOLUTAS — NUNCA QUEBRE:
- NUNCA peça CPF, número de contrato, OS ou qualquer dado pessoal
- NUNCA mencione dívida, cobrança, cancelamento, código interno ou inadimplência
- NUNCA diga que é IA, robô ou bot
- NUNCA explique processos internos da Claro
- Você só responde UMA VEZ por interação do cliente — seja direto
- Máximo 2 linhas por resposta
- Tom: humano, informal, simpático

FLUXO SIMPLES:
1. Cliente positivo (sim/pode/ok/tá bom/pode vir/estou em casa/qualquer afirmação) → CONFIRMAR NA HORA com o tag abaixo
2. Cliente negativo (não posso/não estou/ocupado/não) → Propor reagendamento: "Amanhã dá certo?" → depois "Depois de amanhã?" → depois encerrar
3. Endereço errado → pedir o correto e confirmar
4. NUNCA continue a conversa depois de confirmar ou depois de 1 resposta negativa

QUANDO CONFIRMAR, coloque EXATAMENTE ao final:
[AGENDAMENTO_CONFIRMADO]
janela: HH:MM - HH:MM
endereco: endereço completo
[/AGENDAMENTO_CONFIRMADO]`;

// ── Chamada Mistral com retry (axios — evita fetch failed no WSL) ────────────
async function _chamarOR(systemPrompt, mensagens, maxTokens = 500) {
  const apiKey = process.env.MISTRAL_API_KEY || '';
  if (!apiKey) { console.warn('[IA] MISTRAL_API_KEY não definida'); return null; }

  const MAX    = 3;
  const DELAYS = [1500, 4000, 8000];

  for (let i = 0; i < MAX; i++) {
    try {
      const resp = await axios.post(MISTRAL_URL, {
        model:       MISTRAL_MODEL,
        max_tokens:  maxTokens,
        temperature: 0.7,
        messages:    [{ role: 'system', content: systemPrompt }, ...mensagens],
      }, {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        timeout: 30000,
      });

      const texto = resp.data?.choices?.[0]?.message?.content?.trim();
      return texto ? { texto } : null;

    } catch (e) {
      const status = e.response?.status;
      if ([502, 503, 504].includes(status)) {
        console.warn(`[IA] Mistral ${status} (tentativa ${i+1}/${MAX})`);
        if (i < MAX - 1) { await new Promise(r => setTimeout(r, DELAYS[i])); continue; }
        return null;
      }
      if (status === 429) {
        console.warn(`[IA] Rate limit (tentativa ${i+1}/${MAX})`);
        if (i < MAX - 1) { await new Promise(r => setTimeout(r, 10000)); continue; }
        return null;
      }
      if (status) {
        console.warn(`[IA] erro ${status}: ${JSON.stringify(e.response?.data || '').slice(0, 120)}`);
        return null;
      }
      console.warn(`[IA] erro rede (tentativa ${i+1}/${MAX}): ${e.message}`);
      if (i < MAX - 1) { await new Promise(r => setTimeout(r, DELAYS[i])); continue; }
      return null;
    }
  }
  return null;
}

async function _chamarORTexto(system, msgs, maxTokens = 500) {
  const res = await _chamarOR(system, msgs, maxTokens);
  return res ? res.texto : null;
}

// ── Histórico permanente ──────────────────────────────────────────────────────
const historicoIA     = new Map();
const iaConversaAtiva = new Map();

function carregarHistoricoIA() {
  try {
    if (fs.existsSync(HISTORICO_IA_PATH)) {
      const raw = JSON.parse(fs.readFileSync(HISTORICO_IA_PATH, 'utf8'));
      for (const [k, v] of Object.entries(raw)) historicoIA.set(k, v);
      console.log(`[IA] históricos carregados: ${historicoIA.size} chats`);
    }
  } catch (e) { console.error('[IA] erro ao carregar histórico:', e.message); }
}

function salvarHistoricoIA() {
  try {
    const obj = {};
    for (const [k, v] of historicoIA.entries()) obj[k] = v;
    fs.writeFileSync(HISTORICO_IA_PATH, JSON.stringify(obj, null, 2));
  } catch (e) { console.error('[IA] erro ao salvar histórico:', e.message); }
}

carregarHistoricoIA();

// ── Detecta intenção ──────────────────────────────────────────────────────────
function detectarIntencao(msg) {
  const m = msg.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Renomear IA
  const mNome = m.match(/(?:agora\s+(?:voc[eê]\s+)?se\s+chama|seu\s+nome\s+[eé]|voc[eê]\s+se\s+chama|te\s+chama(?:r[aá]s?)?(?:\s+de)?)\s+([a-záéíóúâêîôûãõçñ0-9\-_]+)/i);
  if (mNome) return { tipo: 'renomear', dado: mNome[1].trim() };

  // Contrato
  const mC = m.match(/(?:contato|contrato|busca|buscar|pesquisa|endereco|endereço)\s+(?:do\s+)?(?:contrato\s+)?(\d{6,9})\b/) ||
             m.match(/\b(\d{6,9})\b.*(?:contato|contrato|telefone|endereco|endereço)/);
  if (mC) return { tipo: 'contrato', dado: mC[1] };

  // Aprender
  const mA = m.match(/(?:aprend[ae]|memoriza|guarda|anota|registra)\s+(?:que\s+)?(.+)/);
  if (mA) return { tipo: 'aprender', dado: mA[1].trim() };

  if (/mem[oó]ria|fatos|o que (voce|vc) sabe/.test(m)) return { tipo: 'memoria' };
  if (/categorias|resumo da mem[oó]ria|stats/.test(m))  return { tipo: 'categorias' };

  // Ativo via IA — detecta qualquer mensagem com "ativo" + número de contrato
  // Cobre: "faz ativo 123", "manda ativo com esse 123", "faz ativo (mandar msg) com 123", etc.
  const _temAtivo = /\bativ[ao]s?\b|\bmensagem\s+ativa\b/i.test(msg);
  const _numContratos = (msg.match(/\b\d{6,9}\b/g) || []);
  if (_temAtivo && _numContratos.length > 0) {
    return { tipo: 'ativo_ia', dado: _numContratos.join(',') };
  }


  // Código de baixa
  const mCod = m.match(/(?:o que [eé]|significa|codigo|c[oó]d\.?\s*)(\d{3})\b/) ||
               m.match(/\b(\d{3})\b.*(?:significa|quer dizer|[eé] o que|baixa)/);
  if (mCod) return { tipo: 'codigo', dado: mCod[1] };

  return { tipo: 'normal' };
}

// ── Salva dados completos do contrato na memória ──────────────────────────────
function _salvarContratoNaMemoria(contrato, dados) {
  const { nome, telefones = [], endereco, bairro, cidade, complemento, uf, cep, tipoAtividade, status, janela, tecnico } = dados;

  // Fato principal — nome + telefones
  const tels = telefones.join(', ');
  if (nome || tels) {
    Memoria.adicionarFato({
      texto: `Contrato ${contrato}: ${nome || 'Cliente'} — Tels: ${tels || 'N/D'}`,
      fonte: 'toa-auto', tags: ['contrato', contrato, 'telefone'], categoria: 'cliente', peso: 8,
    });
  }

  // Fato de endereço — separado para facilitar busca
  if (endereco) {
    const endCompleto = [endereco, complemento, bairro, cidade, uf, cep].filter(Boolean).join(', ');
    Memoria.adicionarFato({
      texto: `Endereço contrato ${contrato}: ${endCompleto}`,
      fonte: 'toa-auto', tags: ['contrato', contrato, 'endereco', 'endereço'], categoria: 'cliente', peso: 8,
    });
  }

  // Fato de atividade — tipo, status, janela
  if (tipoAtividade || status) {
    const partes = [`Contrato ${contrato} atividade:`];
    if (tipoAtividade) partes.push(tipoAtividade);
    if (status) partes.push(`status: ${status}`);
    if (janela) partes.push(`janela: ${janela}`);
    if (tecnico) partes.push(`técnico: ${tecnico}`);
    Memoria.adicionarFato({
      texto: partes.join(' — '),
      fonte: 'toa-auto', tags: ['contrato', contrato, 'atividade'], categoria: 'cliente', peso: 7,
    });
  }
}

// ── Resposta principal ────────────────────────────────────────────────────────
async function chamarIAComHistorico(chatId, novaMensagem, { toaBridge, isPrivado = false, sock = null } = {}) {
  const sock_ref   = sock;
  const chatIdRef  = chatId;
  const apiKey = process.env.MISTRAL_API_KEY || '';
  if (!apiKey) return null;

  const intencao = detectarIntencao(novaMensagem);

  // Renomear IA
  if (intencao.tipo === 'renomear') {
    const novoNome = intencao.dado.charAt(0).toUpperCase() + intencao.dado.slice(1);
    setNomeIA(novoNome);
    addGatilhoExtra(intencao.dado.toLowerCase());
    return `Ok! Agora pode me chamar de *${novoNome}* 😊`;
  }
  // Ativo via IA — suporta múltiplos contratos separados por vírgula
  if (intencao.tipo === 'ativo_ia') {
    const contratos = intencao.dado.split(',').map(c => c.trim()).filter(Boolean);
    if (!toaBridge || !sock_ref) return `❌ TOA não disponível.`;

    try {
      const { handleAtivo } = require('./handlers/ativo');
      const listaContratos = contratos.join(' ');
      const qtd = contratos.length;
      const mFake = {
        key: { remoteJid: chatIdRef, id: `ia_ativo_${Date.now()}`, fromMe: false },
        message: { conversation: `!ativo IA, ${listaContratos}` },
        messageTimestamp: Math.floor(Date.now() / 1000),
        pushName: 'IA',
      };
      const aviso = qtd === 1
        ? `🔍 Buscando contrato *${contratos[0]}* no TOA...`
        : `🔍 Processando *${qtd} contratos*: ${contratos.join(', ')}...`;
      await sock_ref.sendMessage(chatIdRef, { text: aviso }).catch(() => {});
      await handleAtivo({
        sock:        sock_ref,
        chatId:      chatIdRef,
        m:           mFake,
        msgTextoRaw: `!ativo IA, ${listaContratos}`,
        toaBridge,
      });
    } catch (e) {
      console.error('[IA-ATIVO] erro ao delegar handleAtivo:', e.message);
      return `❌ Erro ao processar ativos: ${e.message}`;
    }
    return null; // handleAtivo já enviou tudo
  }


  // Busca contrato no TOA
  if (intencao.tipo === 'contrato' && toaBridge) {
    const contrato = intencao.dado;

    // Verifica primeiro na memória — pode já ter sido consultado antes
    const fatosMemoria = Memoria.buscarFatos(`contrato ${contrato}`, 5);
    const temEndereco  = fatosMemoria.some(f => f.toLowerCase().includes('endereço') || f.toLowerCase().includes('endereco'));
    const temTelefone  = fatosMemoria.some(f => f.toLowerCase().includes('tel'));

    toaBridge.queueLookup(contrato);
    const Utils   = require('./utils');
    const deadline = Date.now() + 35000;
    let achado = null;
    while (Date.now() < deadline) {
      const f = toaBridge.findByContract(contrato);
      if (f && f.telefones && f.telefones.length > 0) { achado = f; break; }
      await Utils.sleep(2000);
    }

    if (!achado) {
      // Se não achou no TOA mas tem na memória, usa a memória
      if (temTelefone) {
        return `Contrato *${contrato}* não está no TOA agora.\n\n📋 *Da memória:*\n` + fatosMemoria.join('\n');
      }
      return `Contrato ${contrato} não encontrado no TOA.`;
    }

    const nome = (achado.nome || 'Cliente').trim();
    const tels = achado.telefones.map((t, i) => `Tel ${i+1}: ${t}`).join('\n');

    // Salva TODOS os dados disponíveis na memória
    _salvarContratoNaMemoria(contrato, {
      nome,
      telefones: achado.telefones,
      endereco:      achado.endereco     || achado.address || '',
      bairro:        achado.bairro       || achado.district || '',
      cidade:        achado.cidade       || achado.city || '',
      complemento:   achado.complemento  || '',
      uf:            achado.uf           || achado.state || '',
      cep:           achado.cep          || '',
      tipoAtividade: achado.tipoAtividade || achado.activityType || '',
      status:        achado.status       || '',
      janela:        achado.janela       || '',
      tecnico:       achado.tecnico      || '',
    });

    // Monta resposta
    let resposta = `Contrato *${contrato}*\nCliente: *${nome}*\n${tels}`;
    if (achado.endereco || achado.address) {
      const end = achado.endereco || achado.address;
      const comp = achado.complemento ? ` ${achado.complemento}` : '';
      const bairro = achado.bairro || achado.district || '';
      resposta += `\n📍 *End:* ${end}${comp}${bairro ? ` — ${bairro}` : ''}`;
    }
    if (achado.janela) resposta += `\n🕐 *Janela:* ${achado.janela}`;
    if (achado.tecnico) resposta += `\n👷 *Técnico:* ${achado.tecnico}`;

    return resposta;
  }

  // Aprende fato manual
  if (intencao.tipo === 'aprender') {
    const ok = Memoria.adicionarFato({ texto: intencao.dado, fonte: chatId, tags: ['manual'], categoria: 'aprendido', peso: 7 });
    return ok ? `Anotado! ✅` : `Já sabia disso.`;
  }

  // Ver memória
  if (intencao.tipo === 'memoria') {
    const fatos = Memoria.listarFatos(15);
    if (!fatos.length) return `Memória vazia. Me ensine com "aprende que..."`;
    return `Sei *${Memoria.totalFatos()}* fatos:\n\n` + fatos.map((f, i) => `${i+1}. ${f.texto}`).join('\n');
  }

  // Ver categorias
  if (intencao.tipo === 'categorias') {
    const cats  = Memoria.listarPorCategoria();
    const total = Memoria.totalFatos();
    let txt = `📊 *Memória: ${total} fatos*\n\n`;
    for (const [cat, qtd] of Object.entries(cats)) {
      const icone = { codigo_baixa:'🔢', equipamento:'📡', processo:'⚙️', tecnico:'🔧', sistema:'💻', aprendido:'🧠', cliente:'👤' }[cat] || '📌';
      txt += `${icone} ${cat}: ${qtd}\n`;
    }
    return txt.trim();
  }

  // Consulta direta de código
  if (intencao.tipo === 'codigo') {
    const resultados = Memoria.buscarCodigo(intencao.dado);
    if (resultados.length) return resultados[0];
  }

  // Conversa normal com contexto de memória
  if (!historicoIA.has(chatId)) historicoIA.set(chatId, { msgs: [] });
  const hist = historicoIA.get(chatId);
  hist.msgs.push({ role: 'user', content: novaMensagem });
  const limiteHist = isPrivado ? 80 : 60;
  if (hist.msgs.length > limiteHist) hist.msgs = hist.msgs.slice(-limiteHist);

  // Busca fatos relevantes — inclui dados de contratos consultados antes
  const fatos  = Memoria.buscarFatos(novaMensagem, 10);
  let system   = _getSystemBase(isPrivado);
  if (isPrivado) {
    // Privado: APENAS se tiver conversa ativa de retirada
    const convAtiva = getConversaCliente(chatId);
    if (convAtiva && !convAtiva.encerrada) {
      return await responderClienteAtivo(chatId, novaMensagem).then(r => r?.resposta || null);
    }
    // Sem conversa ativa no privado → silêncio total
    // A IA só fala com cliente quando foi disparada via !ativo ou "ia faz ativo"
    return null;
  }
  if (fatos.length) system += '\n\n=== MEMÓRIA RELEVANTE ===\n' + fatos.map(f => `• ${f}`).join('\n');

  const maxTokens = isPrivado ? 800 : 500;
  const res = await _chamarOR(system, hist.msgs, maxTokens);

  if (res && res.texto) {
    hist.msgs.push({ role: 'assistant', content: res.texto });
    salvarHistoricoIA();
    if (hist.msgs.length % 6 === 0) {
      _extrairEAprender(chatId, hist.msgs.slice(-6)).catch(() => {});
    }
  }
  return res ? res.texto : null;
}

// ── Auto-aprendizado ──────────────────────────────────────────────────────────
async function _extrairEAprender(chatId, msgs) {
  if (!process.env.MISTRAL_API_KEY) return;
  const conteudo = msgs.map(m => `${m.role === 'user' ? 'Técnico' : 'IA'}: ${m.content}`).join('\n');
  const resultado = await _chamarORTexto(SYSTEM_EXTRATOR, [{ role: 'user', content: conteudo }], 200);
  if (!resultado || resultado.trim() === 'NENHUM') return;
  const regex = /FATO\[(\w+)\]:\s*(.+)/g;
  let match;
  while ((match = regex.exec(resultado)) !== null) {
    const cats     = ['codigo_baixa', 'equipamento', 'processo', 'tecnico', 'sistema', 'cliente'];
    const catFinal = cats.includes(match[1].trim()) ? match[1].trim() : 'aprendido';
    const fato     = match[2].trim();
    if (fato.length > 10 && fato.length < 200) {
      const ok = Memoria.adicionarFato({ texto: fato, fonte: `auto:${chatId}`, tags: ['auto'], categoria: catFinal, peso: 6 });
      if (ok) console.log(`[IA] auto-aprendeu (${catFinal}): "${fato.slice(0, 60)}"`);
    }
  }
}

// ── Conversa com cliente (!ativo) ─────────────────────────────────────────────
const historicoClientes = new Map();
const CLIENTE_TTL_MS    = 6 * 60 * 60 * 1000;
const MAX_MSGS_CLIENTE  = 6;

// Detecta resposta positiva rápida
function _isPositivo(msg) {
  const m = msg.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /\b(sim|pode|claro|ok|certo|combinado|beleza|tranquilo|to em casa|tô em casa|to aqui|tô aqui|pode vir|pode ser|vou estar|estarei|consigo|disponivel|disponível|tudo bem|ta bom|tá bom|bom dia|boa tarde|boa noite|oi|ola|olá|pode)\b/.test(m);
}

// Detecta endereço errado
function _isEnderecoErrado(msg) {
  const m = msg.toLowerCase();
  return /endere[cç]o.*(errado|incorreto|nao|não|mudou|diferente|antigo|outro)|nao.*(esse|este).*(endere|end)|mudei|me mudei|mudamos/.test(m);
}

function iniciarConversaCliente({ chatCliente, nomeCliente, contrato, tecnico, chatOrigemControlador, endereco, janela, telefones }) {
  historicoClientes.set(chatCliente, {
    msgs:     [],
    nomeCliente, contrato, tecnico,
    chatOrigemControlador: chatOrigemControlador || null,
    endereco:  endereco  || '',   // endereço do TOA
    janela:    janela    || '',   // janela do TOA
    telefones: telefones || [chatCliente.replace('@s.whatsapp.net', '').replace(/^55/, '')],
    lastAt:    Date.now(),
    fase:      'aguardando_resposta',
    agendamento: null,
    msgCount:  0,
    encerrada: false,
  });
  console.log(`[IA-ATIVO] conversa iniciada: ${chatCliente} (${nomeCliente}, contrato ${contrato})`);
}

function getConversaCliente(chatCliente) {
  const conv = historicoClientes.get(chatCliente);
  if (!conv) return null;
  if (Date.now() - conv.lastAt > CLIENTE_TTL_MS) { historicoClientes.delete(chatCliente); return null; }
  return conv;
}

function encerrarConversaCliente(chatCliente) { historicoClientes.delete(chatCliente); }

function _extrairAgendamento(resposta) {
  const match = resposta.match(/\[AGENDAMENTO_CONFIRMADO\]([\s\S]*?)\[\/AGENDAMENTO_CONFIRMADO\]/);
  if (!match) return null;
  const b      = match[1];
  const janela = (b.match(/janela:\s*(.+)/) || [])[1]?.trim();
  const end    = (b.match(/endereco:\s*(.+)/) || [])[1]?.trim();
  return { janela: janela || '', endereco: end || '' };
}

function formatarResumoAgendamento(conv, ag) {
  const tels   = (conv.telefones || []).join(' / ') || 'N/D';
  const end    = ag.endereco || conv.endereco || 'N/D';
  const agenda = ag.janela   || conv.janela   || 'N/D';
  return `⭕ *CONFIRMADA* ⭕\n` +
    `CONTRATO: ${conv.contrato}\n` +
    `NOME: ${conv.nomeCliente}\n` +
    `END: ${end}\n` +
    `AGENDA: ${agenda}\n` +
    `TEL: ${tels}`;
}

async function responderClienteAtivo(chatCliente, msgCliente) {
  const conv = getConversaCliente(chatCliente);
  if (!conv) return { resposta: null, agendamentoConfirmado: false };

  // Conversa encerrada — silenciar
  if (conv.encerrada) return { resposta: null, agendamentoConfirmado: false };

  const ml = msgCliente.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Número errado / não é cliente
  if (/nao sou cliente|nao tenho contrato|engano|numero errado|quem e voce|nao reconheco/.test(ml)) {
    conv.encerrada = true;
    return { resposta: 'Desculpe o incomodo! Engano nosso, pode desconsiderar 😊', agendamentoConfirmado: false };
  }

  // Limite atingido
  if (conv.msgCount >= MAX_MSGS_CLIENTE) {
    conv.encerrada = true;
    return { resposta: null, agendamentoConfirmado: false };
  }

  conv.lastAt = Date.now();
  conv.msgs.push({ role: 'user', content: msgCliente });

  // ── AGUARDANDO ENDEREÇO NOVO ──────────────────────────────────────────────
  if (conv.fase === 'aguardando_endereco') {
    const novoEnd = msgCliente.trim();
    if (novoEnd.length > 5) {
      return _confirmarAgendamento(conv, novoEnd);
    }
    conv.encerrada = true;
    return { resposta: null, agendamentoConfirmado: false };
  }

  // ── CONFIRMAÇÃO RÁPIDA — cliente positivo ──────────────────────────────────
  if (_isPositivo(msgCliente)) {
    if (_isEnderecoErrado(msgCliente)) {
      conv.fase = 'aguardando_endereco';
      conv.msgCount++;
      const r = 'Sem problema! Qual o endereço correto? 😊';
      conv.msgs.push({ role: 'assistant', content: r });
      return { resposta: r, agendamentoConfirmado: false };
    }
    return _confirmarAgendamento(conv, conv.endereco);
  }

  // ── NEGATIVO — propõe reagendamento UMA VEZ ────────────────────────────────
  const isNegativo = /\b(nao|não|n consegui|n posso|ocupad|trabalh|viagem|fora|indisponiv|nesse horario|neste horario)\b/i.test(ml);
  if (isNegativo || conv.fase === 'negociando_horario') {
    conv.encerrada = true; // só responde uma vez
    // Sugere datas sem usar códigos
    const hoje2 = new Date();
    const amanha = new Date(hoje2); amanha.setDate(amanha.getDate() + 1);
    const depoisAmanha = new Date(hoje2); depoisAmanha.setDate(depoisAmanha.getDate() + 2);
    const fmt = (d) => d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });
    const r = `Tudo bem! Podemos tentar ${fmt(amanha)} ou ${fmt(depoisAmanha)}. Algum desses funciona pra você?`;
    conv.msgs.push({ role: 'assistant', content: r });
    return { resposta: r, agendamentoConfirmado: false };
  }

  // ── RESPOSTA ÚNICA COM IA (ambíguo/dúvida) ─────────────────────────────────
  if (!process.env.MISTRAL_API_KEY) return { resposta: null, agendamentoConfirmado: false };
  conv.encerrada = true; // após essa resposta, encerra — máximo 1 interação extra

  const hoje   = new Date().toLocaleDateString('pt-BR');
  const system = `${SYSTEM_ATIVO_CLIENTE}

Cliente: ${conv.nomeCliente} | Contrato: ${conv.contrato} | Técnico: ${conv.tecnico}
Hoje: ${hoje} | Janela: ${conv.janela || 'não informada'} | Endereço: ${conv.endereco || 'não informado'}

RESPONDA EM NO MÁXIMO 2 LINHAS. Não peça CPF, contrato ou dados pessoais.
Se positivo → use [AGENDAMENTO_CONFIRMADO]. Se negativo → sugira amanhã ou depois de amanhã.`;

  if (conv.msgs.length > 20) conv.msgs = conv.msgs.slice(-20);
  const texto = await _chamarORTexto(system, conv.msgs, 200);
  if (!texto) return { resposta: null, agendamentoConfirmado: false };

  const limpo = texto.replace(/\[AGENDAMENTO_CONFIRMADO\][\s\S]*?\[\/AGENDAMENTO_CONFIRMADO\]/g, '').trim();
  conv.msgs.push({ role: 'assistant', content: limpo || texto });

  const ag = _extrairAgendamento(texto);
  if (ag) {
    if (!ag.endereco) ag.endereco = conv.endereco;
    if (!ag.janela)   ag.janela   = conv.janela;
    conv.agendamento = ag;
    return { resposta: limpo || texto, agendamentoConfirmado: true, agendamento: ag, resumo: formatarResumoAgendamento(conv, ag) };
  }
  return { resposta: limpo || texto, agendamentoConfirmado: false };
}

// Helper: confirma agendamento com endereço fornecido
function _confirmarAgendamento(conv, endereco) {
  const ag = { janela: conv.janela || conv.janelaToa || 'Conforme agendado', endereco: endereco || conv.endereco || 'Endereço cadastrado' };
  conv.fase = 'concluido';
  conv.encerrada = true;
  conv.agendamento = ag;
  const resumo = formatarResumoAgendamento(conv, ag);
  const respostaCliente = 'Perfeito! Tudo confirmado 😊 Até logo!';
  conv.msgs.push({ role: 'assistant', content: respostaCliente });
  return { resposta: respostaCliente, agendamentoConfirmado: true, agendamento: ag, resumo };
}

module.exports = {
  chamarIAComHistorico,
  iniciarConversaCliente,
  getConversaCliente,
  encerrarConversaCliente,
  responderClienteAtivo,
  formatarResumoAgendamento,
  getNomeIA,
  setNomeIA,
  getGatilhosExtra,
  addGatilhoExtra,
  historicoIA,
  iaConversaAtiva,
  SYSTEM_IA_BASE: _getSystemBase(),
};
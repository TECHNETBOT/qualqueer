// src/memoria.js — Memória permanente da IA com auto-aprendizado
// Arquivo: data/memoria_ia.json
// Categorias: codigo_baixa | equipamento | processo | tecnico | sistema | aprendido
const fs   = require('fs');
const path = require('path');

const MEMORIA_PATH      = path.join(__dirname, '..', 'data', 'memoria_ia.json');
const CONHECIMENTO_PATH = path.join(__dirname, '..', 'data', 'conhecimento_base.json');

const MAX_FATOS     = 1000;
const MAX_CONVERSAS = 200;

// ── Estrutura interna ─────────────────────────────────────────────────────────
function _estruturaVazia() {
  return { versao: 2, fatos: [], conversas: [], baseCarregada: false };
}

function _carregar() {
  try {
    if (fs.existsSync(MEMORIA_PATH)) {
      const mem = JSON.parse(fs.readFileSync(MEMORIA_PATH, 'utf8'));
      if (!mem.fatos) mem.fatos = [];
      if (!mem.conversas) mem.conversas = [];
      if (!mem.baseCarregada) mem.baseCarregada = false;
      return mem;
    }
  } catch (e) { console.error('[MEM] erro ao carregar:', e.message); }
  return _estruturaVazia();
}

function _salvar(mem) {
  try {
    fs.mkdirSync(path.dirname(MEMORIA_PATH), { recursive: true });
    fs.writeFileSync(MEMORIA_PATH, JSON.stringify(mem, null, 2));
  } catch (e) { console.error('[MEM] erro ao salvar:', e.message); }
}

// ── Carregamento da base de conhecimento inicial ──────────────────────────────
// Roda UMA vez: se baseCarregada=false, lê o conhecimento_base.json e injeta
function carregarBaseSeNecessario() {
  const mem = _carregar();
  if (mem.baseCarregada) return;

  try {
    if (!fs.existsSync(CONHECIMENTO_PATH)) {
      console.warn('[MEM] conhecimento_base.json não encontrado — pulando carga inicial');
      mem.baseCarregada = true;
      _salvar(mem);
      return;
    }
    const base = JSON.parse(fs.readFileSync(CONHECIMENTO_PATH, 'utf8'));
    let inseridos = 0;
    for (const fato of (base.fatos || [])) {
      const jaExiste = mem.fatos.some(f => f.texto.toLowerCase() === fato.texto.toLowerCase());
      if (!jaExiste) {
        mem.fatos.push({
          texto:     fato.texto,
          fonte:     'base',
          tags:      fato.tags || [],
          categoria: fato.categoria || 'geral',
          peso:      fato.peso || 5,
          usos:      0,
          timestamp: Date.now(),
        });
        inseridos++;
      }
    }
    mem.baseCarregada = true;
    if (mem.fatos.length > MAX_FATOS) mem.fatos = mem.fatos.slice(0, MAX_FATOS);
    _salvar(mem);
    console.log(`[MEM] base de conhecimento carregada: ${inseridos} fatos inseridos`);
  } catch (e) {
    console.error('[MEM] erro ao carregar base:', e.message);
    mem.baseCarregada = true;
    _salvar(mem);
  }
}

// ── Adiciona um fato permanente ───────────────────────────────────────────────
function adicionarFato({ texto, fonte = 'auto', tags = [], categoria = 'aprendido', peso = 5 }) {
  const mem = _carregar();

  // Evita duplicata exata
  const jaExiste = mem.fatos.some(f => f.texto.toLowerCase() === texto.toLowerCase());
  if (jaExiste) return false;

  // Evita duplicata semântica muito similar (>80% das palavras iguais)
  const palavrasNovo = _tokenizar(texto);
  const muitoSimilar = mem.fatos.some(f => {
    if (f.categoria !== categoria && categoria !== 'aprendido') return false;
    const palavrasExist = _tokenizar(f.texto);
    const intersecao = palavrasNovo.filter(p => palavrasExist.includes(p)).length;
    const similaridade = intersecao / Math.max(palavrasNovo.length, palavrasExist.length);
    return similaridade > 0.85;
  });
  if (muitoSimilar) return false;

  mem.fatos.unshift({
    texto,
    fonte,
    tags,
    categoria,
    peso,
    usos: 0,
    timestamp: Date.now(),
  });

  if (mem.fatos.length > MAX_FATOS) {
    // Remove fatos mais antigos com menos usos (mantém os relevantes)
    mem.fatos = mem.fatos
      .sort((a, b) => (b.usos * b.peso) - (a.usos * a.peso) || b.timestamp - a.timestamp)
      .slice(0, MAX_FATOS);
  }

  _salvar(mem);
  console.log(`[MEM] fato adicionado (${categoria}): "${texto.slice(0, 60)}"`);
  return true;
}

// ── Busca inteligente por relevância ─────────────────────────────────────────
// Considera: palavras em comum, tags, categoria, peso e frequência de uso
function buscarFatos(pergunta, limite = 8, categoriaFiltro = null) {
  const mem = _carregar();
  if (!mem.fatos.length) return [];

  const palavras = _tokenizar(pergunta);
  if (!palavras.length) return [];

  // Detecta se a pergunta é sobre código de baixa
  const perguntaCodigo = /c[oó]d(igo)?\.?\s*\d{2,3}|\bque\s+([eé]|significa|quer dizer)\b|\b\d{3}\b/.test(pergunta.toLowerCase());

  const scored = mem.fatos
    .filter(f => !categoriaFiltro || f.categoria === categoriaFiltro)
    .map(f => {
      const textoNorm = _normalizar(f.texto);
      const tagsNorm  = (f.tags || []).map(_normalizar);

      // Pontuação por palavras no texto
      let score = palavras.reduce((acc, p) => acc + (textoNorm.includes(p) ? 1 : 0), 0);

      // Bônus por match em tags
      score += palavras.reduce((acc, p) => acc + (tagsNorm.some(t => t.includes(p)) ? 0.5 : 0), 0);

      // Bônus se categoria é codigo_baixa e a pergunta parece ser sobre código
      if (perguntaCodigo && f.categoria === 'codigo_baixa') score += 1;

      // Bônus por peso do fato (conhecimento base tem peso alto)
      score += (f.peso || 5) * 0.1;

      // Bônus por frequência de uso (fatos mais consultados sobem)
      score += (f.usos || 0) * 0.05;

      return { ...f, score };
    })
    .filter(f => f.score > 0)
    .sort((a, b) => b.score - a.score);

  // Incrementa contador de uso dos fatos retornados
  const resultado = scored.slice(0, limite);
  if (resultado.length) {
    const ids = resultado.map(f => f.texto);
    const memAtual = _carregar();
    let alterou = false;
    for (const fato of memAtual.fatos) {
      if (ids.includes(fato.texto)) { fato.usos = (fato.usos || 0) + 1; alterou = true; }
    }
    if (alterou) _salvar(memAtual);
  }

  return resultado.map(f => f.texto);
}

// ── Busca específica por código de baixa ─────────────────────────────────────
function buscarCodigo(numero) {
  const mem = _carregar();
  const n   = String(numero).trim();
  return mem.fatos
    .filter(f => f.categoria === 'codigo_baixa' && (f.tags || []).includes(n))
    .map(f => f.texto);
}

// ── Resumo de conversa ────────────────────────────────────────────────────────
function adicionarConversa({ chatId, resumo, participante }) {
  const mem = _carregar();
  mem.conversas.unshift({ chatId, resumo, participante, timestamp: Date.now() });
  if (mem.conversas.length > MAX_CONVERSAS) mem.conversas = mem.conversas.slice(0, MAX_CONVERSAS);
  _salvar(mem);
}

function buscarConversas(chatId, limite = 3) {
  const mem = _carregar();
  return mem.conversas
    .filter(c => c.chatId === chatId)
    .slice(0, limite)
    .map(c => c.resumo);
}

// ── Listagem ──────────────────────────────────────────────────────────────────
function listarFatos(limite = 20, categoria = null) {
  const mem = _carregar();
  let fatos = mem.fatos;
  if (categoria) fatos = fatos.filter(f => f.categoria === categoria);
  return fatos.slice(0, limite);
}

function listarPorCategoria() {
  const mem = _carregar();
  const grupos = {};
  for (const f of mem.fatos) {
    const cat = f.categoria || 'geral';
    if (!grupos[cat]) grupos[cat] = 0;
    grupos[cat]++;
  }
  return grupos;
}

function totalFatos() { return _carregar().fatos.length; }
function totalConversas() { return _carregar().conversas.length; }

// ── Helpers internos ──────────────────────────────────────────────────────────
function _normalizar(str) {
  return String(str).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function _tokenizar(str) {
  return _normalizar(str)
    .split(/\s+/)
    .filter(p => p.length > 2 && !/^(que|nao|sim|uma|uns|com|por|para|isso|este|esta|esse|essa|ser|ter|tem|foi|era|aos|das|dos|nas|nos|pra)$/.test(p));
}

// Roda ao importar o módulo
carregarBaseSeNecessario();

module.exports = {
  adicionarFato,
  adicionarConversa,
  buscarFatos,
  buscarCodigo,
  buscarConversas,
  listarFatos,
  listarPorCategoria,
  totalFatos,
  totalConversas,
  carregarBaseSeNecessario,
};
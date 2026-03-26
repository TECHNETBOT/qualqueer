// src/knowledgeLoader.js
// Monitora a pasta data/knowledge/ e carrega automaticamente na memória da IA
// Aceita: .xlsx, .json, .txt, .pdf (txt/json nativos; xlsx via openpyxl via python)
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Memoria = require('./memoria');

const KNOWLEDGE_DIR = path.join(__dirname, '..', 'data', 'knowledge');
const LOADED_LOG    = path.join(__dirname, '..', 'data', 'knowledge_loaded.json');

function _carregarLog() {
  try { return JSON.parse(fs.readFileSync(LOADED_LOG, 'utf8')); } catch { return {}; }
}
function _salvarLog(log) {
  try { fs.writeFileSync(LOADED_LOG, JSON.stringify(log, null, 2)); } catch {}
}

// Processa arquivo .txt — cada linha vira um fato
function _processarTxt(filePath) {
  const texto = fs.readFileSync(filePath, 'utf8');
  const linhas = texto.split('\n').map(l => l.trim()).filter(l => l.length > 10);
  const fatos = [];
  for (const linha of linhas) {
    fatos.push({ texto: linha, categoria: 'aprendido', peso: 8, tags: ['knowledge', path.basename(filePath)], fonte: path.basename(filePath) });
  }
  return fatos;
}

// Processa arquivo .json — espera array de fatos ou objeto com campo "fatos"
function _processarJson(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const arr = Array.isArray(raw) ? raw : (raw.fatos || []);
  return arr.map(f => ({
    texto:      f.texto || f.text || String(f),
    categoria:  f.categoria || f.category || 'aprendido',
    peso:       f.peso || f.weight || 8,
    tags:       f.tags || ['knowledge'],
    fonte:      f.fonte || path.basename(filePath),
  })).filter(f => f.texto && f.texto.length > 5);
}

// Processa arquivo .xlsx via Python (openpyxl)
function _processarXlsx(filePath) {
  const script = `
import openpyxl, json, sys
wb = openpyxl.load_workbook('${filePath.replace(/\\/g, '\\\\')}')
ws = wb.active
rows = []
for row in ws.iter_rows(values_only=True):
    vals = [str(c).strip() for c in row if c is not None and str(c).strip()]
    if vals:
        rows.append(vals)
if not rows:
    print('[]')
    sys.exit(0)
# Cabeçalho na primeira linha
headers = rows[0] if rows else []
fatos = []
for row in rows[1:]:
    # Junta colunas como fato legível
    partes = [f"{headers[i] if i < len(headers) else 'col'+str(i)}: {val}" for i, val in enumerate(row) if val and val != 'None']
    if partes:
        fatos.append(' | '.join(partes))
print(json.dumps(fatos, ensure_ascii=False))
`;
  try {
    const result = execSync(`python3 -c "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { timeout: 30000 }).toString().trim();
    const linhas = JSON.parse(result);
    return linhas.map(l => ({
      texto:     l.slice(0, 200),
      categoria: 'aprendido',
      peso:      8,
      tags:      ['knowledge', path.basename(filePath)],
      fonte:     path.basename(filePath),
    })).filter(f => f.texto.length > 10);
  } catch (e) {
    console.error(`[KNOWLEDGE] erro ao processar xlsx ${filePath}:`, e.message);
    return [];
  }
}

// Carrega um arquivo e adiciona na memória
function carregarArquivo(filePath) {
  const ext  = path.extname(filePath).toLowerCase();
  const nome = path.basename(filePath);
  let fatos  = [];

  try {
    if (ext === '.txt')        fatos = _processarTxt(filePath);
    else if (ext === '.json')  fatos = _processarJson(filePath);
    else if (ext === '.xlsx')  fatos = _processarXlsx(filePath);
    else {
      console.log(`[KNOWLEDGE] formato não suportado: ${ext}`);
      return 0;
    }
  } catch (e) {
    console.error(`[KNOWLEDGE] erro ao ler ${nome}:`, e.message);
    return 0;
  }

  let adicionados = 0;
  for (const fato of fatos) {
    const ok = Memoria.adicionarFato(fato);
    if (ok) adicionados++;
  }
  console.log(`[KNOWLEDGE] ${nome} → ${adicionados}/${fatos.length} fatos carregados`);
  return adicionados;
}

// Varre a pasta knowledge/ e carrega arquivos novos ou modificados
function carregarKnowledgeDir() {
  if (!fs.existsSync(KNOWLEDGE_DIR)) {
    fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
    console.log(`[KNOWLEDGE] pasta criada: ${KNOWLEDGE_DIR}`);
  }

  const log     = _carregarLog();
  const arquivos = fs.readdirSync(KNOWLEDGE_DIR).filter(f => /\.(txt|json|xlsx)$/.test(f));
  let total = 0;

  for (const nome of arquivos) {
    const filePath = path.join(KNOWLEDGE_DIR, nome);
    const stat     = fs.statSync(filePath);
    const mtime    = stat.mtimeMs;

    // Pula se já foi carregado com o mesmo mtime
    if (log[nome] && log[nome].mtime === mtime) continue;

    const qtd = carregarArquivo(filePath);
    log[nome] = { mtime, qtd, loadedAt: new Date().toISOString() };
    total += qtd;
  }

  _salvarLog(log);
  if (total > 0) console.log(`[KNOWLEDGE] total carregado nessa rodada: ${total} fatos`);
  return total;
}

// Monitora a pasta a cada 5 minutos por arquivos novos
function iniciarMonitor(intervaloMs = 5 * 60 * 1000) {
  carregarKnowledgeDir(); // carrega na inicialização
  setInterval(carregarKnowledgeDir, intervaloMs);
  console.log(`[KNOWLEDGE] monitorando ${KNOWLEDGE_DIR} (a cada ${intervaloMs / 60000} min)`);
}

module.exports = { iniciarMonitor, carregarKnowledgeDir, carregarArquivo };
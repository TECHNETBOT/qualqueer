// src/confirmeBridge.js — Bridge HTTP para Confirme Online (porta 8788)
// Funciona igual ao toaBridge mas para busca por nome no Confirme Online

const http = require('http');
const fs   = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '..', 'data', 'confirme_cache.json');

function createConfirmeBridge({ port = 8788, host = '127.0.0.1', token = '', dataDir } = {}) {

  // ── Cache em memória + disco ─────────────────────────────────────────────
  let cache = {}; // nome_normalizado -> { nome, telefones, temWhatsApp, timestamp }
  let pendingLookups = []; // fila de nomes aguardando pesquisa pela extensão

  function _salvarCache() {
    try { fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2)); } catch (e) {}
  }

  function _carregarCache() {
    try {
      if (fs.existsSync(CACHE_PATH)) {
        cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
        console.log(`[CONFIRME-BRIDGE] cache carregado: ${Object.keys(cache).length} nomes`);
      }
    } catch (e) { cache = {}; }
  }

  function _normNome(nome) {
    return String(nome).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  }

  // ── API pública ──────────────────────────────────────────────────────────

  function syncResultado({ nome, telefones, temWhatsApp }) {
    const key = _normNome(nome);
    cache[key] = { nome, telefones, temWhatsApp: temWhatsApp || [], timestamp: Date.now() };
    _salvarCache();
    console.log(`[CONFIRME-BRIDGE] sync: ${nome} — ${telefones.length} telefone(s)`);
  }

  function findByNome(nome) {
    const key = _normNome(nome);
    // Busca exata primeiro
    if (cache[key]) return cache[key];
    // Busca parcial (primeiros dois nomes)
    const partes = key.split(' ').slice(0, 2).join(' ');
    const match = Object.keys(cache).find(k => k.includes(partes));
    return match ? cache[match] : null;
  }

  function queueLookup(nome) {
    if (!pendingLookups.includes(nome)) {
      pendingLookups.push(nome);
      console.log(`[CONFIRME-BRIDGE] lookup enfileirado: "${nome}" (fila: ${pendingLookups.length})`);
      return true;
    }
    return false;
  }

  function stats() {
    return { nomes: Object.keys(cache).length, pendingLookups: pendingLookups.length, port };
  }

  // ── Servidor HTTP ────────────────────────────────────────────────────────
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-confirme-token');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // Token opcional
    if (token && req.headers['x-confirme-token'] !== token) {
      res.writeHead(401); res.end(JSON.stringify({ error: 'unauthorized' })); return;
    }

    const url = req.url.split('?')[0];

    // POST /confirme/sync — extensão envia resultado de busca
    if (req.method === 'POST' && url === '/confirme/sync') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const { nome, telefones, temWhatsApp } = JSON.parse(body);
          if (nome && Array.isArray(telefones)) {
            syncResultado({ nome, telefones, temWhatsApp: temWhatsApp || [] });
            res.writeHead(200); res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(400); res.end(JSON.stringify({ error: 'invalid' }));
          }
        } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      });
      return;
    }

    // GET /confirme/nome/:nome — bot consulta por nome
    if (req.method === 'GET' && url.startsWith('/confirme/nome/')) {
      const nome = decodeURIComponent(url.slice('/confirme/nome/'.length));
      const achado = findByNome(nome);
      if (achado) {
        res.writeHead(200); res.end(JSON.stringify({ ok: true, ...achado }));
      } else {
        res.writeHead(404); res.end(JSON.stringify({ ok: false }));
      }
      return;
    }

    // POST /confirme/queue-lookup — bot pede pra extensão pesquisar um nome
    if (req.method === 'POST' && url === '/confirme/queue-lookup') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const { nome } = JSON.parse(body);
          if (nome) {
            queueLookup(nome);
            res.writeHead(200); res.end(JSON.stringify({ ok: true, queued: true }));
          } else {
            res.writeHead(400); res.end(JSON.stringify({ error: 'nome obrigatório' }));
          }
        } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      });
      return;
    }

    // GET /confirme/pending-lookup — extensão faz polling para ver se há nome pra pesquisar
    if (req.method === 'GET' && url === '/confirme/pending-lookup') {
      if (pendingLookups.length > 0) {
        const nome = pendingLookups[0];
        res.writeHead(200); res.end(JSON.stringify({ ok: true, nome }));
      } else {
        res.writeHead(200); res.end(JSON.stringify({ ok: false }));
      }
      return;
    }

    // POST /confirme/ack-lookup — extensão confirma que processou
    if (req.method === 'POST' && url === '/confirme/ack-lookup') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const { nome } = JSON.parse(body);
          pendingLookups = pendingLookups.filter(n => n !== nome);
          console.log(`[CONFIRME-BRIDGE] ack: "${nome}" (fila restante: ${pendingLookups.length})`);
          res.writeHead(200); res.end(JSON.stringify({ ok: true }));
        } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      });
      return;
    }

    // GET /confirme/health
    if (url === '/confirme/health') {
      res.writeHead(200); res.end(JSON.stringify({ ok: true, ...stats() })); return;
    }

    res.writeHead(404); res.end(JSON.stringify({ error: 'not found' }));
  });

  function start() {
    _carregarCache();
    server.listen(port, host, () => {
      console.log(`[CONFIRME-BRIDGE] rodando em http://${host}:${port}`);
    });
    server.on('error', e => console.error('[CONFIRME-BRIDGE] erro:', e.message));
  }

  return { start, syncResultado, findByNome, queueLookup, stats };
}

module.exports = { createConfirmeBridge };
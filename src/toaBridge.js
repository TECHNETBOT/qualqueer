const fs = require('fs');
const path = require('path');
const http = require('http');

function normalizeContract(value) {
  const digits = String(value || '').replace(/\D+/g, '');
  return /^\d{6,8}$/.test(digits) ? digits : null;
}

function normalizePhones(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[\/|,;]+/g);
  const normalized = raw
    .map((item) => String(item || '').replace(/\D+/g, ''))
    .filter((item) => item.length >= 10);
  return Array.from(new Set(normalized));
}

function createToaBridge({ dataDir, port = 8787, host = '0.0.0.0', token = '' } = {}) {
  const filePath = path.join(dataDir, 'toa_contacts_cache.json');
  const cache = new Map();

  // ── Fila de pending lookups (bot pede → extensão pesquisa) ──────────────────
  const pendingLookups = [];      // FIFO de contratos aguardando pesquisa
  const ackedLookups = new Set(); // contratos já processados

  function queueLookup(contrato) {
    const c = normalizeContract(contrato);
    if (!c) return false;
    if (ackedLookups.has(c)) {
      // Se já estava no cache quando foi acked, não re-enfileira
      if (cache.has(c)) return false;
      // Mas se ainda não tem no cache, permite nova tentativa limpando o ack
      ackedLookups.delete(c);
    }
    if (pendingLookups.includes(c)) return false;
    pendingLookups.push(c);
    console.log(`🔍 [TOA-BRIDGE] lookup enfileirado: ${c} (fila: ${pendingLookups.length})`);
    return true;
  }

  function peekNextLookup() {
    return pendingLookups[0] || null;
  }

  function ackLookup(contrato) {
    const c = normalizeContract(contrato);
    if (!c) return;
    const idx = pendingLookups.indexOf(c);
    if (idx !== -1) pendingLookups.splice(idx, 1);
    ackedLookups.add(c);
    // Evita crescimento infinito
    if (ackedLookups.size > 500) {
      const first = ackedLookups.values().next().value;
      ackedLookups.delete(first);
    }
    console.log(`✅ [TOA-BRIDGE] lookup acked: ${c} (fila restante: ${pendingLookups.length})`);
  }
  // ────────────────────────────────────────────────────────────────────────────

  let server = null;

  function load() {
    try {
      if (!fs.existsSync(filePath)) return;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(data?.entries)) return;
      for (const item of data.entries) {
        const contrato = normalizeContract(item.contrato);
        const telefones = normalizePhones(item.telefones);
        if (!contrato || !telefones.length) continue;
        cache.set(contrato, {
          contrato,
          telefones,
          aid: item.aid ? String(item.aid) : '',
          tipoAtividade: item.tipoAtividade || '',
          nome: item.nome ? String(item.nome) : '',
          tecnico: item.tecnico ? String(item.tecnico) : '',
          source: item.source ? String(item.source) : 'toa-extension',
          updatedAt: item.updatedAt || new Date().toISOString()
        });
      }
      console.log(`📂 [TOA-BRIDGE] cache carregado: ${cache.size} contratos`);
    } catch (error) {
      console.error('❌ Erro ao carregar cache TOA:', error.message);
    }
  }

  function persist() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const entries = [...cache.values()].sort((a, b) => Number(a.contrato) - Number(b.contrato));
      fs.writeFileSync(filePath, JSON.stringify({ updatedAt: new Date().toISOString(), entries }, null, 2));
    } catch (error) {
      console.error('❌ Erro ao persistir cache TOA:', error.message);
    }
  }

  function upsertMany(entries = [], source = 'toa-extension') {
    let inserted = 0;

    for (const item of entries) {
      const contrato = normalizeContract(item?.contrato);
      const telefones = normalizePhones(item?.telefones ?? item?.telefone ?? item?.phones);
      if (!contrato || !telefones.length) continue;

      const existing = cache.get(contrato);
      const mergedPhones = Array.from(new Set([...(existing?.telefones || []), ...telefones]));

      cache.set(contrato, {
        contrato,
        telefones: mergedPhones,
        aid: item?.aid ? String(item.aid) : (existing?.aid || ''),
        tipoAtividade: item?.tipoAtividade || existing?.tipoAtividade || '',
        nome: item?.nome ? String(item.nome) : (existing?.nome || ''),
        tecnico: item?.tecnico ? String(item.tecnico) : (existing?.tecnico || ''),
        janela: item?.janela ? String(item.janela) : (existing?.janela || ''),
        source,
        updatedAt: new Date().toISOString()
      });

      // Se esse contrato estava na fila de pending lookup, podemos ack automaticamente
      if (pendingLookups.includes(contrato)) {
        ackLookup(contrato);
        console.log(`🔗 [TOA-BRIDGE] contrato ${contrato} sincronizado e removido da fila de lookup`);
      }

      inserted += 1;
    }

    if (inserted > 0) persist();
    return inserted;
  }

  function findByContract(contract) {
    const contrato = normalizeContract(contract);
    if (!contrato) return null;
    return cache.get(contrato) || null;
  }

  function stats() {
    let phones = 0;
    for (const item of cache.values()) phones += item.telefones.length;
    return {
      contracts: cache.size,
      phones,
      port,
      pendingLookups: pendingLookups.length,
      pendingQueue: [...pendingLookups],
    };
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 2 * 1024 * 1024) {
          reject(new Error('Payload muito grande'));
          req.destroy();
        }
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  function writeJson(res, status, payload) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, x-toa-token',
      'access-control-allow-methods': 'GET,POST,OPTIONS'
    });
    res.end(JSON.stringify(payload));
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'OPTIONS') {
      writeJson(res, 204, {});
      return;
    }

    // ── Auth ─────────────────────────────────────────────────────────────────
    if (token) {
      const receivedToken = req.headers['x-toa-token'] || url.searchParams.get('token');
      if (receivedToken !== token) {
        writeJson(res, 401, { ok: false, error: 'Token inválido' });
        return;
      }
    }

    // ── GET /toa/health ───────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/toa/health') {
      writeJson(res, 200, { ok: true, stats: stats() });
      return;
    }

    // ── GET /toa/contract/:id ─────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname.startsWith('/toa/contract/')) {
      const contract = decodeURIComponent(url.pathname.split('/').pop());
      const found = findByContract(contract);
      writeJson(res, 200, { ok: true, found });
      return;
    }

    // ── POST /toa/sync ────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/toa/sync') {
      try {
        const bodyText = await readBody(req);
        const json = bodyText ? JSON.parse(bodyText) : {};
        const inserted = upsertMany(Array.isArray(json.entries) ? json.entries : [], json.source || 'toa-extension');
        writeJson(res, 200, { ok: true, inserted, stats: stats() });
      } catch (error) {
        writeJson(res, 400, { ok: false, error: error.message });
      }
      return;
    }

    // ── POST /toa/queue-lookup ────────────────────────────────────────────────
    // Chamado pelo bot quando recebe "contatos XXXXXX" e o cache está vazio.
    // Enfileira o contrato para a extensão pesquisar automaticamente.
    if (req.method === 'POST' && url.pathname === '/toa/queue-lookup') {
      try {
        const bodyText = await readBody(req);
        const json = bodyText ? JSON.parse(bodyText) : {};
        const contrato = json.contrato || url.searchParams.get('contrato');
        const queued = queueLookup(contrato);
        writeJson(res, 200, { ok: true, queued, contrato: normalizeContract(contrato), stats: stats() });
      } catch (error) {
        writeJson(res, 400, { ok: false, error: error.message });
      }
      return;
    }

    // ── GET /toa/pending-lookup ───────────────────────────────────────────────
    // Chamado pela extensão a cada 3s para saber se há contrato para pesquisar.
    if (req.method === 'GET' && url.pathname === '/toa/pending-lookup') {
      const contrato = peekNextLookup();
      writeJson(res, 200, { ok: true, contrato });
      return;
    }

    // ── POST /toa/ack-lookup ──────────────────────────────────────────────────
    // Chamado pela extensão após processar um lookup (com ou sem sucesso).
    if (req.method === 'POST' && url.pathname === '/toa/ack-lookup') {
      try {
        const bodyText = await readBody(req);
        const json = bodyText ? JSON.parse(bodyText) : {};
        const contrato = json.contrato || url.searchParams.get('contrato');
        ackLookup(contrato);
        writeJson(res, 200, { ok: true, stats: stats() });
      } catch (error) {
        writeJson(res, 400, { ok: false, error: error.message });
      }
      return;
    }

    writeJson(res, 404, { ok: false, error: 'Not found' });
  }

  function start() {
    if (server) return;
    load();
    server = http.createServer((req, res) => {
      handleRequest(req, res).catch((error) => {
        console.error('❌ Erro TOA bridge:', error.message);
        writeJson(res, 500, { ok: false, error: 'Erro interno' });
      });
    });

    server.listen(port, host, () => {
      console.log(`🌐 TOA bridge ativo em http://${host}:${port}`);
      console.log(`🔍 Auto-lookup endpoints: POST /toa/queue-lookup | GET /toa/pending-lookup | POST /toa/ack-lookup`);
    });
  }

  return {
    start,
    upsertMany,
    findByContract,
    queueLookup,
    stats,
    normalizeContract
  };
}

module.exports = { createToaBridge, normalizeContract };
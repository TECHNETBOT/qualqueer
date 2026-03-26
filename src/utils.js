// src/utils.js
const fs = require('fs');

const safeReadJson = (path, fallback) => {
    try {
        if (!fs.existsSync(path)) return fallback;
        const txt = fs.readFileSync(path, 'utf8');
        const obj = JSON.parse(txt);
        return obj && typeof obj === 'object' ? obj : fallback;
    } catch {
        return fallback;
    }
};

const safeWriteJsonAtomic = (path, obj) => {
    const tmp = `${path}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, path);
};

const normalizeDigits = (s) => String(s || '').replace(/\D/g, '');

const normalizeText = (s) => String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();

const normalizeSpaces = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const extractPhones = (raw) => {
    const digits = String(raw || '').split(/\s+/).map(x => x.replace(/\D/g, '')).filter(Boolean);
    const seen = new Set();
    const unique = [];
    for (const d of digits) {
        if (!seen.has(d)) { seen.add(d); unique.push(d); }
    }
    return unique.slice(0, 2);
};

const parseQuotedArgs = (text) => {
    const out = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(text)) !== null) out.push(m[1] ?? m[2]);
    return out;
};

// Normaliza JID para extrair apenas números
const normalizeJid = (jid) => {
    if (!jid) return '';
    return normalizeDigits(jid.split('@')[0]);
};

// Converte número inputado para JID
const toOwnerJid = (numero) => {
    let d = normalizeDigits(numero);
    if (!d) return '';
    if (d.startsWith('00')) d = d.slice(2);
    if (d.startsWith('55') && d.length >= 12) return `${d}@s.whatsapp.net`;
    if ((d.length === 10 || d.length === 11) && !d.startsWith('55')) return `55${d}@s.whatsapp.net`;
    return `${d}@s.whatsapp.net`;
};

const getField = (row, candidates) => {
    const keys = Object.keys(row || {});
    for (const cand of candidates) {
        const c = normalizeText(cand);
        const found = keys.find(k => normalizeText(k) === c);
        if (found && row[found] != null) return row[found];
    }
    return '';
};

module.exports = {
    safeReadJson, safeWriteJsonAtomic, normalizeDigits, normalizeText,
    normalizeSpaces, sleep, extractPhones, parseQuotedArgs, normalizeJid,
    toOwnerJid, getField
};
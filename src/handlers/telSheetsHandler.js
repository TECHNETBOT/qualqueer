// src/handlers/telSheetsHandler.js — versão robusta com suporte a abas ou colunas
const { google } = require('googleapis');
const path = require('path');
const fs   = require('fs');

const SPREADSHEET_ID = '1jcHpD-YR5A3t_DR2RYlVARAT-9kEVFwaB4G83g6TIZQ';
const LINHA_INICIO   = 3;
// Layout: 'tabs' = uma aba por cidade | 'columns' = colunas na mesma aba
const SHEETS_LAYOUT  = (process.env.SHEETS_TEL_LAYOUT || 'tabs').toLowerCase();
const ABA_COLUNAS    = process.env.SHEETS_TEL_COLUMNS_SHEET || 'TEL';

const GRUPO_PARA_CIDADE = {
  '120363397790697942@g.us': 'FORTALEZA/CE',
  '120363420013377509@g.us': 'MOSSORÓ/RN',
  '120363028547806621@g.us': 'NATAL/RN',
  '120363423496684075@g.us': 'NATAL/RN',
};

// Modo columns: blocos de 4 colunas por cidade
const CIDADE_PARA_COLUNAS = {
  'NATAL/RN':     ['A', 'D'],
  'FORTALEZA/CE': ['F', 'I'],
  'MOSSORÓ/RN':   ['K', 'N'],
};

let _sheetsClient = null;

function _loadCredentials() {
  const caminhos = [
    path.join(__dirname, '..', '..', 'data', 'credentials.json'),
    path.join(__dirname, '..', '..', 'data', 'credentials.js'),
  ];
  for (const p of caminhos) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw  = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim();
      const json = JSON.parse(raw);
      if (json?.private_key) json.private_key = json.private_key.replace(/\\n/g, '\n');
      return json;
    } catch(e) {
      console.error(`[SHEETS-TEL] erro ao ler ${path.basename(p)}: ${e.message}`);
    }
  }
  return null;
}

async function _getSheets() {
  if (_sheetsClient) return _sheetsClient;
  const creds = _loadCredentials();
  if (!creds) { console.warn('[SHEETS-TEL] credentials.json não encontrado'); return null; }
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  _sheetsClient = google.sheets({ version: 'v4', auth: await auth.getClient() });
  console.log('[SHEETS-TEL] autenticado com service account');
  return _sheetsClient;
}

function _layout(cidade) {
  if (SHEETS_LAYOUT === 'columns') {
    const faixa = CIDADE_PARA_COLUNAS[cidade];
    if (!faixa) return null;
    return { aba: ABA_COLUNAS, colInicio: faixa[0], colFim: faixa[1] };
  }
  return { aba: cidade, colInicio: 'A', colFim: 'D' };
}

async function _proximaLinha(sheets, layout) {
  try {
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${layout.aba}!${layout.colInicio}${LINHA_INICIO}:${layout.colInicio}`,
    });
    const rows = r.data.values || [];
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i]?.[0] || String(rows[i][0]).trim() === '') return LINHA_INICIO + i;
    }
    return LINHA_INICIO + rows.length;
  } catch(e) { return LINHA_INICIO; }
}

async function _jaExiste(sheets, layout, contrato) {
  try {
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${layout.aba}!${layout.colInicio}${LINHA_INICIO}:${layout.colInicio}`,
    });
    return (r.data.values || []).some(row => String(row?.[0]||'').trim() === String(contrato).trim());
  } catch(e) { return false; }
}

async function registrarNaPlanilha({ contrato, tecnico, codBaixa, obs, grupoId }) {
  const cidade = GRUPO_PARA_CIDADE[grupoId];
  if (!cidade) return false;
  const layout = _layout(cidade);
  if (!layout) { console.error(`[SHEETS-TEL] cidade sem layout: ${cidade}`); return false; }

  try {
    const sheets = await _getSheets();
    if (!sheets) return false;
    if (await _jaExiste(sheets, layout, contrato)) {
      console.log(`[SHEETS-TEL] ${contrato} já registrado em ${cidade}`);
      return false;
    }
    const linha = await _proximaLinha(sheets, layout);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${layout.aba}!${layout.colInicio}${linha}:${layout.colFim}${linha}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[contrato, tecnico||'', codBaixa||'', obs||'']] },
    });
    console.log(`[SHEETS-TEL] ✅ ${contrato} → ${layout.aba}!${layout.colInicio}${linha} (${cidade})`);
    return true;
  } catch(e) {
    const msg = e?.message || String(e);
    if (msg.includes('invalid_grant') || msg.includes('Invalid JWT')) {
      _sheetsClient = null;
      console.error('[SHEETS-TEL] erro de autenticação — verifique credentials.json e compartilhamento da planilha');
    } else {
      console.error('[SHEETS-TEL] erro:', msg);
    }
    return false;
  }
}

async function resetarPlanilha() {
  try {
    const sheets = await _getSheets();
    if (!sheets) return;

    if (SHEETS_LAYOUT === 'columns') {
      for (const [cidade, [col, colF]] of Object.entries(CIDADE_PARA_COLUNAS)) {
        const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${ABA_COLUNAS}!${col}${LINHA_INICIO}:${colF}` });
        const rows = r.data.values || [];
        if (!rows.length) continue;
        await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${ABA_COLUNAS}!${col}${LINHA_INICIO}:${colF}${LINHA_INICIO+rows.length-1}`, valueInputOption: 'RAW', requestBody: { values: rows.map(() => ['','','','']) } });
        console.log(`[SHEETS-TEL] ${cidade} resetada`);
      }
      return;
    }

    for (const aba of ['NATAL/RN', 'FORTALEZA/CE', 'MOSSORÓ/RN']) {
      const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${aba}!A${LINHA_INICIO}:D` });
      const rows = r.data.values || [];
      if (!rows.length) continue;
      await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${aba}!A${LINHA_INICIO}:D${LINHA_INICIO+rows.length-1}`, valueInputOption: 'RAW', requestBody: { values: rows.map(() => ['','','','']) } });
      console.log(`[SHEETS-TEL] aba "${aba}" resetada`);
    }
  } catch(e) { console.error('[SHEETS-TEL] reset erro:', e.message); }
}

let _ultimoReset = null;
function iniciarMonitorReset() {
  setInterval(() => {
    const agora = new Date();
    if (agora.getHours() === 23 && agora.getMinutes() === 0) {
      const hoje = agora.toDateString();
      if (_ultimoReset !== hoje) { _ultimoReset = hoje; resetarPlanilha(); }
    }
  }, 60000);
  console.log('[SHEETS-TEL] Monitor de reset diário ativo (23:00)');
}

module.exports = { registrarNaPlanilha, resetarPlanilha, iniciarMonitorReset, GRUPO_PARA_CIDADE };

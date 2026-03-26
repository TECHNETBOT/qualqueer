// src/handlers/telSheetsHandler.js
// Registra contratos prioritários na planilha Google Sheets
// Estrutura: uma aba por cidade
//   Aba "NATAL/RN"     → colunas A-D (A=CONTRATO, B=TÉCNICO, C=COD, D=OBS)
//   Aba "FORTALEZA/CE" → colunas A-D
//   Aba "MOSSORÓ/RN"   → colunas A-D
// Linha 1 = título cidade, Linha 2 = cabeçalho, dados a partir da linha 3
// Reseta às 23:00

const { google } = require('googleapis');
const path = require('path');
const fs   = require('fs');

const SPREADSHEET_ID = '1jcHpD-YR5A3t_DR2RYlVARAT-9kEVFwaB4G83g6TIZQ';
const LINHA_INICIO   = 3;
const COL_INICIO     = 'A';
const COL_FIM        = 'D';

// Cada cidade tem sua própria aba
const GRUPO_PARA_CIDADE = {
  '120363397790697942@g.us': 'FORTALEZA/CE',
  '120363420013377509@g.us': 'MOSSORÓ/RN',
  '120363028547806621@g.us': 'NATAL/RN',
  '120363423496684075@g.us': 'NATAL/RN',
};

let _sheetsClient = null;

async function _getSheets() {
  if (_sheetsClient) return _sheetsClient;
  const credPath = path.join(__dirname, '..', '..', 'data', 'credentials.json');
  if (!fs.existsSync(credPath)) {
    console.warn('[SHEETS-TEL] credentials.json não encontrado');
    return null;
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: credPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  _sheetsClient = google.sheets({ version: 'v4', auth: client });
  console.log('[SHEETS-TEL] autenticado');
  return _sheetsClient;
}

async function _getProximaLinha(sheets, aba) {
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${aba}!${COL_INICIO}${LINHA_INICIO}:${COL_INICIO}`,
    });
    const rows = resp.data.values || [];
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i] || !rows[i][0] || String(rows[i][0]).trim() === '') {
        return LINHA_INICIO + i;
      }
    }
    return LINHA_INICIO + rows.length;
  } catch(e) {
    return LINHA_INICIO;
  }
}

async function _jaExiste(sheets, aba, contrato) {
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${aba}!${COL_INICIO}${LINHA_INICIO}:${COL_INICIO}`,
    });
    return (resp.data.values || []).some(r => r && String(r[0]||'').trim() === String(contrato).trim());
  } catch(e) { return false; }
}

async function registrarNaPlanilha({ contrato, tecnico, codBaixa, obs, grupoId }) {
  const cidade = GRUPO_PARA_CIDADE[grupoId];
  if (!cidade) return false;

  try {
    const sheets = await _getSheets();
    if (!sheets) return false;

    if (await _jaExiste(sheets, cidade, contrato)) {
      console.log(`[SHEETS-TEL] ${contrato} já registrado em ${cidade}`);
      return false;
    }

    const linha = await _getProximaLinha(sheets, cidade);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${cidade}!${COL_INICIO}${linha}:${COL_FIM}${linha}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[contrato, tecnico||'', codBaixa||'', obs||'']] },
    });
    console.log(`[SHEETS-TEL] ✅ ${contrato} → aba "${cidade}" linha ${linha}`);
    return true;
  } catch(e) {
    console.error('[SHEETS-TEL] erro:', e.message);
    return false;
  }
}

async function resetarPlanilha() {
  try {
    const sheets = await _getSheets();
    if (!sheets) return;
    const abas = ['NATAL/RN', 'FORTALEZA/CE', 'MOSSORÓ/RN'];
    for (const aba of abas) {
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${aba}!${COL_INICIO}${LINHA_INICIO}:${COL_FIM}`,
      });
      const rows = resp.data.values || [];
      if (!rows.length) { console.log(`[SHEETS-TEL] ${aba} já vazia`); continue; }
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${aba}!${COL_INICIO}${LINHA_INICIO}:${COL_FIM}${LINHA_INICIO + rows.length - 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: rows.map(() => ['','','','']) },
      });
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
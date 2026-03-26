/**
 * niveis.js — Consulta de Níveis de Sinal (niveis.virtua.com.br)
 * 
 * Captcha: 3 camadas
 *   1. OCR local com pré-processamento por cor (grátis, instantâneo)
 *   2. 2captcha API (grátis nos créditos iniciais)
 *   3. Pergunta pro controlador no grupo (sempre funciona)
 */

const axios    = require('axios');
const cheerio  = require('cheerio');
const Tesseract = require('tesseract.js');
const sharp    = require('sharp');

// ── Config ────────────────────────────────────────────────────────────────────
const TWOCAPTCHA_KEY = process.env.TWOCAPTCHA_KEY || ''; // coloca no .env se quiser
const BASE_URL = 'http://niveis.virtua.com.br';
const FORM_URL = `${BASE_URL}/fr_esquerda.php`;
const HEADERS_BASE = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Referer': BASE_URL + '/',
};

// ── Mapa de cidades ───────────────────────────────────────────────────────────
const CIDADES = {
  'fortaleza':  '097',
  'mossoro':    '947',
  'mossoró':    '947',
  'natal':      '095',
  'parnamirim': '637',
  'recife':     '136',
};

const REGEX_MAC      = /\b([A-F0-9]{12})\b/i;
const REGEX_MAC_DOTS = /\b([0-9A-F]{2}[:\-]){5}([0-9A-F]{2})\b/i;
const REGEX_NIVEIS   = /n[ií]ve(is?|l)\s*(d[eo]s?\s*)?sinais?|sinais?\s*(n[ií]veis?)?|niv\.?\s*d[eo]s?\s*sinais?|medição\s*d[eo]\s*sinal/i;

function extrairMAC(texto) {
  const m1 = texto.match(REGEX_MAC);
  if (m1) return m1[1].toUpperCase();
  const m2 = texto.match(REGEX_MAC_DOTS);
  if (m2) return m2[0].replace(/[:\-]/g, '').toUpperCase();
  return null;
}

function extrairCodCidade(texto) {
  const norm = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const [cidade, cod] of Object.entries(CIDADES)) {
    const cn = cidade.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (norm.includes(cn)) return cod;
  }
  const mCod = texto.match(/\b(095|097|947|637|136)\b/);
  if (mCod) return mCod[1];
  const mSlash = texto.match(/\b(\d{3})\/[\dA-F]/i);
  if (mSlash && Object.values(CIDADES).includes(mSlash[1])) return mSlash[1];
  return null;
}

function analisarMensagem(texto) {
  return { mac: extrairMAC(texto), codCidade: extrairCodCidade(texto), temNiveis: REGEX_NIVEIS.test(texto) };
}

// ── Pré-processamento da imagem ───────────────────────────────────────────────
// Remove linhas de ruído (cinza) mantendo só letras coloridas
async function preprocessarCaptcha(buffer) {
  try {
    const { data, info } = await sharp(buffer)
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    const out = Buffer.alloc(width * height);

    for (let i = 0; i < width * height; i++) {
      const r = data[i * channels];
      const g = data[i * channels + 1];
      const b = data[i * channels + 2];
      const mean = (r + g + b) / 3;
      const desvio = Math.abs(r - mean) + Math.abs(g - mean) + Math.abs(b - mean);
      const ehBranco = r > 230 && g > 230 && b > 230;
      const ehColorido = desvio > 8 && !ehBranco;
      out[i] = ehColorido ? 0 : 255; // letra=preto, resto=branco
    }

    // Upscale 4x pra melhorar OCR
    return await sharp(out, { raw: { width, height, channels: 1 } })
      .resize(width * 4, height * 4, { kernel: 'lanczos3' })
      .png()
      .toBuffer();
  } catch (err) {
    console.error('[NIVEIS] Erro preprocessar:', err.message);
    return buffer; // retorna original se falhar
  }
}

// ── Camada 1: OCR local com Tesseract ────────────────────────────────────────
async function ocr_local(bufferOriginal) {
  try {
    const bufferProcessado = await preprocessarCaptcha(bufferOriginal);
    const { data: { text } } = await Tesseract.recognize(bufferProcessado, 'eng', {
      logger: () => {},
    });
    const limpo = text.replace(/[^a-zA-Z0-9]/g, '').trim().toLowerCase().substring(0, 4);
    console.log(`[NIVEIS] OCR local → "${limpo}"`);
    return limpo || null;
  } catch (err) {
    console.error('[NIVEIS] OCR local erro:', err.message);
    return null;
  }
}

// ── Camada 2: 2captcha ────────────────────────────────────────────────────────
async function ocr_2captcha(bufferImagem) {
  if (!TWOCAPTCHA_KEY) return null;
  try {
    const b64 = bufferImagem.toString('base64');

    // Envia imagem
    const envio = await axios.post('http://2captcha.com/in.php', {
      key: TWOCAPTCHA_KEY,
      method: 'base64',
      body: b64,
      json: 1,
    }, { timeout: 15000 });

    if (envio.data.status !== 1) {
      console.log('[NIVEIS] 2captcha envio falhou:', envio.data);
      return null;
    }

    const captchaId = envio.data.request;
    console.log(`[NIVEIS] 2captcha enviado, id=${captchaId}`);

    // Aguarda resultado (polling a cada 5s, max 30s)
    for (let t = 0; t < 6; t++) {
      await new Promise(r => setTimeout(r, 5000));
      const res = await axios.get('http://2captcha.com/res.php', {
        params: { key: TWOCAPTCHA_KEY, action: 'get', id: captchaId, json: 1 },
        timeout: 10000,
      });
      if (res.data.status === 1) {
        const texto = res.data.request.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 4);
        console.log(`[NIVEIS] 2captcha resultado → "${texto}"`);
        return texto;
      }
      if (res.data.request !== 'CAPCHA_NOT_READY') {
        console.log('[NIVEIS] 2captcha erro:', res.data.request);
        return null;
      }
    }
    return null;
  } catch (err) {
    console.error('[NIVEIS] 2captcha erro:', err.message);
    return null;
  }
}

// ── Parse HTML de resultado ───────────────────────────────────────────────────
function parsearResultado(html) {
  const $ = cheerio.load(html);
  let situacao = null;

  $('*').each((_, el) => {
    const t = $(el).text().trim();
    if (t === 'ONLINE') situacao = 'ONLINE';
    else if (t === 'OFFLINE') situacao = 'OFFLINE';
  });

  if (!situacao) return null;

  const metricas = {};
  $('table').each((_, table) => {
    const rows = $(table).find('tr');
    if (rows.length >= 2) {
      const headers = [];
      $(rows[0]).find('td, th').each((_, c) => headers.push($(c).text().trim()));
      const valores = [];
      $(rows[1]).find('td').each((_, c) => valores.push($(c).text().trim()));
      if (headers.length === valores.length) {
        headers.forEach((h, i) => { if (h && valores[i]) metricas[h] = valores[i]; });
      }
    }
  });

  return { situacao, metricas };
}

function formatarResposta(resultado, mac, codCidade) {
  if (!resultado) return null;
  const { situacao, metricas, screenshot } = resultado;
  const emoji = situacao === 'ONLINE' ? '🟢' : '🔴';
  const cidade = Object.entries(CIDADES).find(([, v]) => v === codCidade)?.[0] || codCidade;
  const campos = ['Sinal TX', 'Sinal RX', 'SNR DS', 'SNR UP', 'Receive Power', 'Media RX', 'Desvio RX', 'Slope', '6MHZ Slices'];
  const linhas = campos.filter(c => metricas[c]).map(c => `  • *${c}:* ${metricas[c]}`);
  let msg = `📡 *Níveis de Sinal*\nMAC: \`${mac}\` | ${cidade.toUpperCase()} (${codCidade})\n${emoji} *${situacao}*\n\n`;
  msg += linhas.length > 0 ? `*Métricas:*\n${linhas.join('\n')}` : `_Equipamento ${situacao}._`;
  return { mensagem: msg, screenshot };
}

// ── Sessão HTTP compartilhada com cookie real ─────────────────────────────────
function criarCliente() {
  const cookieJar = {};

  const instance = axios.create({
    baseURL: BASE_URL,
    timeout: 15000,
    headers: HEADERS_BASE,
  });

  // Salva cookies da resposta
  instance.interceptors.response.use(res => {
    const sc = res.headers['set-cookie'];
    if (sc) {
      sc.forEach(c => {
        const par = c.split(';')[0];
        const idx = par.indexOf('=');
        if (idx > 0) {
          const k = par.substring(0, idx).trim();
          const v = par.substring(idx + 1).trim();
          cookieJar[k] = v;
          console.log(`[NIVEIS] Cookie salvo: ${k}=${v}`);
        }
      });
    }
    return res;
  });

  // Injeta cookies em cada request
  instance.interceptors.request.use(cfg => {
    const cookieStr = Object.entries(cookieJar).map(([k,v]) => `${k}=${v}`).join('; ');
    if (cookieStr) {
      cfg.headers = { ...cfg.headers, Cookie: cookieStr };
      console.log(`[NIVEIS] Enviando cookies: ${cookieStr}`);
    }
    return cfg;
  });

  return instance;
}

// ── Tentativa de consulta com um texto de captcha ────────────────────────────
async function tentarConsulta(client, codCidade, mac, textoCaptcha) {
  const form = new URLSearchParams();
  form.append('cod_cidade', codCidade);
  form.append('mac', mac);
  form.append('word', textoCaptcha);
  form.append('btConsultar', 'Consultar');

  // POST pro formulário
  await client.post('/fr_esquerda.php', form.toString(), {
    headers: { ...HEADERS_BASE, 'Content-Type': 'application/x-www-form-urlencoded', Referer: FORM_URL },
  });

  // O resultado fica em fr_direita.php?cod_cidade=X&mac=Y
  const res = await client.get(`/fr_direita.php?cod_cidade=${codCidade}&mac=${mac}`, {
    headers: { ...HEADERS_BASE, Referer: FORM_URL },
  });

  const fs = require('fs');
  fs.writeFileSync('/tmp/niveis_resultado.html', res.data);
  console.log(`[NIVEIS] fr_direita resultado:`, res.data.substring(0, 300).replace(/\s+/g, ' '));

  const resultado = parsearResultado(res.data);
  if (!resultado) return null;

  // Gera screenshot do HTML do resultado
  const screenshot = await tirarScreenshotHTML(res.data, codCidade, mac);
  resultado.screenshot = screenshot;
  return resultado;
}

// ── Screenshot do HTML de resultado ──────────────────────────────────────────
async function tirarScreenshotHTML(html, codCidade, mac) {
  try {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 700, height: 600 });

    // Injeta base URL pra carregar CSS do site
    const htmlComBase = html.replace('<head>', `<head><base href="${BASE_URL}/" />`);
    await page.setContent(htmlComBase, { waitUntil: 'networkidle2', timeout: 10000 });

    // Espera um pouco carregar
    await new Promise(r => setTimeout(r, 1500));

    const screenshot = await page.screenshot({ fullPage: true });
    await browser.close();
    console.log(`[NIVEIS] Screenshot gerado (${screenshot.length} bytes)`);
    return screenshot;
  } catch (err) {
    console.error('[NIVEIS] Screenshot erro:', err.message);
    return null;
  }
}

// ── Consulta principal — vai direto pro humano ───────────────────────────────
async function consultarNiveis({ codCidade, mac }) {
  const client = criarCliente();

  await client.get('/fr_esquerda.php');
  const capRes = await client.get('/freecap/freecap.php', {
    responseType: 'arraybuffer',
    headers: { ...HEADERS_BASE, Referer: FORM_URL },
  });
  const captchaBuffer = Buffer.from(capRes.data);

  console.log('[NIVEIS] Aguardando captcha humano');
  return { ok: false, precisaHumano: true, captchaBuffer, client, codCidade, mac };
}

// ── Consulta após humano resolver ────────────────────────────────────────────
async function consultarComCaptchaHumano({ client, codCidade, mac, textoCaptcha }) {
  try {
    const resultado = await tentarConsulta(client, codCidade, mac, textoCaptcha);
    if (resultado) {
      const fmt = formatarResposta(resultado, mac, codCidade);
      return { ok: true, mensagem: fmt.mensagem, screenshot: fmt.screenshot };
    }
    return { ok: false, erro: 'Captcha incorreto.' };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

const TEXTO_CIDADES = ['095 = Natal','097 = Fortaleza','136 = Recife','637 = Parnamirim','947 = Mossoró'].join('\n');

module.exports = {
  analisarMensagem,
  consultarNiveis,
  consultarComCaptchaHumano,
  extrairMAC,
  extrairCodCidade,
  TEXTO_CIDADES,
  CIDADES,
};
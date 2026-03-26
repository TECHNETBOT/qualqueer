// src/handlers/niveisHandler.js — Handler de Níveis de Sinal
const { consultarNiveis, consultarComCaptchaHumano, analisarMensagem: analisarNiveis, TEXTO_CIDADES, extrairCodCidade } = require('../niveis');

// Retorna true se a mensagem tem gatilho explícito de níveis
// APENAS "niveis", "sinais", "nivel sinal", "sinais niveis" — ignora "status do contrato" etc.
function _temGatilhoNiveis(texto) {
  const t = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /\bn[ií]ve(is?|l)\b/.test(t) || /\bsinais?\b/.test(t);
}

async function enviarResultadoNiveis(sock, chatId, res, quoted) {
  const { mensagem, screenshot } = res;
  if (screenshot && Buffer.isBuffer(screenshot)) {
    await sock.sendMessage(chatId, {
      image: { url: `data:image/png;base64,${screenshot.toString('base64')}` },
      caption: mensagem
    }, { quoted });
  } else {
    await sock.sendMessage(chatId, { text: mensagem }, { quoted });
  }
}

// Retorna true se consumiu a mensagem
async function handleNiveis({ sock, chatId, m, msgTexto, usuarioId, esperaNiveis }) {

  // ── Resposta de estado pendente (captcha / cidade) ────────────────────────
  if (esperaNiveis.has(chatId)) {
    const ctx = esperaNiveis.get(chatId);

    // Expirou (3 min)
    if (Date.now() - ctx.ts > 3 * 60 * 1000) {
      esperaNiveis.delete(chatId);
      // não retorna — deixa processar normalmente
    }

    // Aguardando CIDADE
    else if (ctx.fase === 'cidade') {
      const codResposta = extrairCodCidade(msgTexto);
      if (codResposta) {
        esperaNiveis.delete(chatId);
        await sock.sendMessage(chatId, { text: `🔍 Consultando níveis para MAC *${ctx.mac}* (cidade *${codResposta}*)... aguarde.` }, { quoted: m });
        const res = await consultarNiveis({ codCidade: codResposta, mac: ctx.mac });
        if (res.ok) {
          await enviarResultadoNiveis(sock, chatId, res, m);
        } else if (res.precisaHumano) {
          esperaNiveis.set(chatId, { fase: 'captcha', mac: ctx.mac, codCidade: codResposta, client: res.client, solicitanteId: usuarioId, ts: Date.now() });
          await sock.sendMessage(chatId, { image: res.captchaBuffer, caption: `🔐 Não consegui ler o captcha automaticamente.\nDigite o texto da imagem acima 👆` }, { quoted: m });
        } else {
          await sock.sendMessage(chatId, { text: `❌ Não consegui consultar. Verifique o MAC *${ctx.mac}* e tente novamente.` }, { quoted: m });
        }
        return true;
      }
      // Não reconheceu cidade — ignora e deixa processar normalmente
    }

    // Aguardando CAPTCHA HUMANO
    else if (ctx.fase === 'captcha') {
      if (usuarioId !== ctx.solicitanteId) return true; // ignora outros

      if (ctx.aguardandoConfirmacao) {
        const resp = msgTexto.trim().toLowerCase().replace(/[^a-záéíóúãõ]/g, '');
        if (['sim','si','s','yes','y','pode','manda','vai','bora'].includes(resp)) {
          try {
            const novaConsulta = await consultarNiveis({ codCidade: ctx.codCidade, mac: ctx.mac });
            if (novaConsulta.precisaHumano) {
              esperaNiveis.set(chatId, { fase: 'captcha', mac: ctx.mac, codCidade: ctx.codCidade, client: novaConsulta.client, solicitanteId: ctx.solicitanteId, tentativas: 0, ts: Date.now() });
              await sock.sendMessage(chatId, { image: novaConsulta.captchaBuffer, caption: `🔐 Novo captcha! Digite o texto da imagem acima 👆` }, { quoted: m });
            } else {
              await sock.sendMessage(chatId, { text: `❌ Erro ao buscar captcha. Tente mandando o MAC novamente.` }, { quoted: m });
              esperaNiveis.delete(chatId);
            }
          } catch(e) {
            await sock.sendMessage(chatId, { text: `❌ Erro ao buscar captcha. Tente novamente.` }, { quoted: m });
            esperaNiveis.delete(chatId);
          }
        } else if (['nao','não','n','no','nop','nope','nã'].includes(resp)) {
          esperaNiveis.delete(chatId);
          await sock.sendMessage(chatId, { text: `😴 Ok, qualquer coisa me chame` }, { quoted: m });
        }
        return true;
      }

      const textoCaptcha = msgTexto.trim().toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 6);
      if (textoCaptcha.length >= 3) {
        await sock.sendMessage(chatId, { text: `🔍 Tentando com captcha *"${textoCaptcha}"*... aguarde.` }, { quoted: m });
        const res = await consultarComCaptchaHumano({ client: ctx.client, codCidade: ctx.codCidade, mac: ctx.mac, textoCaptcha });
        if (res.ok) {
          esperaNiveis.delete(chatId);
          await enviarResultadoNiveis(sock, chatId, res, m);
        } else {
          const tentativas = (ctx.tentativas || 0) + 1;
          if (tentativas >= 3) {
            esperaNiveis.set(chatId, { ...ctx, aguardandoConfirmacao: true, tentativas, ts: Date.now() });
            await sock.sendMessage(chatId, { text: `😅 Erramos 3 vezes no captcha...\nQuer tentar novamente? *(sim/não)*` }, { quoted: m });
          } else {
            try {
              const novaConsulta = await consultarNiveis({ codCidade: ctx.codCidade, mac: ctx.mac });
              if (novaConsulta.precisaHumano) {
                esperaNiveis.set(chatId, { fase: 'captcha', mac: ctx.mac, codCidade: ctx.codCidade, client: novaConsulta.client, solicitanteId: ctx.solicitanteId, tentativas, ts: Date.now() });
                await sock.sendMessage(chatId, { image: novaConsulta.captchaBuffer, caption: `❌ Captcha errado! Tentativa ${tentativas}/3 — tente novamente 👇` }, { quoted: m });
              } else {
                await sock.sendMessage(chatId, { text: `❌ Erro na consulta. Tente novamente.` }, { quoted: m });
                esperaNiveis.delete(chatId);
              }
            } catch(e) {
              await sock.sendMessage(chatId, { text: `❌ Erro na consulta. Tente novamente.` }, { quoted: m });
              esperaNiveis.delete(chatId);
            }
          }
        }
        return true;
      }
    }
  }

  // ── Detecção nova ─────────────────────────────────────────────────────────
  const analise = analisarNiveis(msgTexto);

  // ✅ CORREÇÃO: só dispara se tiver "niveis" ou "sinais" explícito na mensagem
  // Ignora mensagens como "verifica o status do contrato", "095/123456" sozinho, etc.
  if (!analise.mac && !analise.temNiveis) return false;
  if (analise.mac && !analise.temNiveis && !_temGatilhoNiveis(msgTexto)) return false;

  const mac = analise.mac;
  const cod = analise.codCidade;

  if (mac && !cod) {
    esperaNiveis.set(chatId, { fase: 'cidade', mac, ts: Date.now() });
    await sock.sendMessage(chatId, {
      text: `📡 MAC detectado: *${mac}*\nQual é a cidade? Responda com o nome ou código:\n\n${TEXTO_CIDADES}`
    }, { quoted: m });
    return true;
  }

  if (!mac && analise.temNiveis) {
    await sock.sendMessage(chatId, {
      text: `📡 Para consultar os níveis, me informe o *MAC Address* do equipamento.\nEx: \`24E4CEF77D05\` ou \`095/24E4CEF77D05\``
    }, { quoted: m });
    return true;
  }

  if (mac && cod) {
    await sock.sendMessage(chatId, { text: `🔍 Consultando níveis para MAC *${mac}* (cidade *${cod}*)... aguarde.` }, { quoted: m });
    const res = await consultarNiveis({ codCidade: cod, mac });
    if (res.ok) {
      await enviarResultadoNiveis(sock, chatId, res, m);
    } else if (res.precisaHumano) {
      esperaNiveis.set(chatId, { fase: 'captcha', mac, codCidade: cod, client: res.client, solicitanteId: usuarioId, ts: Date.now() });
      await sock.sendMessage(chatId, { image: res.captchaBuffer, caption: `🔐 Não consegui ler o captcha automaticamente.\nDigite o texto da imagem acima 👆` }, { quoted: m });
    } else {
      await sock.sendMessage(chatId, { text: `❌ Não consegui consultar. Verifique o MAC *${mac}* e tente novamente.` }, { quoted: m });
    }
    return true;
  }

  return false;
}

module.exports = { handleNiveis };
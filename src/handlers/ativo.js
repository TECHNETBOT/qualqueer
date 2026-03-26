// src/handlers/ativo.js — !ativo: busca TOA, avisa no grupo, manda msg inicial pro cliente direto
const Utils = require('../utils');
const { iniciarConversaCliente } = require('../ia');

// Map de conversas ativas: chatCliente -> { contrato, nomeCliente, tecnico, chatOrigemControlador }
const conversasAtivas = new Map();

async function handleAtivo({ sock, chatId, m, msgTextoRaw, toaBridge }) {
  // Parser: "!ativo NomeTecnico, contrato1 contrato2 ..." ou multiline
  const bodyAtivo   = msgTextoRaw.trim().slice(7);
  const linhasAtivo = bodyAtivo.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);

  const primeiraLinha = linhasAtivo[0] || '';
  const virgPos = primeiraLinha.indexOf(',');
  let nomeInputAtivo, contratosRaw;

  if (virgPos !== -1) {
    nomeInputAtivo = primeiraLinha.slice(0, virgPos).trim();
    contratosRaw   = [primeiraLinha.slice(virgPos + 1).trim(), ...linhasAtivo.slice(1)].join(' ');
  } else {
    nomeInputAtivo = primeiraLinha;
    contratosRaw   = linhasAtivo.slice(1).join(' ');
  }

  const contratosAtivo = (contratosRaw.match(/\b\d{6,9}\b/g) || []);

  if (!nomeInputAtivo || !contratosAtivo.length) {
    await sock.sendMessage(chatId, {
      text: `❌ Uso:\n*!ativo NomeTecnico, contrato1 contrato2 ...*\nOu:\n*!ativo NomeTecnico*\n123456\n789012`
    }, { quoted: m });
    return;
  }

  const nomeExibicao = nomeInputAtivo.trim();
  const primeiroNome = nomeExibicao.split(' ')[0];

  await sock.sendMessage(chatId, {
    text: `🔍 Buscando *${contratosAtivo.length}* contrato(s) para *${nomeExibicao}*...`
  }, { quoted: m });

  for (const contrato of contratosAtivo) {
    // Polling TOA
    toaBridge.queueLookup(contrato);
    let dadosCliente = null;
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      const found = toaBridge.findByContract(contrato);
      if (found && found.telefones && found.telefones.length > 0) { dadosCliente = found; break; }
      await Utils.sleep(2000);
    }

    if (!dadosCliente) {
      await sock.sendMessage(chatId, {
        text: `⚠️ Contrato *${contrato}* não encontrado no TOA. Verifique manualmente.`
      }, { quoted: m });
      continue;
    }

    const nomeCliente = (dadosCliente.nome || '').trim() || 'Cliente';

    // Gera todos os formatos possíveis do número para tentar no WhatsApp
    // (com e sem o nono dígito, com e sem DDI)
    const _gerarFormatos = (raw) => {
      const num = String(raw).replace(/\D/g, '');
      if (num.length < 10) return [];
      const formatos = new Set();
      let base = num;
      // Remove DDI 55 se já tiver
      if (base.startsWith('55') && base.length >= 12) base = base.slice(2);
      const ddd   = base.slice(0, 2);
      const corpo = base.slice(2);
      // Com 9 (celular moderno, 9 dígitos no corpo)
      if (corpo.length === 9 && corpo[0] === '9') {
        formatos.add(`55${ddd}${corpo}`);         // formato normal com 9
        formatos.add(`55${ddd}${corpo.slice(1)}`); // sem o 9 (8 dígitos)
      // Sem 9 (8 dígitos no corpo)
      } else if (corpo.length === 8) {
        formatos.add(`55${ddd}${corpo}`);         // sem o 9
        formatos.add(`55${ddd}9${corpo}`);         // com o 9
      } else {
        formatos.add(`55${ddd}${corpo}`);
      }
      return [...formatos];
    };

    // Expande cada telefone em seus possíveis formatos
    const telefonesValidos = [...new Set(
      dadosCliente.telefones
        .filter(t => t && String(t).replace(/\D/g, '').length >= 10)
        .flatMap(t => _gerarFormatos(t))
    )];

    if (!telefonesValidos.length) {
      await sock.sendMessage(chatId, {
        text: `⚠️ Contrato *${contrato}* encontrado mas sem telefone válido no TOA.`
      }, { quoted: m });
      continue;
    }

    // ── Resposta no grupo: contrato + cliente + técnico + números ──────────
    let blocoGrupo = `📋 *CONTRATO ${contrato}*\n`;
    blocoGrupo += `👤 *Cliente:* ${nomeCliente}\n`;
    blocoGrupo += `👷 *Técnico:* ${nomeExibicao}\n`;
    blocoGrupo += `📞 *Números:* ${telefonesValidos.map(t => t.replace(/^55/, '')).join(' | ')}\n`;
    blocoGrupo += `\n💬 _Enviando mensagem ativa..._`;
    await sock.sendMessage(chatId, { text: blocoGrupo }, { quoted: m });

    // ── Mensagem inicial — varia texto pra não cair em spam ─────────────────
    const primeiroNomeCliente = nomeCliente.split(' ')[0];
    const _saudacoes = ['Oi', 'Olá', 'Boa tarde', 'Bom dia', 'Oi, tudo bem'];
    const _aberturas = [
      `Estou entrando em contato sobre a retirada dos equipamentos da Claro na sua residência.`,
      `A Claro me solicitou verificar a disponibilidade para retirada de equipamentos.`,
      `Precisamos agendar a retirada de alguns equipamentos Claro da sua casa.`,
      `Tô passando aqui pra combinar a retirada dos equipamentos Claro com você.`,
    ];
    const _perguntas = [
      `Você tem disponibilidade hoje?`,
      `Seria possível hoje para retirada?`,
      `Hoje é um bom dia pra gente passar aí?`,
      `Você tá em casa hoje?`,
    ];
    const _confirmacoes = [
      `Se puder, só me confirma o endereço pra eu validar no sistema.`,
      `Me confirma o endereço pra eu checar aqui rapidinho.`,
      `Só preciso confirmar o endereço cadastrado.`,
      `Me passa o endereço pra validar no sistema, por favor.`,
    ];
    const _seed = parseInt(contrato) % 4;
    const saud  = _saudacoes[_seed % _saudacoes.length];
    const aber  = _aberturas[_seed % _aberturas.length];
    const perg  = _perguntas[(_seed + 1) % _perguntas.length];
    const conf  = _confirmacoes[(_seed + 2) % _confirmacoes.length];
    const msgInicial = `${saud}, ${primeiroNomeCliente}! Aqui é o suporte técnico da Claro 😊
${aber}
${perg}
${conf}

Contrato: ${contrato}`;

    // Rastreia JIDs já enviados para evitar duplicatas (dois formatos do mesmo número)
    const jidsEnviados = new Set();
    let enviouAlgum = false;

    for (const numComDDI of telefonesValidos) {
      try {
        // Verifica se o número tem WhatsApp — usa o JID correto retornado pelo WA
        let numFinal = numComDDI;
        let temWhatsApp = false;
        try {
          const [result] = await sock.onWhatsApp(numComDDI);
          if (result?.exists) {
            temWhatsApp = true;
            if (result.jid) numFinal = result.jid.replace('@s.whatsapp.net', '');
          }
        } catch (_) {
          // onWhatsApp falhou — tenta mesmo assim
          temWhatsApp = true;
        }

        if (!temWhatsApp) {
          console.log(`[ATIVO] ${numComDDI} não tem WhatsApp — pulando`);
          continue;
        }

        const chatCliente = `${numFinal}@s.whatsapp.net`;

        // Evita mandar duplicado (dois formatos do mesmo número resolvem pro mesmo JID)
        if (jidsEnviados.has(chatCliente)) {
          console.log(`[ATIVO] ${chatCliente} já recebeu — pulando duplicata`);
          continue;
        }
        jidsEnviados.add(chatCliente);

        await sock.sendMessage(chatCliente, { text: msgInicial });
        console.log(`[ATIVO] msg enviada pro cliente: ${chatCliente} (contrato ${contrato})`);

        // Registra conversa ativa — IA vai interceptar as respostas
        iniciarConversaCliente({
          chatCliente,
          nomeCliente,
          contrato,
          tecnico: nomeExibicao,
          chatOrigemControlador: chatId,
        });
        conversasAtivas.set(chatCliente, {
          contrato,
          nomeCliente,
          tecnico:               nomeExibicao,
          chatOrigemControlador: chatId,
        });

        enviouAlgum = true;
        await Utils.sleep(1200);
      } catch (e) {
        console.error(`[ATIVO] erro ao enviar pro ${numComDDI}:`, e.message);
      }
    }

    if (enviouAlgum) {
      await sock.sendMessage(chatId, {
        text: `✅ Mensagem enviada para *${nomeCliente}* (contrato ${contrato})\n_Responderei automaticamente quando o cliente retornar._`
      });
    } else {
      await sock.sendMessage(chatId, {
        text: `❌ Não consegui enviar para nenhum número do contrato *${contrato}*.\nVerifique os números no TOA.`
      }, { quoted: m });
    }
  }
}

module.exports = { handleAtivo, conversasAtivas };
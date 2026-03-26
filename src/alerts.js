// src/alerts.js
const montarMensagemAlerta = (titulo, janelas, controladores) => {
    const textoJanelas = janelas.map(j => `* ${j}`).join('\n');
    return `🚨 *ATENÇÃO – ${titulo}* 🚨\n⏰ *Janelas de encerramento:*\n${textoJanelas}\n👷‍♂️ *Controladores:* ${controladores}\n\n⚠️ Faltam apenas 15 minutos para o término desta janela.\n📉 Baixem os atendimentos imediatamente.\n✅ Evitem pendências.`;
};

const obterControladores = (lista) => {
    if (lista.length === 0) return { texto: '(Nenhum cadastrado)', mentions: [] };
    return {
        texto: lista.map(num => `@${num}`).join(' '),
        mentions: lista.map(num => `${num}@s.whatsapp.net`)
    };
};

const enviarAlertaJanela = async (sock, janelaHorario, idDestino) => {
    const mensagem = `🚨 *ATENÇÃO – TEC 1* 🚨\n⏰ Janela de atendimento: ${janelaHorario}\n\n⚠️ Todos os atendimentos devem ser baixados imediatamente, pois faltam apenas 15 minutos para o término da janela.\n✅ Evitem atrasos e garantam o fechamento dentro do prazo.`;
    try { await sock.sendMessage(idDestino, { text: mensagem }); } catch (err) { console.error(`Erro no alerta:`, err.message); }
};

const enviarAlertaGenerico = async (sock, { titulo, janelas, idDestino, lista, logPrefixo }) => {
    const { texto, mentions } = obterControladores(lista);
    const mensagem = montarMensagemAlerta(titulo, janelas, texto);
    try {
        await sock.sendMessage(idDestino, { text: mensagem, mentions });
        console.log(`✅ Alerta ${logPrefixo} enviado: ${janelas.join(', ')}`);
    } catch (err) {
        console.error(`Erro no alerta ${logPrefixo}:`, err.message);
    }
};

module.exports = { enviarAlertaJanela, enviarAlertaGenerico };
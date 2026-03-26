const fs = require('fs');
const path = require('path');

const ARQUIVO_PONTO = './ponto_controladores.json';

// Lista oficial de Controladores (ORDEM FIXA E OBRIGATÓRIA)
const LISTA_CONTROLADORES = [
    "ARTHUR PADILHA DE CARVALHO",
    "ADRIA LORENA BESERRA DE LIMA",
    "ALEX DA COSTA CAMPOS",
    "ANA KAROLINE XAVIER MONTEIRO",
    "ANA PATRICIA RODRIGUES ALVES SILVA",
    "ANDERSON JUSSIER DA SILVA FERNANDES",
    "ANTONIA ELIZIENE DO NASCIMENTO",
    "CLAYVERTON SOUTO DE OLIVEIRA",
    "CARLOS ADRIANO DA SILVA",
    "DALTON SYMEY GODOI FONSECA",
    "DARLANYDIERY S FERNANDES DE LEMOS",
    "FELIPE MATEUS MEDEIROS DE LUCENA",
    "FRANCISCO GABRIEL DE PAULA DANTAS",
    "GERCIANO GLEY PEREIRA MARQUES FILHO",
    "JEFERSON FERREIRA BARBOSA",
    "JEFFERSON FIRMINO DA SILVA",
    "KENIA KATIUCIA SANTOS DA SILVA",
    "MARCELLE DIANNE ARAUJO MARTINS",
    "MARCELO ALMEIDA DE PAIVA CAVALCANTI",
    "MARTA MARIA ALBUQUERQUE DO NASCIMENTO",
    "MATHEUS FREITAS DIONISIO CAMARA",
    "OYAMA EDUARDO FILGUEIRA AFONSO JUNIOR",
    "PEDRO THIAGO NUNES CORREIA",
    "LUIZ FELIPE GUEDES MOREIRA DANTAS",
    "ROSA FERNANDA SILVA DE BRITO",
    "ROBSON CARLOS FIGUEIREDO",
    "RODRIGO RAMON PESSOA CRUZ",
    "ROMUALDO SANTOS DE MELO",
    "TIAGO DA SILVA JANUARIO",
    "WELLINGTON RAFAEL DE OLIVEIRA"
];

// === PADRÕES DE TEXTO (REGEX) ===
const PADROES = {
    INICIO: ['inici', 'iníc', 'inic', 'inico', 'começ', 'comec', 'bom dia', 'bomdia', 'entrando', 'cheguei', 'tô na área', 'to na area', 'na escuta', 'apto'],
    ALMOCO_IDA: ['almoç', 'almoc', 'almoo', 'amoco', 'pausa', 'intervalo', 'rango', 'hora do', 'saindo'],
    ALMOCO_VOLTA: ['volt', 'vout', 'retorn', 'retor', 'back', 'vpltri'],
    FIM: ['encerr', 'encer', 'enbcerr', 'finaliz', 'termin', 'fim', 'tchau', 'fui', 'ate amanha', 'até amanhã']
};

const getHojeBR = () => {
    const now = new Date();
    const dia = String(now.getDate()).padStart(2, '0');
    const mes = String(now.getMonth() + 1).padStart(2, '0');
    const ano = now.getFullYear();
    return `${dia}-${mes}-${ano}`;
};

const getHojeFormatado = () => {
    const now = new Date();
    const dia = String(now.getDate()).padStart(2, '0');
    const mes = String(now.getMonth() + 1).padStart(2, '0');
    const ano = now.getFullYear();
    return `${dia}/${mes}/${ano}`;
};

const identificarNomeNaLista = (texto) => {
    if (!texto) return null;
    const textoLimpo = texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w\s]/g, ""); 
    return LISTA_CONTROLADORES.find(oficial => {
        const oficialLimpo = oficial.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        const primeiroNome = oficialLimpo.split(' ')[0];
        const partesTexto = textoLimpo.split(/\s+/);
        if (partesTexto.includes(primeiroNome)) return true;
        return false;
    });
};

const carregarPonto = () => {
    try {
        if (fs.existsSync(ARQUIVO_PONTO)) return JSON.parse(fs.readFileSync(ARQUIVO_PONTO));
    } catch (e) { return {}; }
    return {};
};
const salvarPonto = (dados) => fs.writeFileSync(ARQUIVO_PONTO, JSON.stringify(dados, null, 2));

const extrairHorario = (texto, timestamp) => {
    const regexHora = /\b([0-1]?[0-9]|2[0-3])[:hH\.\s]([0-5][0-9])?\b/;
    const match = texto.match(regexHora);
    if (match) {
        let hora = match[1].padStart(2, '0');
        let minuto = match[2] || '00';
        return `${hora}:${minuto}`;
    }
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });
};

const contemPadrao = (texto, listaPadroes) => {
    return listaPadroes.some(padrao => texto.includes(padrao));
};

const processarMensagemPonto = (usuarioPushName, texto, timestamp) => {
    let nomeControlador = identificarNomeNaLista(texto);
    if (!nomeControlador) {
        nomeControlador = identificarNomeNaLista(usuarioPushName) || usuarioPushName;
    }

    const textoLimpo = texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    let tipo = null;
    
    if (contemPadrao(textoLimpo, PADROES.FIM)) tipo = 'fim_exp';
    else if (contemPadrao(textoLimpo, PADROES.ALMOCO_VOLTA)) tipo = 'fim_almoco';
    else if (contemPadrao(textoLimpo, PADROES.ALMOCO_IDA)) tipo = 'inicio_almoco';
    else if (contemPadrao(textoLimpo, PADROES.INICIO)) tipo = 'inicio_exp';

    if (!tipo) return null;

    const horario = extrairHorario(texto, timestamp);
    const hojeKey = getHojeBR(); 
    
    const db = carregarPonto();
    if (!db[hojeKey]) db[hojeKey] = {};
    if (!db[hojeKey][nomeControlador]) db[hojeKey][nomeControlador] = { nome: nomeControlador, inicio_exp: '', inicio_almoco: '', fim_almoco: '', fim_exp: '' };

    db[hojeKey][nomeControlador][tipo] = horario;
    salvarPonto(db);

    return { nome: nomeControlador, tipo, horario };
};

const gerarRelatorioDia = () => {
    const hojeKey = getHojeBR();
    const db = carregarPonto();
    const dadosHoje = db[hojeKey] || {};
    const lista = Object.values(dadosHoje).sort((a, b) => a.nome.localeCompare(b.nome));
    
    if (lista.length === 0) return "📋 Nenhum registro de ponto hoje.";

    let txt = `📋 *RELATÓRIO PARCIAL (${getHojeFormatado()})*\n\n`;
    lista.forEach(p => {
        const primeiroNome = p.nome.split(' ')[0];
        txt += `👤 *${primeiroNome}*\n   Início: ${p.inicio_exp || '-'}\n   Alm-Ida: ${p.inicio_almoco || '-'}\n   Alm-Vol: ${p.fim_almoco || '-'}\n   Fim: ${p.fim_exp || '-'}\n\n`;
    });
    return txt;
};

// === GERA SÓ OS HORÁRIOS PARA COLAR NO EXCEL ===
const gerarRelatorioCSV = () => {
    const hojeKey = getHojeBR();
    const db = carregarPonto();
    const dadosHoje = db[hojeKey] || {};

    let csv = "";
    
    LISTA_CONTROLADORES.forEach(nomeOficial => {
        const dados = dadosHoje[nomeOficial] || {};
        const ini = dados.inicio_exp || '-';
        const alm_ida = dados.inicio_almoco || '-';
        const alm_vol = dados.fim_almoco || '-';
        const fim = dados.fim_exp || '-';
        // Formato TABULADO para Excel
        csv += `${ini}\t${alm_ida}\t${alm_vol}\t${fim}\n`;
    });

    return csv;
}

module.exports = { processarMensagemPonto, gerarRelatorioDia, gerarRelatorioCSV };
const fs = require('fs');
const path = require('path');

// Caminhos dos arquivos JSON
const ARQUIVO_VT = './marcacoes_vt.json';
const ARQUIVO_AD = './marcacoes_ad.json';
const ARQUIVO_DESC = './marcacoes_desc.json';
const ARQUIVO_FORAROTA_USADOS = './forarota_usados.json'; // Histórico do Fora Rota

// Função auxiliar para carregar
function carregarLista(caminho) {
    try {
        if (fs.existsSync(caminho)) {
            const dados = fs.readFileSync(caminho, 'utf8');
            return JSON.parse(dados) || [];
        }
    } catch (e) {
        console.error(`Erro ao ler ${caminho}:`, e.message);
    }
    return [];
}

// Função auxiliar para salvar
function salvarLista(caminho, lista) {
    try {
        fs.writeFileSync(caminho, JSON.stringify(lista, null, 2));
    } catch (e) {
        console.error(`Erro ao salvar ${caminho}:`, e.message);
    }
}

// Carrega as listas na memória ao iniciar
const listaVT = carregarLista(ARQUIVO_VT);
const listaAD = carregarLista(ARQUIVO_AD);
const listaDESC = carregarLista(ARQUIVO_DESC);
const listaForaRotaUsados = carregarLista(ARQUIVO_FORAROTA_USADOS);

module.exports = {
    listaVT,
    listaAD,
    listaDESC,
    listaForaRotaUsados, // Exporta o histórico carregado
    
    salvarVT: () => salvarLista(ARQUIVO_VT, listaVT),
    salvarAD: () => salvarLista(ARQUIVO_AD, listaAD),
    salvarDESC: () => salvarLista(ARQUIVO_DESC, listaDESC),
    
    // Função específica para salvar o histórico do Fora Rota
    salvarForaRotaUsados: (novaLista) => salvarLista(ARQUIVO_FORAROTA_USADOS, novaLista),
    
    // Lista de grupos onde o bot atua
    isGrupoAutorizado: (chatId) => {
        const autorizados = [
            '120363423496684075@g.us', 
            '558496022125-1485433351@g.us',
            '120363422121095440@g.us'
        ];
        return autorizados.includes(chatId);
    }
};
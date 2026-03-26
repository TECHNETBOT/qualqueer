const axios = require('axios');
const csv = require('csv-parse/sync');

// --- LINKS DAS PLANILHAS ---

// Planilha 1 (Nova)
const SHEET_1_URL = 'https://docs.google.com/spreadsheets/d/1briXyqJVDxEIPUKYAZRN-Uk60M9fijtEDFahqH1knG8/export?format=csv';

// Planilha 2 (Antiga)
const SHEET_2_URL = 'https://docs.google.com/spreadsheets/d/1ekbmoobOkE5CWkd5L_fIlXm1s_SUNOscy8Qh8TYahhQ/export?format=csv';

// Planilha Fora de Rota
const SHEET_FORAROTA_URL = 'https://docs.google.com/spreadsheets/d/1r0_l5QIlx8OaF1l19wZlkn9scNI8vZkoS4VH5jPVHjw/export?format=csv';

// Função genérica de download
async function downloadSheet(url) {
    try {
        const response = await axios.get(url, {
            timeout: 60000, 
            family: 4,      
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        return csv.parse(response.data, { columns: false, skip_empty_lines: true, trim: true });
    } catch (error) {
        console.error(`❌ Erro ao baixar planilha (${url}):`, error.message);
        return [];
    }
}

// BUSCA UNIFICADA (PLANILHA 1 + PLANILHA 2)
async function obterBaseContratos() {
    console.log('🔄 Baixando Base 1 e Base 2...');
    
    const [data1, data2] = await Promise.all([
        downloadSheet(SHEET_1_URL),
        downloadSheet(SHEET_2_URL)
    ]);

    const processarDados = (data) => {
        if (!data || data.length < 2) return [];
        const headers = data[0];
        return data.slice(1).map(row => {
            let obj = {};
            headers.forEach((h, i) => obj[h] = row[i]);
            return obj;
        });
    };

    const lista1 = processarDados(data1);
    const lista2 = processarDados(data2);

    const listaCompleta = [...lista1, ...lista2];
    console.log(`📊 Base 1: ${lista1.length} | Base 2: ${lista2.length} | TOTAL: ${listaCompleta.length}`);
    
    return listaCompleta;
}

async function obterBaseForaRota() {
    console.log('🔄 Baixando planilha FORA ROTA...');
    const data = await downloadSheet(SHEET_FORAROTA_URL);
    
    if(data.length < 1) return [];
    
    // Mapeia colunas manuais conforme seu padrão
    return data.map(row => ({
        tipo: row[0],
        contrato: row[1],
        cliente: row[2],
        endereco: row[3],
        bairro: row[4],
        cep: row[5],
        telefone: row[6]
    }));
}

module.exports = { obterBaseContratos, obterBaseForaRota };
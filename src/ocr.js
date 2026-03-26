const Tesseract = require('tesseract.js');

const lerTextoDeImagem = async (bufferImagem) => {
    try {
        console.log('👀 Processando imagem com OCR...');
        
        // Usamos 'eng' (inglês) pois funciona melhor para códigos alfanuméricos que português
        const { data: { text } } = await Tesseract.recognize(bufferImagem, 'eng', {
            logger: m => {} 
        });

        // === LIMPEZA E EXTRAÇÃO DE CÓDIGOS ===
        const linhas = text.split('\n');
        const codigosEncontrados = [];
        
        // Regex para encontrar MAC Address (12 caracteres hexa: 0-9, A-F)
        // A foto mostra MACs sem dois pontos (ex: 44D454C27427)
        const regexMAC = /[A-F0-9]{12}/g;
        
        // Regex para S/N (geralmente começa com números grandes ou misturado)
        // Na foto o S/N tem 12 dígitos numéricos
        const regexSN = /\b\d{12}\b/g; 

        linhas.forEach(linha => {
            const linhaLimpa = linha.trim().toUpperCase();
            
            // Procura MACs
            const macs = linhaLimpa.match(regexMAC);
            if (macs) {
                macs.forEach(m => {
                    // Evita duplicatas e garante que parece um MAC válido
                    if (!codigosEncontrados.some(c => c.valor === m)) {
                        let tipo = "CÓDIGO/MAC";
                        if (linhaLimpa.includes("CM MAC")) tipo = "CM MAC (Modem)";
                        else if (linhaLimpa.includes("EMTA")) tipo = "EMTA MAC (Telefone)";
                        else if (linhaLimpa.includes("WIFI")) tipo = "WIFI MAC";
                        
                        codigosEncontrados.push({ tipo, valor: m });
                    }
                });
            }

            // Procura S/N (Serial Number) se a linha tiver "S/N" ou "SN"
            if (linhaLimpa.includes("S/N") || linhaLimpa.includes("SERIAL")) {
                const parts = linhaLimpa.split(/[:\s]+/);
                parts.forEach(p => {
                    // Se a parte parece um serial (tamanho entre 10 e 15 chars) e não foi add ainda
                    if (p.length >= 10 && p.length <= 15 && !codigosEncontrados.some(c => c.valor === p)) {
                        codigosEncontrados.push({ tipo: "S/N (Serial)", valor: p });
                    }
                });
            }
        });

        return { raw: text, codigos: codigosEncontrados };

    } catch (error) {
        console.error('Erro no OCR:', error);
        return null;
    }
};

module.exports = { lerTextoDeImagem };
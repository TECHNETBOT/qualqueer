const { registerFont, createCanvas, loadImage } = require('canvas');
const path = require('path');
const fs = require('fs');

// Função auxiliar para desenhar linhas
function drawLine(ctx, x1, y1, x2, y2) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
}

// Função auxiliar para centralizar texto
// Com proteção para não estourar a largura (espreme se necessário)
function drawCenteredText(ctx, text, x, y, width) {
    const safeText = String(text || '').toUpperCase();
    const textWidth = ctx.measureText(safeText).width;
    const startX = x + (width - textWidth) / 2;
    // Se o texto for maior que a coluna, usa o parâmetro maxWidth do fillText
    ctx.fillText(safeText, startX, y, width - 8); 
}

const getFollowupText = () => 'Caso tenha mais equipamentos, separe com vírgula, ex: 123, 1D3, 34A...';

const gerarComprovanteDevolucao = async (dados) => {
    // === CONFIGURAÇÕES GERAIS ===
    const width = 1240;
    const height = 1754; 
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // MARGENS
    const margin = 100;
    const marginRight = 100;
    const contentWidth = width - margin - marginRight;

    // 1. Fundo Branco
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    // 2. Carregar Logos
    try {
        const pathTechnet = path.join(__dirname, 'assets', 'technet.png');
        const pathClaro = path.join(__dirname, 'assets', 'claro.png');
        
        if (fs.existsSync(pathTechnet)) {
            const logoTechnet = await loadImage(pathTechnet);
            // Logo Technet
            ctx.drawImage(logoTechnet, margin, 40, 250, 80); 
        }

        if (fs.existsSync(pathClaro)) {
            const logoClaro = await loadImage(pathClaro);
            // Logo Claro
            ctx.drawImage(logoClaro, width - marginRight - 120, 30, 120, 120);
        }
    } catch (e) {
        console.error("Erro ao carregar logos:", e);
    }

    // 3. Textos do Cabeçalho
    // DESCEMOS O Y PARA 170 PARA NÃO BATER NAS LOGOS
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center';
    
    ctx.font = 'bold 30px Arial';
    ctx.fillText('DEVOLUÇÃO DE EQUIPAMENTOS', width / 2, 170);

    ctx.font = '22px Arial';
    ctx.fillText('Em loja CLARO (TECHNET)', width / 2, 210);

    // Alinhamento à esquerda
    ctx.textAlign = 'left';
    ctx.font = '20px Arial';
    ctx.fillText('Produto / Empresa', margin, 260);
    
    // Checkbox
    ctx.font = '22px Arial';
    ctx.fillText('CLARO TV ( _ )   NET ( X )', margin, 300);

    // ==========================================
    // 4. TABELA 1: Contrato, Nome, Data
    // ==========================================
    const startY_Table1 = 340;
    const rowHeight = 45;
    
    // Colunas
    const col1_w = contentWidth * 0.20; // 20%
    const col3_w = contentWidth * 0.20; // 20%
    const col2_w = contentWidth - col1_w - col3_w; // 60%

    const t1_x1 = margin;
    const t1_x2 = t1_x1 + col1_w;
    const t1_x3 = t1_x2 + col2_w;
    const t1_x4 = t1_x3 + col3_w; 

    ctx.lineWidth = 2;
    ctx.strokeStyle = '#000000';

    // Linhas Horizontais
    drawLine(ctx, t1_x1, startY_Table1, t1_x4, startY_Table1);
    drawLine(ctx, t1_x1, startY_Table1 + rowHeight, t1_x4, startY_Table1 + rowHeight);
    drawLine(ctx, t1_x1, startY_Table1 + (rowHeight * 2), t1_x4, startY_Table1 + (rowHeight * 2));
    // Linhas Verticais
    [t1_x1, t1_x2, t1_x3, t1_x4].forEach(x => drawLine(ctx, x, startY_Table1, x, startY_Table1 + (rowHeight * 2)));

    // Texto Header Tabela 1
    ctx.font = 'bold 18px Arial';
    const textY_Header1 = startY_Table1 + 28;
    
    drawCenteredText(ctx, 'CONTRATO', t1_x1, textY_Header1, col1_w);
    drawCenteredText(ctx, 'NOME DO CLIENTE', t1_x2, textY_Header1, col2_w);
    drawCenteredText(ctx, 'DATA', t1_x3, textY_Header1, col3_w);

    // Texto Dados Tabela 1
    ctx.font = '20px Arial';
    const textY_Data1 = startY_Table1 + rowHeight + 28;
    
    drawCenteredText(ctx, dados.contrato, t1_x1, textY_Data1, col1_w);
    drawCenteredText(ctx, dados.nomeCliente, t1_x2, textY_Data1, col2_w);
    drawCenteredText(ctx, dados.data, t1_x3, textY_Data1, col3_w);

    // ==========================================
    // 5. TABELA 2: Equipamentos (AJUSTADO)
    // ==========================================
    const startY_Table2 = 460;
    
    // NOVO AJUSTE DE COLUNAS:
    // Modelo: Aumentado para 30% (pra caber "MODELO EQUIPAMENTO")
    // Serial: Diminuído para 26% (como pediste)
    // Resto: 44% dividido por 4 colunas = 11% cada.
    const c2_1 = contentWidth * 0.30; 
    const c2_2 = contentWidth * 0.26; 
    const c2_rest = (contentWidth - c2_1 - c2_2) / 4; 

    const tx1 = margin;
    const tx2 = tx1 + c2_1;
    const tx3 = tx2 + c2_2;
    const tx4 = tx3 + c2_rest;
    const tx5 = tx4 + c2_rest;
    const tx6 = tx5 + c2_rest;
    const tx7 = tx6 + c2_rest;

    const listaEquips = dados.equipamentos || [];
    const minRows = 8; 
    const totalRows = Math.max(listaEquips.length, minRows);

    // Linhas Topo
    drawLine(ctx, tx1, startY_Table2, tx7, startY_Table2);
    drawLine(ctx, tx1, startY_Table2 + rowHeight, tx7, startY_Table2 + rowHeight);

    // Verticais Header
    [tx1, tx2, tx3, tx4, tx5, tx6, tx7].forEach(x => {
        drawLine(ctx, x, startY_Table2, x, startY_Table2 + rowHeight);
    });

    // Texto Header Tabela 2
    // Reduzi para 14px BOLD para garantir que palavras como "EQUIPAMENTO" caibam
    ctx.font = 'bold 14px Arial'; 
    const textY_Header2 = startY_Table2 + 28;
    
    drawCenteredText(ctx, 'MODELO EQUIPAMENTO', tx1, textY_Header2, c2_1);
    drawCenteredText(ctx, 'NÚMERO SERIAL', tx2, textY_Header2, c2_2);
    drawCenteredText(ctx, 'EQUIPAMENTO', tx3, textY_Header2, c2_rest);
    drawCenteredText(ctx, 'FONTE', tx4, textY_Header2, c2_rest);
    drawCenteredText(ctx, 'CTRL REMOTO', tx5, textY_Header2, c2_rest);
    drawCenteredText(ctx, 'CABOS', tx6, textY_Header2, c2_rest);

    // Dados Tabela 2
    ctx.font = '20px Arial'; // Dados continuam grandes
    
    for (let i = 0; i < totalRows; i++) {
        const yLine = startY_Table2 + rowHeight + (i * rowHeight);
        const yText = yLine + 30;
        const yBottom = yLine + rowHeight;

        drawLine(ctx, tx1, yBottom, tx7, yBottom);

        [tx1, tx2, tx3, tx4, tx5, tx6, tx7].forEach(x => {
            drawLine(ctx, x, yLine, x, yBottom);
        });

        if (i < listaEquips.length) {
            const itemAtual = listaEquips[i];
            
            drawCenteredText(ctx, itemAtual.modelo, tx1, yText, c2_1);
            drawCenteredText(ctx, itemAtual.serial, tx2, yText, c2_2);
            
            drawCenteredText(ctx, '-', tx3, yText, c2_rest);
            drawCenteredText(ctx, '-', tx4, yText, c2_rest);
            drawCenteredText(ctx, '-', tx5, yText, c2_rest);
            drawCenteredText(ctx, '-', tx6, yText, c2_rest);
        }
    }

    // ==========================================
    // 6. Rodapé e Assinaturas
    // ==========================================
    const footerStartY = startY_Table2 + rowHeight + (totalRows * rowHeight) + 60;

    ctx.textAlign = 'left';
    ctx.font = '16px Arial';
    
    ctx.fillText('Declaro para os devidos fins que o(s) equipamento(s) acima foi(foram) devolvido(s) para a CLARO/NET conforme especificações.', margin, footerStartY);
    ctx.fillText('Estou ciente da taxa caso o(s) equipamento(s) e/ou acessório(s) esteja(m) danificado(s), inutilizado(s), ou não for(am) entregue(s).', margin, footerStartY + 30);

    // Assinaturas
    const signY = footerStartY + 150;
    const signLineWidth = 400;
    
    // Esquerda (Técnico)
    const signTechStartX = margin;
    const signTechEndX = margin + signLineWidth;
    drawLine(ctx, signTechStartX, signY, signTechEndX, signY);
    
    ctx.font = 'bold 18px Arial';
    drawCenteredText(ctx, dados.tecnico, signTechStartX, signY - 10, signLineWidth);
    
    ctx.font = '16px Arial';
    drawCenteredText(ctx, 'Assinatura do Representante Loja/Technet', signTechStartX, signY + 25, signLineWidth);

    // Direita (Cliente)
    const signClientEndX = width - marginRight;
    const signClientStartX = signClientEndX - signLineWidth;
    drawLine(ctx, signClientStartX, signY, signClientEndX, signY);
    drawCenteredText(ctx, 'Assinatura do cliente ou Preposto que fez a entrega', signClientStartX, signY + 25, signLineWidth);

    return canvas.toBuffer();
};

module.exports = { gerarComprovanteDevolucao, getFollowupText };
#!/usr/bin/env python3
"""
barcode.py — lê códigos de barra de uma imagem
Uso: python3 barcode.py <caminho_imagem>
Saída JSON: [{"tipo": "CM MAC", "valor": "E820E2C5C7A3"}, ...]
"""
import sys, json
from PIL import Image, ImageEnhance, ImageFilter, ImageOps

try:
    from pyzbar.pyzbar import decode as pyzbar_decode
    PYZBAR_OK = True
except ImportError:
    PYZBAR_OK = False

try:
    import zxingcpp
    ZXING_OK = True
except ImportError:
    ZXING_OK = False

if not PYZBAR_OK and not ZXING_OK:
    print(json.dumps({'error': 'Nenhum leitor disponível. Rode: pip install pyzbar --break-system-packages'}))
    sys.exit(1)


def decodificar_imagem(img):
    """Tenta decodificar com pyzbar e/ou zxingcpp."""
    vistos = set()
    resultados = []

    def adicionar(t):
        t = t.strip()
        if t and t not in vistos:
            vistos.add(t)
            resultados.append(t)

    if PYZBAR_OK:
        try:
            for obj in pyzbar_decode(img):
                adicionar(obj.data.decode('utf-8', errors='ignore'))
        except Exception:
            pass

    if ZXING_OK:
        try:
            for r in zxingcpp.read_barcodes(img):
                adicionar(r.text)
        except Exception:
            pass

    return resultados


def gerar_variantes(img):
    """Gera variantes de pré-processamento para aumentar chances de leitura."""
    w, h = img.size
    variantes = []

    # Escalas
    for fator in [1, 2, 3]:
        variantes.append(img.resize((w * fator, h * fator), Image.LANCZOS))

    base2 = img.resize((w * 2, h * 2), Image.LANCZOS)
    base3 = img.resize((w * 3, h * 3), Image.LANCZOS)

    # Grayscale
    variantes.append(base2.convert('L').convert('RGB'))
    variantes.append(base3.convert('L').convert('RGB'))

    # Binarização com vários thresholds
    gray2 = base2.convert('L')
    gray3 = base3.convert('L')
    for thresh in [80, 100, 115, 128, 140, 160]:
        variantes.append(gray2.point(lambda x, t=thresh: 0 if x < t else 255).convert('RGB'))
        variantes.append(gray3.point(lambda x, t=thresh: 0 if x < t else 255).convert('RGB'))

    # Invertido
    variantes.append(ImageOps.invert(base2.convert('L')).convert('RGB'))

    # Contraste + sharpen
    variantes.append(ImageEnhance.Contrast(base2).enhance(2.0))
    variantes.append(ImageEnhance.Contrast(base2).enhance(3.0))
    variantes.append(base2.filter(ImageFilter.SHARPEN).filter(ImageFilter.SHARPEN))
    variantes.append(base3.filter(ImageFilter.SHARPEN).filter(ImageFilter.SHARPEN))

    # Equalização
    try:
        variantes.append(ImageOps.equalize(gray2).convert('RGB'))
        variantes.append(ImageOps.equalize(gray3).convert('RGB'))
    except Exception:
        pass

    # Rotações leves
    for angulo in [-2, 2, -5, 5]:
        variantes.append(base2.rotate(angulo, expand=True, fillcolor=(255, 255, 255)))

    return variantes


def recortar_regioes(img):
    """Recorta faixas claras (etiquetas) e quadrantes."""
    regioes = []
    try:
        gray  = img.convert('L')
        w, h  = gray.size
        pixels = list(gray.getdata())

        # Agrupa linhas com pixel médio claro (> 160)
        linhas_claras = [sum(pixels[y*w:(y+1)*w]) / w > 160 for y in range(h)]
        grupos = []
        inicio = None
        for y, clara in enumerate(linhas_claras):
            if clara and inicio is None:
                inicio = y
            elif not clara and inicio is not None:
                if y - inicio > 15:
                    grupos.append((inicio, y))
                inicio = None
        if inicio is not None and h - inicio > 15:
            grupos.append((inicio, h))

        margem = 10
        for (y0, y1) in grupos:
            crop = img.crop((0, max(0, y0 - margem), w, min(h, y1 + margem)))
            if crop.width > 30 and crop.height > 10:
                regioes.append(crop)

        # Quadrantes
        mid_h, mid_w = h // 2, w // 2
        for box in [(0, 0, w, mid_h), (0, mid_h, w, h), (0, 0, mid_w, h), (mid_w, 0, w, h)]:
            q = img.crop(box)
            if q.width > 20 and q.height > 10:
                regioes.append(q)

    except Exception:
        pass

    return regioes


def inferir_tipo(valor):
    v = valor.strip().upper()
    if len(v) == 12 and all(c in '0123456789ABCDEF' for c in v):
        return 'MAC'
    if v.startswith('11') and len(v) >= 15:
        return 'S/N'
    if v.isdigit() and len(v) >= 10:
        return 'S/N'
    return 'CÓDIGO'


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Informe o caminho da imagem'}))
        sys.exit(1)

    path = sys.argv[1]
    try:
        img = Image.open(path).convert('RGB')
    except Exception as e:
        print(json.dumps({'error': f'Não consegui abrir imagem: {e}'}))
        sys.exit(1)

    vistos  = set()
    valores = []

    def adicionar(v):
        if v and v not in vistos:
            vistos.add(v)
            valores.append(v)

    # 1) Imagem completa — todas as variantes
    for v in gerar_variantes(img):
        for cod in decodificar_imagem(v):
            adicionar(cod)

    # 2) Recortes de regiões claras + quadrantes
    for regiao in recortar_regioes(img):
        for v in gerar_variantes(regiao):
            for cod in decodificar_imagem(v):
                adicionar(cod)

    if not valores:
        print(json.dumps({'error': 'Nenhum código de barras detectado'}))
        sys.exit(1)

    resultados = [{'tipo': inferir_tipo(v), 'valor': v.strip().upper()} for v in valores]
    print(json.dumps(resultados, ensure_ascii=False))


if __name__ == '__main__':
    main()
"""POP! BATTLE 로고를 글꼴 없이 그리는 SVG로 (로딩 화면용).

로비 로고(src/ui/lobby/Lobby.ts LOGO_SVG)와 같은 배치·색이지만 글자를 Jua 윤곽선(path)으로 바꿔
게임 글꼴(약 350KB)이 오기 전, 첫 화면부터 바로 보이게 한다.

사용: python tools/make_logo_svg.py  → src/ui/loading/logo.svg
"""
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
FONT = ROOT / 'src/ui/lobby/fonts/Jua-Regular.woff2'
OUT = ROOT / 'src/ui/loading/logo.svg'

font = TTFont(str(FONT))
cmap = font.getBestCmap()
glyphs = font.getGlyphSet()
upm = font['head'].unitsPerEm
hmtx = font['hmtx']


def text_path(text: str, cx: float, baseline: float, size: float, spacing: float) -> str:
    """text-anchor=middle 글자 한 줄 → path d (SVG 글자와 같은 기준: 글자마다 letter-spacing을 뒤에 더함)"""
    scale = size / upm
    names = [cmap[ord(ch)] for ch in text]
    width = sum(hmtx[n][0] * scale + spacing for n in names)
    x = cx - width / 2
    pen = SVGPathPen(glyphs, ntos=lambda v: f'{v:.1f}'.rstrip('0').rstrip('.'))
    for n in names:
        glyphs[n].draw(TransformPen(pen, (scale, 0, 0, -scale, x, baseline)))
        x += hmtx[n][0] * scale + spacing
    return pen.getCommands()


pop = text_path('POP!', 105, 68, 66, -1)
battle = text_path('BATTLE', 105, 106, 31, 1)

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 210 116">
<defs>
<linearGradient id="p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff27a"/><stop offset=".55" stop-color="#ffd23f"/><stop offset="1" stop-color="#ffb21c"/></linearGradient>
<linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#dbeeff"/></linearGradient>
<path id="tp" d="{pop}"/>
<path id="tb" d="{battle}"/>
</defs>
<g stroke-linejoin="round" paint-order="stroke">
<g transform="rotate(-4 105 50)">
<use href="#tp" fill="#1b4bb5" stroke="#1b4bb5" stroke-width="14" transform="translate(0 5)"/>
<use href="#tp" fill="url(#p)" stroke="#2f73e8" stroke-width="10"/>
</g>
<use href="#tb" fill="#1b4bb5" stroke="#1b4bb5" stroke-width="10" transform="translate(0 4)"/>
<use href="#tb" fill="url(#b)" stroke="#2f73e8" stroke-width="7"/>
</g>
</svg>
'''
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(svg, encoding='utf-8')
print(OUT, len(svg), 'bytes')

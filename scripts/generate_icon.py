"""アプリアイコン生成(1回限りのユーティリティ、requirements.txtには追加しない)。
ドリルビット(らせん状の溝を持つ先端工具)をモチーフにし、Drillという名前と
「繰り返し問題を解いて定着させる」機能の両方を反映する。既定の汎用アイコンは使わない。"""

import math
from PIL import Image, ImageDraw

SIZE = 1024
BG = (23, 25, 35, 255)       # #171923
FG = (240, 168, 104, 255)    # #f0a868
STROKE = (23, 25, 35, 255)

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# 背景(角丸正方形)
draw.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=200, fill=BG)

# ドリルビットのシルエット(shank + 胴 + 先端の3パーツをmaskで結合)
mask = Image.new("L", (SIZE, SIZE), 0)
mdraw = ImageDraw.Draw(mask)
mdraw.rounded_rectangle([472, 150, 552, 300], radius=20, fill=255)  # シャンク
mdraw.polygon(
    [(400, 290), (624, 290), (624, 740), (512, 880), (400, 740)],
    fill=255,
)  # 胴体+先端

# 胴体をアンバー一色で塗った上に、らせんの溝を表す斜めストライプを引く
fill_layer = Image.new("RGBA", (SIZE, SIZE), FG)
fdraw = ImageDraw.Draw(fill_layer)
slope = -0.62
stripe_width = 30
spacing = 76
x1, x2 = -300, 1300
c = -900
while c < 1900:
    y1 = x1 * slope + c
    y2 = x2 * slope + c
    fdraw.line([(x1, y1), (x2, y2)], fill=STROKE, width=stripe_width)
    c += spacing

img.paste(fill_layer, (0, 0), mask)

# シルエット全体に細い縁取りを追加して輪郭を締める
outline = Image.new("L", (SIZE, SIZE), 0)
odraw = ImageDraw.Draw(outline)
odraw.rounded_rectangle([472, 150, 552, 300], radius=20, outline=255, width=10)
odraw.polygon([(400, 290), (624, 290), (624, 740), (512, 880), (400, 740)], outline=255, width=10)
outline_layer = Image.new("RGBA", (SIZE, SIZE), (18, 14, 8, 255))
img.paste(outline_layer, (0, 0), outline)

for size, name in [(512, "icon-512.png"), (192, "icon-192.png")]:
    resized = img.resize((size, size), Image.LANCZOS)
    resized.save(f"static/{name}")
    print(f"saved static/{name}")

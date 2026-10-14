// Crea el logo MARCA DE AGUA con fondo transparente a partir de logo.jpg.
//
// ── Por qué ─────────────────────────────────────────────────────────────────
// logo.jpg es la insignia cuadrada: un disco azul marino con "CIENCIA COOL" y
// el robot dentro, sobre un fondo TURQUESA SÓLIDO que ocupa toda la esquina.
// En el video eso se ve como un cuadrado de color pegado en la esquina, no
// como la insignia circular que el canal usaba en los videos anteriores.
//
// Aquí se recorta ese turquesa: se detecta el color exacto de la esquina y
// todo píxel de ese color se vuelve transparente, con un borde suavizado para
// que no quede un escalón dentado contra el disco.
//
// ── Cómo ────────────────────────────────────────────────────────────────────
// 1. Se lee el color de la esquina (el turquesa de fondo).
// 2. Por cada píxel se mide la distancia a ese color.
//      dist < 25   -> totalmente fondo      (alpha 0)
//      dist > 70   -> totalmente insignia   (alpha 255)
//      entre las dos -> rampa lineal (antialias de 2 px)
// 3. Se escribe public/assets/logo.png con canal alfa.
const sharp = require('sharp');
const fs = require('fs');

const ORIGEN = 'public/assets/logo.jpg';
const DESTINO = 'public/assets/logo.png';

(async () => {
  const { data, info } = await sharp(ORIGEN)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const at = (x, y) => {
    const o = (y * width + x) * channels;
    return [data[o], data[o + 1], data[o + 2]];
  };

  // Color de fondo: esquina superior izquierda, con un pequeño margen para no
  // pillar un píxel comprimido raro.
  const fondo = at(6, 6);
  console.log('color de fondo (turquesa):', fondo.join(','));

  const rgba = Buffer.alloc(width * height * 4);
  let fuera = 0, dentro = 0;

  // Caja que envuelve lo que NO es fondo, para saber de qué tamaño es la
  // insignia dentro del cuadrado (solo informativo).
  let minX = width, minY = height, maxX = -1, maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * channels;
      const d = (y * width + x) * 4;
      const r = data[o], g = data[o + 1], b = data[o + 2];

      const dist = Math.max(
        Math.abs(r - fondo[0]),
        Math.abs(g - fondo[1]),
        Math.abs(b - fondo[2])
      );

      let a;
      if (dist <= 25) a = 0;
      else if (dist >= 70) a = 255;
      else a = Math.round(((dist - 25) / 45) * 255);

      if (a > 12) {
        dentro++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      } else {
        fuera++;
      }

      rgba[d] = r;
      rgba[d + 1] = g;
      rgba[d + 2] = b;
      rgba[d + 3] = a;
    }
  }

  console.log(
    `insignia: ${dentro} px (${((dentro / (width * height)) * 100).toFixed(1)}%) ` +
    `en caja ${maxX - minX + 1}x${maxY - minY + 1} en (${minX},${minY})`
  );

  await sharp(rgba, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toFile(DESTINO);

  console.log('escrito: ' + DESTINO + ' (' + (fs.statSync(DESTINO).size / 1024).toFixed(0) + ' KB)');

  // Recorte para revisar el corte sobre un fondo rojo.
  await sharp({ create: { width: 500, height: 500, channels: 4, background: { r: 200, g: 60, b: 60, alpha: 1 } } })
    .composite([{ input: await sharp(DESTINO).resize(480, 480, { fit: 'contain' }).png().toBuffer(), left: 10, top: 10 }])
    .png()
    .toFile('outputs/_logo_alpha_check.png');
  console.log('revision: outputs/_logo_alpha_check.png');
})();

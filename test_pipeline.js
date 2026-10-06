// Prueba del endpoint de pipeline automático. No genera videos: usa dryRun para
// validar la configuración y comprobar la seguridad, que es lo que se puede
// comprobar rápido y sin gastar cuota.
//
//   npm run test:pipeline                     -> contra producción
//   node test_pipeline.js http://localhost:3000 -> contra local
//
// Para una prueba de fuego de verdad (sí genera el MP4, ~3 min):
//   node test_pipeline.js --real
//
// La clave se lee de la variable PIPELINE_KEY o de outputs/key.txt, que está en
// .gitignore y nunca se sube.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const base = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2].replace(/\/$/, '')
  : 'https://ciencia-cool-studio-271857970093.us-central1.run.app';

const real = process.argv.includes('--real');

const KEY = process.env.PIPELINE_KEY
  || (fs.existsSync(path.join(__dirname, 'outputs', 'key.txt'))
    ? fs.readFileSync(path.join(__dirname, 'outputs', 'key.txt'), 'utf8').trim()
    : '');

let fallos = 0;
const chk = (nombre, cond, extra = '') => {
  if (!cond) fallos++;
  console.log(`  ${cond ? '✅' : '❌'} ${nombre}${extra ? ` → ${extra}` : ''}`);
};

async function post(body, headers = {}) {
  const res = await fetch(`${base}/api/pipeline-completo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

(async () => {
  console.log(`\n🎬 Prueba del pipeline contra ${base}\n`);

  if (!KEY) {
    console.log('⚠️  No hay PIPELINE_KEY. Defínela o deja outputs/key.txt.');
    console.log('    Solo se pueden probar los rechazos de seguridad.\n');
  }

  // ── 1. Seguridad ──────────────────────────────────────────────────────────
  console.log('1. Seguridad (la clave debe ser obligatoria)');
  {
    const r = await post({ categoria: 'ciencia' });
    chk('sin clave → 401', r.status === 401, `HTTP ${r.status}`);
  }
  {
    const r = await post({ categoria: 'ciencia' }, { 'X-Pipeline-Key': 'clave-inventada' });
    chk('clave incorrecta → 401', r.status === 401, `HTTP ${r.status}`);
  }

  if (!KEY) {
    console.log('\nSin clave no se puede seguir.\n');
    process.exit(fallos ? 1 : 0);
  }

  {
    const r = await post({ categoria: 'ciencia', dryRun: true }, { 'X-Pipeline-Key': KEY });
    chk('clave correcta + dryRun → 200', r.status === 200, `HTTP ${r.status}`);
    chk('devuelve dryRun', r.json?.data?.dryRun === true);
    chk('valida la categoría', r.json?.data?.categoriaValida === true);
    chk('no genera video en ensayo', !r.json?.data?.videoUrl);
  }

  // ── 2. Validación de entradas ─────────────────────────────────────────────
  console.log('\n2. Validación de entradas');
  {
    const r = await post({ categoria: 'categoria-inventada', dryRun: true }, { 'X-Pipeline-Key': KEY });
    chk('categoría inválida se marca como tal', r.json?.data?.categoriaValida === false);
    chk('no rompe el servidor', r.status === 200, `HTTP ${r.status}`);
  }
  {
    const r = await post({ dryRun: true }, { 'X-Pipeline-Key': KEY });
    chk('sin categoría → rotación automática', r.json?.data?.categoriaPedida === '(rotación automática)');
  }
  {
    const r = await post({ topic: 'un tema fijo', dryRun: true }, { 'X-Pipeline-Key': KEY });
    chk('con topic → lo respeta', r.json?.data?.temaPrevisto === 'un tema fijo');
  }

  // ── 3. Estado ─────────────────────────────────────────────────────────────
  console.log('\n3. Endpoint de estado');
  {
    const res = await fetch(`${base}/api/pipeline-completo/status`, {
      headers: { 'X-Pipeline-Key': KEY },
    });
    const j = await res.json();
    chk('responde 200', res.status === 200, `HTTP ${res.status}`);
    chk('marca la clave como configurada', j.pipelineKeyConfigured === true);
    chk('autoriza la clave buena', j.authorized === true);
    chk('informa de la ocupación', typeof j.ocupado?.enCurso === 'number', JSON.stringify(j.ocupado));
    chk('informa de los videos en disco', typeof j.videosEnDisco === 'number', `${j.videosEnDisco} en disco`);
  }

  // ── 4. Prueba de fuego (opcional) ─────────────────────────────────────────
  if (real) {
    console.log('\n4. Prueba de fuego: generando un video de verdad (~3 min)…');
    const jobId = `test-${Date.now()}`;
    const t0 = Date.now();
    const r = await post({ categoria: 'ciencia', jobId }, { 'X-Pipeline-Key': KEY });
    const d = r.json?.data || {};
    console.log(`   ${r.status} en ${Math.round((Date.now() - t0) / 1000)}s`);
    chk('devuelve video', Boolean(d.videoUrl));
    chk('URL absoluta https', String(d.videoUrlAbsoluta).startsWith('https://'));
    chk('cabe en el límite de 32 MB de Cloud Run', (d.sizeBytes || 1e9) < 32 * 1024 * 1024,
      `${((d.sizeBytes || 0) / 1048576).toFixed(1)} MB`);
    chk('tiene título', (d.title || '').length > 5, d.title);
    chk('tiene descripción', (d.description || '').length > 60);
    chk('caption corto para TikTok/IG', (d.caption || '').length <= 300);
    chk('hashtags', (d.hashtags || []).length >= 3);
    chk('el video se descarga', await (async () => {
      try {
        const v = await fetch(d.videoUrlAbsoluta, { method: 'HEAD' });
        return v.status === 200;
      } catch { return false; }
    })());

    // Reintento con el mismo jobId: debe devolver el anterior, no regenerar.
    const r2 = await post({ categoria: 'ciencia', jobId }, { 'X-Pipeline-Key': KEY });
    chk('reintento con el mismo jobId reutiliza', r2.json?.data?.reutilizado === true);
    chk('y devuelve el mismo archivo', r2.json?.data?.videoFilename === d.videoFilename);
  } else {
    console.log('\n4. Prueba de fuego: OMITIDA (añade --real para ejecutarla)');
  }

  console.log(`\n${fallos ? `❌ ${fallos} fallo(s)` : '✅ Todo correcto'}\n`);
  process.exit(fallos ? 1 : 0);
})();
import { generateScriptWithGemini } from './src/services/geminiService.js';

async function run() {
  try {
    const script = await generateScriptWithGemini({
      topic: 'GTA VI retraso o limitaciones',
      newsContext: 'GTA VI: a dos meses de su salida el juego de Rockstar muestra limitaciones.',
      format: 'noticia_resumida'
    });
    console.log('Generated script successfully:', script.title);
    console.log('Hook narration:', script.hook?.narration);
  } catch (err) {
    console.error('Error running test:', err);
  }
}

run();


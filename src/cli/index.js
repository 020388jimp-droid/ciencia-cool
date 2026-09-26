import { Command } from 'commander';
import pc from 'picocolors';
import dotenv from 'dotenv';
import { fetchAllNews } from '../services/newsService.js';
import { fetchNasaAPOD } from '../services/nasaService.js';
import { fetchTodayScienceHistory, getLegendaryScienceMilestones } from '../services/historyService.js';
import { generateScriptWithGemini } from '../services/geminiService.js';
import { saveScript } from '../services/storageService.js';

dotenv.config();

const program = new Command();

program
  .name('ciencia-cool')
  .description('Herramienta de automatización de contenidos de CIENCIA COOL')
  .version('1.1.0');

// Comando para listar noticias ampliadas
program
  .command('news')
  .description('Buscar y listar las últimas noticias de ciencia, astronomía y tecnología')
  .action(async () => {
    console.log(pc.cyan('\n📡 Buscando noticias recientes en español (SINC, ESA, Google News, Microsiervos, Xataka)...\n'));
    const news = await fetchAllNews();
    
    if (news.length === 0) {
      console.log(pc.yellow('No se encontraron noticias en este momento.'));
      return;
    }

    news.forEach((item, index) => {
      console.log(pc.green(`[${index + 1}] ${item.title}`));
      console.log(pc.dim(`    Fuente: ${item.source} | Categoría: ${item.category} | Fecha: ${item.pubDate}`));
      console.log(pc.dim(`    Link: ${item.link}\n`));
    });
  });

// Comando para ver efemérides científicas históricas
program
  .command('history')
  .description('Consultar acontecimientos y efemérides históricas de la ciencia para el día de hoy')
  .action(async () => {
    console.log(pc.cyan('\n📜 Consultando acontecimientos históricos de la ciencia ("Un día como hoy")...\n'));
    const events = await fetchTodayScienceHistory();

    events.forEach((ev, index) => {
      console.log(pc.bold(pc.magenta(`[${index + 1}] Año ${ev.year} - ${ev.type}`)));
      console.log(pc.white(`    ${ev.title}`));
      console.log(pc.dim(`    ${ev.description}\n`));
    });
  });

// Comando para ver NASA APOD
program
  .command('nasa')
  .description('Consultar la Imagen Astronómica del Día de la NASA')
  .action(async () => {
    console.log(pc.cyan('\n🌌 Consultando Astronomy Picture of the Day (NASA)...\n'));
    const apod = await fetchNasaAPOD();
    if (!apod) {
      console.log(pc.red('No se pudo obtener la información de la NASA.'));
      return;
    }
    console.log(pc.bold(pc.magenta(`🚀 ${apod.title} (${apod.date})`)));
    console.log(pc.white(`\n${apod.explanation}\n`));
    console.log(pc.cyan(`🔗 URL de la imagen: ${apod.hdurl || apod.url}\n`));
  });

// Comando para generar guion automático (Noticia o Historia)
program
  .command('auto')
  .description('Genera automáticamente un guion de video (por defecto noticia, o usa --history para un hito histórico)')
  .option('-h, --history', 'Generar guion sobre un acontecimiento histórico de la ciencia')
  .action(async (options) => {
    console.log(pc.cyan('\n🤖 Iniciando pipeline automático de CIENCIA COOL...\n'));

    if (options.history) {
      console.log(pc.dim('1. Consultando efemérides históricas de la ciencia...'));
      const historyEvents = await fetchTodayScienceHistory();
      const topEvent = historyEvents[0] || getLegendaryScienceMilestones()[0];

      console.log(pc.green(`\n📌 Acontecimiento Histórico seleccionado: ${topEvent.title}`));
      console.log(pc.dim(`   Tipo: ${topEvent.type} (Año ${topEvent.year})`));

      console.log(pc.cyan('\n✨ Redactando guion histórico con Google Gemini...'));
      try {
        const script = await generateScriptWithGemini({
          topic: topEvent.title,
          newsContext: topEvent.description,
          format: 'historia_ciencia'
        });

        const saved = saveScript(script);
        console.log(pc.bold(pc.green(`\n✅ ¡Guion histórico generado exitosamente para CIENCIA COOL!`)));
        console.log(pc.white(`📝 Título: ${script.title}`));
        console.log(pc.dim(`⏱️ Duración estimada: ~${script.estimatedDurationSec} segundos`));
        console.log(pc.cyan(`📄 Guardado en Markdown: ${saved.mdPath}`));
        console.log(pc.cyan(`💾 Guardado en JSON: ${saved.jsonPath}\n`));
      } catch (err) {
        console.log(pc.red(`❌ Error: ${err.message}`));
      }
      return;
    }

    console.log(pc.dim('1. Buscando noticias y eventos astronómicos...'));
    const news = await fetchAllNews();

    if (news.length === 0) {
      console.log(pc.red('No se pudieron obtener noticias para generar el guion.'));
      return;
    }

    const topNews = news[0];
    console.log(pc.green(`\n📌 Noticia seleccionada: ${topNews.title}`));
    console.log(pc.dim(`   Fuente: ${topNews.source}`));

    console.log(pc.cyan('\n✨ Redactando guion viral con Google Gemini...'));
    try {
      const script = await generateScriptWithGemini({
        topic: topNews.title,
        newsContext: `${topNews.snippet} (Fuente: ${topNews.source})`,
        format: topNews.category === 'astronomia' ? 'evento_astronomico' : '5_cosas'
      });

      const saved = saveScript(script);
      console.log(pc.bold(pc.green(`\n✅ ¡Guion generado exitosamente para CIENCIA COOL!`)));
      console.log(pc.white(`📝 Título: ${script.title}`));
      console.log(pc.dim(`⏱️ Duración estimada: ~${script.estimatedDurationSec} segundos`));
      console.log(pc.cyan(`📄 Guardado en Markdown: ${saved.mdPath}`));
      console.log(pc.cyan(`💾 Guardado en JSON: ${saved.jsonPath}\n`));
    } catch (err) {
      console.log(pc.red(`❌ Error al generar el guion: ${err.message}`));
    }
  });

program.parse(process.argv);

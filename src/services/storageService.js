import fs from 'fs';
import path from 'path';

export function saveScript(scriptData) {
  const scriptsDir = path.resolve('outputs', 'scripts');
  if (!fs.existsSync(scriptsDir)) {
    fs.mkdirSync(scriptsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = (scriptData.title || 'video').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
  const baseName = `${timestamp}_${slug}`;

  // 1. Guardar JSON
  const jsonPath = path.join(scriptsDir, `${baseName}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(scriptData, null, 2), 'utf8');

  // 2. Guardar versión legible en Markdown
  let md = "# 🚀 CIENCIA COOL - Guion de Video\n\n";
  md += "**Título:** " + (scriptData.title || '') + "\n";
  md += "**Duración estimada:** ~" + (scriptData.estimatedDurationSec || 50) + " segundos\n\n";
  md += "---\n\n";
  md += "### 🎣 GANCHO (0 - 3s)\n";
  md += "🎙️ **Voz:** \"" + (scriptData.hook?.narration || '') + "\"\n";
  md += "🎬 **Visual:** " + (scriptData.hook?.visualDescription || '') + "\n\n";
  md += "---\n\n";
  md += "### 📽️ ESCENAS Y DATOS\n\n";

  if (Array.isArray(scriptData.scenes)) {
    scriptData.scenes.forEach((scene, i) => {
      md += "#### 🔹 " + (scene.badge || `Escena ${i + 1}`) + "\n";
      md += "🎙️ **Voz:** " + (scene.narration || '') + "\n";
      md += "📝 **En pantalla:** `" + (scene.onscreenText || '') + "`\n";
      md += "🎬 **Visual:** " + (scene.visualDescription || '') + " *(Keywords: " + (scene.visualKeywords?.join(', ') || '') + ")*\n\n";
    });
  }

  md += "---\n\n";
  md += "### 📢 LLAMADO A LA ACCIÓN (CTA)\n";
  md += "🎙️ **Voz:** \"" + (scriptData.callToAction?.narration || '') + "\"\n";
  md += "🏷️ **Hashtags:** " + (scriptData.hashtags?.join(' ') || '') + "\n";

  const mdPath = path.join(scriptsDir, `${baseName}.md`);
  fs.writeFileSync(mdPath, md, 'utf8');

  return { jsonPath, mdPath, baseName };
}

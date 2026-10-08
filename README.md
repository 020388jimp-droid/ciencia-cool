# 🚀 CIENCIA COOL - Video Automation Platform

Plataforma automatizada para la creación de contenido audiovisual de ciencia, astronomía y tecnología para **CIENCIA COOL** (Shorts, Reels, TikTok, Facebook y X).

## 📋 Comandos Disponibles

- `npm run news` : Busca las últimas noticias científicas y astronómicas en español.
- `npm run nasa` : Obtiene la imagen y efeméride del día de la NASA.
- `npm run auto` : Selecciona la mejor noticia y genera un guion viral completo estructurado en JSON y Markdown.

## 🔑 Configuración de API Keys (100% Gratuitas)
Edita el archivo `.env` y coloca tus claves gratuitas:
```env
GEMINI_API_KEY=tu_clave_de_gemini_aqui
NASA_API_KEY=DEMO_KEY
PEXELS_API_KEY=tu_clave_de_pexels
PIXABAY_API_KEY=tu_clave_de_pixabay
PIPELINE_KEY=una_clave_larga_y_aleatoria
```
- **Gemini** (guiones): [Google AI Studio](https://aistudio.google.com/app/apikey)
- **Pexels / Pixabay** (video de stock): sin al menos una, los videos salen con
  tarjetas de título en lugar de imágenes reales.
- **PIPELINE_KEY**: protege el endpoint de publicación automática. Ver abajo.

## 🤖 Pipeline automático (para publicar sin abrir el navegador)

`POST /api/pipeline-completo` hace todo el trabajo de una vez: elige una noticia,
escribe el guion, sintetiza la voz, busca el video de stock y renderiza el MP4.
Devuelve un JSON con el video y el texto listo para publicar en cada red.

**Requiere la cabecera `X-Pipeline-Key`.** Sin ella devuelve `401`. Está cerrada a
propósito: el servidor es público y cada llamada gasta cuota de Gemini y CPU, así
que sin clave cualquiera que encontrara la URL podría generar videos a tu costa.
Si la variable `PIPELINE_KEY` no está definida en el servidor, responde `503`.

```bash
curl -X POST "https://TU-SERVICIO.run.app/api/pipeline-completo" \
  -H "Content-Type: application/json" \
  -H "X-Pipeline-Key: TU_CLAVE" \
  -d '{"categoria": "astronomia"}'
```

### Parámetros del cuerpo

| Campo | Por defecto | Para qué sirve |
|---|---|---|
| `categoria` | rotación automática | `astronomia`, `ciencia`, `tecnologia`, `medicina`, `videojuegos`, `medio_ambiente` |
| `topic` | — | Tema explícito. Si se envía, no se elige noticia de la categoría |
| `voiceId` | `robot-gir` | Cualquier id de `AVAILABLE_VOICES` |
| `format` | `noticia_resumida` | `5_cosas`, `historia_ciencia`, `evento_astronomico` |
| `brandingMode` | `watermark_only` | `watermark_only` o `none` |
| `watermarkPos` | `top-left` | Posición de la marca de agua |
| `watermarkOpacity` | `0.40` | Opacidad de la marca de agua |
| `jobId` | — | Si se repite el mismo, **devuelve el resultado anterior en vez de generar otro video**. Evita duplicados cuando n8n reintenta |
| `dryRun` | `false` | Con `true` no genera nada: solo valida y devuelve el plan. Ideal para probar la configuración de n8n sin gastar cuota |

### Respuesta

```json
{
  "success": true,
  "elapsedSec": 165,
  "data": {
    "videoUrl": "/video/ciencia_cool_1791249334969.mp4",
    "videoUrlAbsoluta": "https://TU-SERVICIO.run.app/video/ciencia_cool_...mp4",
    "sizeBytes": 18622208,
    "title": "La nueva vaca de la Edad de Hielo",
    "description": "Descripción larga, para YouTube.",
    "caption": "Versión corta, para TikTok e Instagram.",
    "hashtags": ["#cienciacool", "#paleontologia", "#ciencia", "#shorts"],
    "category": "ciencia",
    "source": "ABC",
    "newsTitle": "Titular original de la noticia",
    "jobId": "video-2026-10-06",
    "reutilizado": false,
    "sceneCount": 3,
    "tiempos": { "guion": 12, "audio": 50, "medios": 2, "render": 103 }
  }
}
```

Usa **`videoUrlAbsoluta`**: es pública y es la que necesitan tanto n8n para
descargar el archivo como Instagram para ir a buscarlo al processing.

### Códigos de respuesta

| Código | Cuándo | Qué hacer |
|---|---|---|
| `200` | Todo correcto | Publicar el video |
| `401` | Falta o es incorrecta la clave | Revisar `X-Pipeline-Key` |
| `429` | Ya hay una generación en marcha y la cola está llena | Esperar lo que indique `Retry-After` (120 s) y reintentar |
| `500` | Falló la generación | Mirar `steps` para ver en qué paso se rompió |
| `503` | El servidor no tiene `PIPELINE_KEY` configurada | Revisar las variables de entorno del servicio |

### Cosas que conviene saber

- **Tarda unos 3 minutos.** El render se lleva ~60% del tiempo. Si lo orquestas
  desde n8n, sube el timeout del nodo HTTP Request a **480000 ms** (480 s): el
  valor por defecto son 300 s y se queda corto.
- **El video se sube a Google Cloud Storage.** Cloud Run tiene un disco efímero:
  el MP4 desaparece cuando la instancia se reinicia, y la URL del render deja de
  funcionar a los minutos. Por eso el pipeline lo sube a un bucket de GCS y
  devuelve `videoUrlGcs`, que es permanente. Usa esa URL para publicar.
- **Se borra después de publicar.** El workflow de n8n borra el video de GCS
  nada más terminar de publicarlo en todas las redes. Así solo hay un video a la
  vez en almacenamiento y el coste es de céntimos al año.
- **Cloud Run corta respuestas de más de 32 MB.** El render ya limita el archivo a
  20 MB de presupuesto para que siempre quepa.
- **`GET /api/pipeline-completo/status`** dice si la clave vale, si el servidor
  está ocupado y cuántos videos hay en disco, sin generar nada.

## 🤖 n8n: orquestador de publicación (VM en Google Cloud)

n8n es el que llama al pipeline y sube el resultado a las redes. Vive en una VM
`e2-micro` de Google Cloud, que entra en el **free tier** en las regiones de US,
igual que el resto del proyecto.

| Recurso | Coste |
|---|---|
| VM `e2-micro` en `us-central1-a` | Gratis (free tier) |
| Disco estándar de 30 GB | Gratis (incluye el SO) |
| Docker + n8n self-hosted | Gratis |
| Egreso de red | 1 GB/mes gratis; ~30 videos ≈ 1,8 GB → **~$0,15** |

### ⚠️ El panel NO está abierto a internet

n8n escucha en `127.0.0.1:5678` dentro de la VM, así que **no es accesible desde
internet**. Ni por IP ni por ningún puerto. Comprobado: el 5678 da `TcpTestSucceeded: False`
desde fuera de la VM.

Se entra por **túnel SSH**:

```bat
Abrir-n8n.bat
```

o a mano:

```bat
gcloud compute ssh ciencia-cool-n8n --zone=us-central1-a -- -L 5678:localhost:5678
```

Luego se abre <http://localhost:5678>. La ventana del túnel tiene que seguir
abierta mientras trabajes en n8n.

La primera vez hay que **crear la cuenta de propietario**. A partir de ahí, n8n
pide nombre, correo y contraseña.

### Ajustes de la VM

La `e2-micro` del free tier tiene **969 MB de RAM**, y n8n corre sobre Node, que
es hambriento. Por eso:

- **2 GB de swap** en `/swapfile` (ya está en `/etc/fstab`, sobrevive reinicios).
- **Tope de memoria al contenedor** (`mem_limit: 700m`, `memswap_limit: 1800m`).
  Sin tope, n8n se comería toda la RAM y lo mataría el OOM killer del kernel,
  que puede llevarse por delante cualquier proceso. Con tope, lo que muere es el
  contenedor, que n8n reinicia solo gracias a `restart: unless-stopped`.
- **Zona horaria** `America/Mexico_City`, para que los horarios de publicación
  sean los de México y no los de UTC.

Si alguna vez n8n va lento o se reinicia solo, mira la memoria primero:
```bash
docker stats --no-stream
docker logs --tail 50 n8n
```

### Mantenimiento

```bash
# Entrar a la VM
gcloud compute ssh ciencia-cool-n8n --zone=us-central1-a

# Reiniciar n8n
cd /opt/n8n && sudo docker compose restart

# Actualizar a la última versión
cd /opt/n8n && sudo docker compose pull && sudo docker compose up -d

# Ver logs
sudo docker logs -f n8n

# Ver la clave de cifrado de credenciales (¡guárdala!)
sudo cat /opt/n8n/.env
```

⚠️ **La clave `N8N_ENCRYPTION_KEY` de `/opt/n8n/.env` cifra todas las credenciales
de las redes que se guarden en n8n.** Si se pierde, habrá que volver a meter a
mano las claves de YouTube, Instagram y TikTok. Conviene copiar ese fichero a
algún sitio seguro.

### Nota sobre n8n y el puerto 5678

Si al abrir el túnel la página da **404**, no es que esté roto: n8n exige que la
petición venga con la cabecera `Accept` de un navegador. Un `curl` normal
(`Accept: */*`) recibe 404, pero el navegador abre la interfaz sin problema. Para
comprobarlo por consola:

```bash
curl -H "Accept: text/html" -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5678/
```

---

## 📋 Probarlo

```bash
npm run test:pipeline              # seguridad, validación y estado (instantáneo)
node test_pipeline.js --real       # además genera un video de verdad (~3 min)
```

La clave se lee de la variable `PIPELINE_KEY` o de `outputs/key.txt`, que está en
`.gitignore`.

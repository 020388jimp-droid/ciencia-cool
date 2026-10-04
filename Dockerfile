# Imagen de Node.js 20 (Debian slim) con FFmpeg.
# Ya no se necesita Python/Whisper/Aeneas: los tiempos de palabra los entrega
# Edge TTS durante la sintesis del audio, asi que los subtitulos son exactos
# sin transcripcion offline. Esto mantiene la imagen en ~250 MB en vez de ~4 GB.
FROM node:20-bookworm-slim

# FFmpeg (render + ffprobe), DejaVu Sans Bold para el filtro `subtitles`,
# fontconfig para que libass resuelva las fuentes, y git (algunas deps lo usan).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-dejavu \
    fonts-dejavu-core \
    fontconfig \
    git \
    ca-certificates \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY . .

RUN mkdir -p outputs/audio outputs/media outputs/video outputs/temp

ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "src/server.js"]
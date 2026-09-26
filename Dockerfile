# Imagen ligera oficial de Node.js
FROM node:20-alpine

# Instalar FFmpeg y fuentes para subtítulos (paquete correcto en Alpine)
RUN apk add --no-cache ffmpeg font-dejavu fontconfig

# Directorio de trabajo en el contenedor
WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias de producción
RUN npm ci --only=production

# Copiar el código fuente y la interfaz pública
COPY . .

# Crear directorios de salida
RUN mkdir -p outputs/audio outputs/media outputs/video outputs/temp

# Puerto expuesto por Google Cloud Run (por defecto 8080)
ENV PORT=8080
EXPOSE 8080

# Comando para iniciar el servidor
CMD ["node", "src/server.js"]

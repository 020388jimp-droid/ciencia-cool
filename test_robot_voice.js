import fs from 'fs';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

async function test() {
  const tts = new MsEdgeTTS();
  await tts.setMetadata('es-MX-JorgeNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  
  const text = '¡Hola exploradores espaciales! Bienvenidos a Ciencia Cool. Hoy descubriremos un misterio del universo.';
  
  // SSML con pitch +45Hz y rate +20% para emular el tono agudo y enérgico de Alpha 5
  const ssmlAlpha = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-MX">
    <voice name="es-MX-JorgeNeural">
      <prosody pitch="+45Hz" rate="+20%">
        ${text}
      </prosody>
    </voice>
  </speak>`;

  const streamResult = tts.rawToStream(ssmlAlpha);
  const ws = fs.createWriteStream('./outputs/audio/test_alpha5.mp3');
  streamResult.audioStream.pipe(ws);
  ws.on('finish', () => console.log('✅ test_alpha5.mp3 creado con éxito!'));
}

test().catch(console.error);

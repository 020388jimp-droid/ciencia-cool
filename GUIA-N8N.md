# 📖 Guía paso a paso — Abrir el panel de n8n

Guía para alguien que nunca ha usado n8n ni un servidor. Cada parte termina con
una pregunta para que me mandes la captura y comprobemos juntos que va bien.

---

## 📋 Datos que vas a necesitar

Tenlos a mano. No hace falta que los entiendas todos todavía.

| Qué | Valor |
|---|---|
| **Panel de n8n** | `http://localhost:5678` |
| **VM (servidor)** | `ciencia-cool-n8n` |
| **Zona** | `us-central1-a` |
| **Proyecto GCP** | `worklish-76787885-3c342` |
| **Lanzador del túnel** | `C:\Users\LENOVO\OneDrive\Documentos\PROYECTOS VS CODE\CIENCIA COOL\Abrir-n8n.bat` |
| **Consola de facturación** | <https://console.cloud.google.com/billing/681255809395/budgets> |
| Contraseña de n8n | mínimo **8 caracteres** (te la pones tú) |

---

# PARTE 1 · Abrir el túnel

## Qué estamos haciendo y por qué

n8n está instalado en un servidor de Google Cloud que se llama `ciencia-cool-n8n`.
Ese servidor **no se puede ver desde internet** a propósito: si estuviera abierto,
cualquier persona que encontrara la dirección podría entrar y usar tu cuenta de
YouTube, Instagram y TikTok.

Para verlo sin abrirlo al mundo, se usa un **túnel SSH**. Es como una tubería
privada: tu navegador habla con el servidor a través de tu propia conexión, y no
hay ninguna puerta abierta en internet.

## Pasos

**1.** Abre el Explorador de archivos y ve a:

```
C:\Users\LENOVO\OneDrive\Documentos\PROYECTOS VS CODE\CIENCIA COOL
```

**2.** Busca el archivo **`Abrir-n8n.bat`** y haz **doble clic**.

> 💡 Si Windows pregunta si quieres permitir ejecutarlo, acepta. Aparece una
> ventana azul con texto blanco: es una ventana de consola.

**3.** Verás algo parecido a esto:

```
==========================================================
  CIENCIA COOL -.panel de n8n
==========================================================

Abriendo el tunel SSH hacia la VM...
Cuando veas "Enter provided", deja esta ventana abierta.
```

**4.** Espera unos **10-20 segundos**. Entonces la ventana se queda quieta con el
cursor parpadeando abajo. Eso es normal: significa que el túnel está abierto y
funcionando. **No escribas nada ahí.**

> ⚠️ **Esta ventana NO la cierres** mientras estés trabajando en n8n. Si la
> cierras, pierdes el acceso al panel.

## Qué debería pasar

- La ventana se queda abierta, con texto y un cursor parpadeando
- **No** debería mostrar errores en rojo
- Si ves `Enter provided` o `Waiting for connection`, todo correcto

## Si algo falla

| Síntoma | Qué hacer |
|---|---|
| `No se encontro gcloud` | Falta Google Cloud SDK. Instálalo: <https://cloud.google.com/sdk/docs/install> y reinicia la guía. |
| `[AVISO] El puerto 5678 ya esta ocupado` | Tienes otro túnel abierto. Abre <http://localhost:5678> directamente. |
| `Permission denied (publickey)` | Tus claves SSH no llegaron a la VM. Cierra todo y vuelve a lanzarlo. |
| `ERROR: Could not parse hostname` | No copies el archivo mal. Haz doble clic en él, no lo escribas a mano. |

## ➡️ Envíame captura

**Mándame una foto de esa ventana de consola.** Quiero confirmar que pone lo de
"túnel abierto" y que no hay errores en rojo.

Cuando lo confirmes, seguimos con la Parte 2.

---

# PARTE 2 · Crear la cuenta de propietario

## Qué estamos haciendo y por qué

n8n acaba de instalarse y está completamente vacío. No tiene usuarios ni claves de
ninguna red. Lo primero es crear **la cuenta de dueño**: el administrador único que
entra a configurar los workflows y a meter las claves de YouTube, Instagram y
TikTok.

Solo tú vas a tener esta cuenta.

## Pasos

**1.** Con la ventana del túnel **abierta**, abre Chrome y ve a:

```
http://localhost:5678
```

> ⚠️ Es **`localhost`**, no la IP del servidor. Si escribes `136.112.176.34`
> en vez de `localhost:5678`, no funcionará (y es lo correcto: así se comprueba
> que el túnel está filtrando).

**2.** Verás una pantalla de **n8n** con un formulario para crear la cuenta. Te
pedirá:

| Campo | Qué poner |
|---|---|
| **Nombre** (first/last name) | El tuyo, como quieras que te llame n8n. Ej: `Ignacio Maldonado` |
| **Correo** | Uno tuyo real. Es el usuario con el que entrarás luego. Ej: `tu_correo@gmail.com` |
| **Contraseña** | **Mínimo 8 caracteres.** Elige una que recuerdes bien |

**3.** Es probable que también te pregunte algo tipo *"¿para qué vas a usar n8n?"*
o una pregunta similar de personalización. **Da igual lo que contestes**, no
afecta a nada. Es solo para estadísticas de los servidores de n8n.

**4.** Pulsa **"Create account"** / **"Crear cuenta"**.

**5.** Entra en n8n.

## Qué debería pasar

Verás el **editor de workflows** de n8n: una columna estrecha a la izquierda con
la lista de workflows (vacía, porque todavía no hay ninguno) y a la derecha una
tela en blanco con un signo `+` para crear el primero. Todo en blanco y vacío es
lo normal en una instalación recién hecha.

## Sobre la contraseña

Elige una **fuerte y que recuerdes**. Ojo: si se te olvida no hay forma de
recuperarla, tendrías que volver a instalar n8n desde cero y perder los workflows.

Una forma de que sea a la vez segura y fácil de recordar:

- Una frase que te guste convertida en una sola palabra, con números:
  `mi-gato-se-llama-simba-2019`
- Menos de 8 caracteres = n8n no te deja continuar.

## ➡️ Envíame captura

**Mándame captura de una de estas dos pantallas:**

1. El formulario de registro lleno (tapa la contraseña si aparece visible), **o**
2. El editor de workflows ya abierto y vacío.

Con la segunda ya podemos pasar a la Parte 3.

---

# PARTE 3 · Comprobar que n8n habla con tu app

## Qué estamos haciendo y por qué

Esto no lo puedes hacer tú todavía desde el panel, así que lo comprobé yo. Te lo
explico para que entiendas qué está preparado.

**Ya verificado desde el servidor:**

```
El servidor n8n llama a tu app ......... correcto, 0,11 s
Tu app responde con la clave           correcto ("listo": true)
Tu app dice si está ocupada            correcto
```

Lo que **no** he podido comprobar todavía (porque necesita que n8n tenga un
workflow que genere un video de verdad) es que n8n consiga **descargar el MP4** de
la app. Eso lo probaremos en la Fase 3, con el primer workflow real.

## Dato técnico que conviene saber

Tu app en Google Cloud devuelve la dirección del video con el prefijo `https://`.
Eso es importante porque Instagram **no descarga el archivo: va a buscarlo él
mismo** por esa dirección. Por eso la app devuelve la dirección completa y no una
ruta relativa.

## ➡️ Siguiente paso

Si ya ves el editor de workflows vacío, la Fase 2 está terminada. Avísame y
pasamos a la **Fase 3**, que es donde ya se automatiza de verdad: crear el primer
workflow que genera un video y lo sube a YouTube.

---

# PARTE 4 · Guardar la clave de cifrado (importante)

## Qué estamos haciendo y por qué

Cuando dentro de un rato metamos las claves de YouTube, Instagram y TikTok en n8n,
n8n las **cifra** antes de guardarlas. La llave de ese cifrado está en un archivo
dentro del servidor.

Si ese archivo se pierde (si alguien borra el servidor, o si toca restaurar una
copia antigua), **todas las claves de las redes quedan ilegibles** y hay que
volver a metirlas una por una a mano. No se pueden recuperar.

No cuesta nada hacer la copia ahora. Son 30 segundos.

## Pasos

**1.** Abre una terminal normal de Windows: pulsa <kbd>Windows</kbd> + <kbd>R</kbd>,
escribe `powershell` y dale a Enter.

> 💡 **No** abras `Abrir-n8n.bat` para esto. Ese archivo sirve para el túnel del
> panel; aquí solo necesitamos una consola.

**2.** Pega esto y dale a Enter:

```powershell
gcloud compute ssh ciencia-cool-n8n --zone=us-central1-a --project=worklish-76787885-3c342 --command="sudo cat /opt/n8n/.env"
```

**3.** Te imprimirá dos líneas parecidas a estas (**las tuyas son distintas**):

```
N8N_ENCRYPTION_KEY=61b29dc0840094684c0c4d25550c1a7d3bf0d3668ae2583e2b39781fee87de7b
N8N_GENERIC_TIMEZONE=America/Mexico_City
```

**4.** Copia esas dos líneas (la primera sobre todo) y guárdalas donde quieras:
un archivo de texto, un email personal, una nota del móvil. **No las subas a
GitHub ni a ningún sitio compartido.**

## ➡️ Envíame captura

**Mándame captura de la salida de esa consola** (puedes tapar la clave si te
incomoda, pero necesito ver que el comando funcionó y devolvió dos líneas).

---

# PARTE 5 · Alerta de presupuesto (para proteger el $0)

## Qué estamos haciendo y por qué

Todo el proyecto está montado para costar **$0**: Cloud Run en su nivel gratuito y
esta VM en el nivel gratuito de Google.

Pero si algún día algo se sale de lo previsto (un video mucho largo, una imágenes
repetida, un cambio de configuración), Google **no para nada**: cobra
automáticamente. La alerta te avisa por email antes de que pase.

Yo intenté crearla por ti pero no tengo permiso para tocar la configuración de
facturación. Son 2 minutos.

## Pasos

**1.** Abre este enlace con tu cuenta de Google:

<https://console.cloud.google.com/billing/681255809395/budgets>

**2.** Si te pide iniciar sesión, hazlo con `020388jimp@gmail.com`.

**3.** Pulsael botón **"CREATE BUDGET"** o **"CREAR PRESUPUESTO"**.

**4.** Rellénalo así:

| Campo | Valor |
|---|---|
| **Nombre** | `CIENCIA COOL - alerta de gasto` |
| **Importe del presupuesto** | `5` |
| **Divisa** | USD (dólares) |
| **Umbral** | `50` % → **100** % |

**5.** En *"Notifications"* o *"Notificaciones"*, pon **tu correo electrónico**.

**6.** Deja el resto por defecto y pulsa **"Create"** / **"Crear"**.

## Qué significa

- Si algún mes llegas a **$2,50**, Google te avisa por email
- Si llegas a **$5**, te avisa otra vez

Como el objetivo es $0, cualquier correo que te llegue significa que algo se
desvió y hay que mirarlo.

## ➡️ Envíame captura

**Mándame captura del presupuesto creado** para confirmar que está bien puesto.

---

# 📌 Resumen: qué hay que hacer en total

| # | Parte | Qué haces | Estado |
|---|---|---|---|
| 1 | Abrir el túnel | doble clic en `Abrir-n8n.bat` | ⏳ |
| 2 | Crear la cuenta de n8n | abrir `http://localhost:5678` y registrarse | ⏳ |
| 3 | Comprobación | ya verificado por mí ✅ | ✅ |
| 4 | Copia de la clave | un comando en PowerShell | ⏳ |
| 5 | Alerta de presupuesto | crear un presupuesto de $5 en la consola | ⏳ |

---

**Empieza por la Parte 1 y mándame la captura cuando la tengas.** Con una captura
a la vez vamos paso a paso, sin adelantarnos.

Si en cualquier momento algo no se parece a lo que te describo, **para y mándame
captura antes de seguir**. Es mejor detenerse que saltarse un paso.
@echo off
REM ===========================================================================
REM  CIENCIA COOL - acceso al panel de n8n
REM
REM  n8n NO esta abierto a internet, a proposito. Este script abre un "tunel"
REM  SSH: conecta tu navegador con el puerto 5678 de la VM sin exponer nada.
REM
REM  Al ejecutar esto se queda abierto en esta ventana. NO la cierres mientras
REM  estés trabajando en n8n, o perderas el acceso.
REM
REM  Cuando termine, abre http://localhost:5678 en el navegador.
REM  La primera vez te pedira crear la cuenta de propietario.
REM ===========================================================================

echo.
echo  ==========================================================
echo   CIENCIA COOL -.panel de n8n
echo  ==========================================================
echo.
echo  Abriendo el tunel SSH hacia la VM...
echo  Cuando veas "Enter provided", deja esta ventana abierta.
echo.
echo  Despues abre:  http://localhost:5678
echo  Para salir:    Ctrl+C  (o cierra esta ventana)
echo.

where gcloud >nul 2>&1
if errorlevel 1 (
  echo  [ERROR] No se encontro gcloud.
  echo  Instala Google Cloud SDK: https://cloud.google.com/sdk/docs/install
  echo.
  pause
  exit /b 1
)

REM El puerto 5678 debe estar libre en el PC. Si ya lo esta, avisa en vez de
REM fallar con un error de sockets que no dice nada util.
netstat -ano | findstr /R /C:":5678 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo  [AVISO] El puerto 5678 ya esta ocupado en este PC.
  echo  Puede ser que el tunel ya este abierto en otra ventana.
  echo  Si es asi, abre http://localhost:5678 directamente.
  echo.
  echo  Pulsa una tecla para cerrar, o ENTER para continuar de todos modos.
  pause >nul
)

gcloud compute ssh ciencia-cool-n8n ^
  --zone=us-central1-a ^
  --project=worklish-76787885-3c342 ^
  -- -L 5678:localhost:5678

echo.
echo  Tunel cerrado. El panel de n8n ya no es accesible.
pause
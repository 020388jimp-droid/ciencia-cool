@echo off
REM ===========================================================================
REM  CIENCIA COOL - probar cuales modelos de OpenCode estan disponibles
REM
REM  Doble clic. Prueba cada modelo con un mensaje de una palabra y dice
REM  cuales responden y cuales tienen el limite de peticiones agotado
REM  ("Rate limit exceeded").
REM
REM  El resultado se guarda en outputs\modelos-estado.json con la hora, asi
REM  puedes ver cuando fue la ultima vez que cada modelo funciono.
REM ===========================================================================

echo.
echo  ==========================================================
echo   CIENCIA COOL -.probar modelos de OpenCode
echo  ==========================================================
echo.

where opencode >nul 2>&1
if errorlevel 1 (
  echo  [ERROR] No se encontro "opencode" en el PATH.
  echo  Abre OpenCode una vez desde la terminal para dejarlo instalado.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\probar-modelos.ps1"

echo.
pause

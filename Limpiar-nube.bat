@echo off
chcp 65001 >nul
title Limpiar la nube - copias viejas de las apps
cls
echo.
echo  ==========================================================
echo    LIMPIAR LA NUBE (Artifact Registry)
echo  ==========================================================
echo.
echo  Muestra cuanto espacio ocupan las copias de tus apps en
echo  Google Cloud y borra las viejas.
echo.
echo  NUNCA toca:
echo    - la copia que esta corriendo ahora mismo,
echo    - la version de App Engine que esta sirviendo,
echo    - las mas recientes (por si hay que regresar a una).
echo.
echo  Al final te pedira escribir SI para confirmar.
echo.
pause
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\limpiar-nube.ps1" -Borrar
echo.
echo  ==========================================================
echo   Si quieres ver el plan SIN borrar nada:
echo     powershell -File scripts\limpiar-nube.ps1
echo   Para otro proyecto de Google Cloud:
echo     powershell -File scripts\limpiar-nube.ps1 -Proyecto OTRO-ID -Borrar
echo   (la regla automatica se pone por proyecto: correlo en cada uno)
echo  ==========================================================
pause

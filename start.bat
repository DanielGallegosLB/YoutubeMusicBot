@echo off
title Bot de musica - JUGNU-MUSIC
cd /d "%~dp0"

REM  Desactiva "QuickEdit" de la consola (Windows). Con QuickEdit activo, un clic
REM  en esta ventana CONGELA el proceso hasta apretar una tecla: el bot dejaba de
REM  responder minutos enteros, la voz de Discord moria y el panel quedaba muerto.
REM  Aplica a las consolas que se abran DESPUES de este cambio (cierra esta ventana
REM  y vuelve a abrir start.bat una vez).
reg add "HKCU\Console" /v QuickEdit /t REG_DWORD /d 0 /f >nul 2>&1

:inicio
echo [start.bat] Iniciando bot...
REM  Ruta completa a proposito: la linea de comandos contiene "JUGNU-MUSIC\index.js".
REM  --max-old-space-size=6144: margen de memoria (6 GB en vez de 4 GB).
node --max-old-space-size=6144 "%~dp0index.js"
echo [start.bat] El bot termino (codigo %errorlevel%). Reiniciando en 5 s...
timeout /t 5 /nobreak >nul
goto inicio

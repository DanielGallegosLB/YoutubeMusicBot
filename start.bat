@echo off
title Bot de musica - JUGNU-MUSIC
cd /d "%~dp0"

REM  Etiqueta del reinicio automatico: vuelve aca para relanzar el bot.
:start

REM ===================================================================
REM  Cierra cualquier instancia anterior de ESTE bot antes de arrancar.
REM  Solo mata procesos cuya linea de comandos apunte a esta carpeta
REM  (JUGNU-MUSIC\index.js), para no tocar otros bots del equipo.
REM ===================================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\kill-old-instances.ps1"

REM  Se arranca con la RUTA COMPLETA a proposito: asi la linea de comandos
REM  contiene "JUGNU-MUSIC\index.js" y el filtro de arriba puede identificar
REM  a este bot (con "npm start" seria solo "node index.js", indistinguible).
echo [start.bat] Iniciando bot...
echo.

node "%~dp0index.js"

echo.
echo [start.bat] El bot se detuvo. Reiniciando en 5 segundos ^(Ctrl+C para salir^)...
timeout /t 5 /nobreak >nul
goto start
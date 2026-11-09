@echo off
title Bot de musica - JUGNU-MUSIC
cd /d "%~dp0"

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

REM  Reinicio automatico: el bot sale con codigo 75 cuando la memoria se acerca al
REM  limite (ver handlers\MemoryGuard.js) o si se cae por falta de memoria.
REM  Ctrl+C (codigo -1073741510) o salida normal (0) NO reinician.
:loop
node "%~dp0index.js"
set EXITCODE=%ERRORLEVEL%
if "%EXITCODE%"=="0" goto fin
if "%EXITCODE%"=="-1073741510" goto fin
echo.
echo [start.bat] El bot salio con codigo %EXITCODE%. Reiniciando en 5 s...
timeout /t 5 /nobreak >nul
goto loop
:fin


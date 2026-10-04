# Cierra instancias anteriores del bot de musica JUGNU-MUSIC.
# Solo mata procesos node.exe cuya linea de comandos apunte a esta carpeta,
# para no tocar otros bots del equipo (insta-discord-bridge, ParadiseBot, etc).

$carpeta = 'JUGNU-MUSIC'
$yo = $PID

$procesos = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object {
        $_.ProcessId -ne $yo -and
        $_.CommandLine -and
        $_.CommandLine -like "*$carpeta*index.js*"
    }

if (-not $procesos) {
    Write-Host "[start.bat] No hay instancias anteriores del bot."
    exit 0
}

foreach ($p in $procesos) {
    $antiguo = $p.CreationDate.ToString('dd/MM HH:mm')
    Write-Host "[start.bat] Cerrando instancia anterior del bot (PID $($p.ProcessId), arrancada $antiguo)..."
    try {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
    } catch {
        Write-Host "[start.bat]   No se pudo cerrar el PID $($p.ProcessId): $($_.Exception.Message)"
    }
}

# Pausa para que libere la conexion de voz y la sesion del gateway de Discord.
Start-Sleep -Seconds 3
exit 0
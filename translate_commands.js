const fs = require('fs');
const path = require('path');

const mapping = {
    // Information
    'ayuda': { name: 'ayuda', desc: '¿Necesitas ayuda? Mira todos mis comandos', aliases: ['h', 'cmds', 'comandos'] },
    'invitar': { name: 'invitar', desc: '¡Obtén mi enlace de invitación para añadirme!', aliases: ['inv', 'añadirme'] },
    'latencia': { name: 'latencia', desc: 'Obtén la información de ping y latencia del bot', aliases: ['ping'] },
    'estadisticas': { name: 'estadisticas', desc: 'Ver las estadísticas del bot', aliases: ['botinfo', 'stats'] },
    'tiempoactivo': { name: 'tiempoactivo', desc: 'Ver desde cuándo el bot está en línea', aliases: ['up'] },

    // Music
    'añadiracola': { name: 'añadiracola', desc: 'Añadir una canción a la cola', options: { 'song': { name: 'cancion', desc: 'La canción que quieres añadir' } } },
    'autoreproducir': { name: 'autoreproducir', desc: 'Activa o desactiva la autorreproducción' },
    'limpiarlista': { name: 'limpiarlista', desc: 'Limpia la cola de reproducción' },
    'filtro': { name: 'filtro', desc: 'Añade un filtro a la música' },
    'saltara': { name: 'saltara', desc: 'Salta a una canción específica en la cola', options: { 'index': { name: 'indice', desc: 'El índice de la canción a la que quieres saltar' } } },
    'repetir': { name: 'repetir', desc: 'Cambia el modo de repetición', options: { 'mode': { name: 'modo', desc: 'El modo de repetición (desactivado, canción, cola)' } } },
    'letra': { name: 'letra', desc: 'Obtén la letra de una canción' },
    'mover': { name: 'mover', desc: 'Mueve una canción en la cola', options: { 'from': { name: 'desde', desc: 'La posición actual de la canción' }, 'to': { name: 'hasta', desc: 'La nueva posición de la canción' } } },
    'sonandoahora': { name: 'sonandoahora', desc: 'Muestra la canción que se está reproduciendo ahora' },
    'pausar': { name: 'pausar', desc: 'Pausa la música actual' },
    'reproducir': { name: 'reproducir', desc: 'Reproduce una canción', options: { 'song': { name: 'cancion', desc: 'El nombre o enlace de la canción' } } },
    'reproduciranterior': { name: 'reproduciranterior', desc: 'Reproduce la canción anterior' },
    'saltaryreproducir': { name: 'saltaryreproducir', desc: 'Salta la canción actual y reproduce una nueva', options: { 'song': { name: 'cancion', desc: 'La canción que quieres reproducir' } } },
    'reproducirprimero': { name: 'reproducirprimero', desc: 'Añade una canción al principio de la cola', options: { 'song': { name: 'cancion', desc: 'La canción que quieres añadir' } } },
    'lista': { name: 'lista', desc: 'Muestra la cola de canciones actual' },
    'quitar': { name: 'quitar', desc: 'Quita una canción de la cola', options: { 'index': { name: 'indice', desc: 'El índice de la canción que quieres quitar' } } },
    'quitarrepetidos': { name: 'quitarrepetidos', desc: 'Quita las canciones repetidas de la cola' },
    'volverareproducir': { name: 'volverareproducir', desc: 'Vuelve a reproducir la canción actual' },
    'continuar': { name: 'continuar', desc: 'Continúa la música pausada' },
    'buscar': { name: 'buscar', desc: 'Busca canciones en YouTube', options: { 'query': { name: 'busqueda', desc: 'Lo que quieres buscar' } } },
    'avanzara': { name: 'avanzara', desc: 'Avanza a un tiempo específico en la canción', options: { 'seconds': { name: 'segundos', desc: 'El tiempo en segundos al que quieres avanzar' } } },
    'aleatorio': { name: 'aleatorio', desc: 'Mezcla la cola de canciones' },
    'saltar': { name: 'saltar', desc: 'Salta la canción actual' },
    'detener': { name: 'detener', desc: 'Detiene la música y limpia la cola' },
    'deshaceraleatorio': { name: 'deshaceraleatorio', desc: 'Deshace la mezcla de la cola' },
    'volumen': { name: 'volumen', desc: 'Cambia el volumen del bot', options: { 'amount': { name: 'cantidad', desc: 'El nivel de volumen (1-150)' } } },

    // Playlist
    'crearlista': { name: 'crearlista', desc: 'Crea una nueva lista de reproducción personalizada', options: { 'name': { name: 'nombre', desc: 'Nombre de la lista' } } },
    'borrarlista': { name: 'borrarlista', desc: 'Borra una lista de reproducción personalizada', options: { 'name': { name: 'nombre', desc: 'Nombre de la lista' } } },
    'exportarlista': { name: 'exportarlista', desc: 'Exporta tu lista de reproducción', options: { 'name': { name: 'nombre', desc: 'Nombre de la lista' } } },
    'importarlista': { name: 'importarlista', desc: 'Importa una lista de reproducción desde un enlace', options: { 'url': { name: 'enlace', desc: 'Enlace de la lista' }, 'name': { name: 'nombre', desc: 'Nombre para la nueva lista' } } },
    'reproducirlista': { name: 'reproducirlista', desc: 'Reproduce una de tus listas de reproducción', options: { 'name': { name: 'nombre', desc: 'Nombre de la lista' } } },
    'quitarcancionlista': { name: 'quitarcancionlista', desc: 'Quita una canción de tu lista de reproducción', options: { 'name': { name: 'nombre', desc: 'Nombre de la lista' }, 'index': { name: 'indice', desc: 'Índice de la canción' } } },
    'renombrarlista': { name: 'renombrarlista', desc: 'Renombra una de tus listas de reproducción', options: { 'name': { name: 'nombre', desc: 'Nombre actual' }, 'newname': { name: 'nuevonombre', desc: 'Nuevo nombre' } } },
    'guardarcancionenlista': { name: 'guardarcancionenlista', desc: 'Guarda la canción actual en una lista', options: { 'name': { name: 'nombre', desc: 'Nombre de la lista' } } },
    'guardarlistaactual': { name: 'guardarlistaactual', desc: 'Guarda la cola actual en una lista', options: { 'name': { name: 'nombre', desc: 'Nombre de la lista' } } },
    'detalleslista': { name: 'detalleslista', desc: 'Muestra los detalles de una lista de reproducción', options: { 'name': { name: 'nombre', desc: 'Nombre de la lista' } } },
    'mislistas': { name: 'mislistas', desc: 'Muestra todas tus listas de reproducción' },

    // Settings
    'siempreactivo': { name: 'siempreactivo', desc: 'Activa o desactiva el modo 24/7' },
    'autoresumen': { name: 'autoresumen', desc: 'Activa o desactiva el resumen automático tras un reinicio' },
    'configuracion': { name: 'configuracion', desc: 'Muestra la configuración del bot' },
    'dj': { name: 'dj', desc: 'Configura el sistema DJ', options: { 'role': { name: 'rol', desc: 'Rol para el sistema DJ' } } },
    'calidadalta': { name: 'calidadalta', desc: 'Activa o desactiva el modo de alta calidad' },
    'prefijo': { name: 'prefijo', desc: 'Cambia el prefijo del bot', options: { 'newprefix': { name: 'nuevoprefijo', desc: 'El nuevo prefijo' } } },
    'reiniciar': { name: 'reiniciar', desc: 'Reinicia la configuración del bot' },
    'configurarmusica': { name: 'configurarmusica', desc: 'Configura el canal de música' }
};

function processFile(filePath) {
    let content = fs.readFileSync(filePath, 'utf8');
    const fileName = path.basename(filePath, '.js');
    const data = mapping[fileName];

    if (!data) {
        console.log(`No mapping found for ${fileName}`);
        return;
    }

    // Replace name
    content = content.replace(/name:\s*['"][^'"]+['"]/, `name: "${data.name}"`);

    // Replace description
    content = content.replace(/description:\s*`[^`]+`/, `description: \`${data.desc}\``);
    content = content.replace(/description:\s*['"][^'"]+['"]/, `description: "${data.desc}"`);

    // Update aliases for message commands
    if (filePath.includes('Message') && data.aliases) {
        content = content.replace(/aliases:\s*\[[^\]]*\]/, `aliases: ${JSON.stringify(data.aliases)}`);
    }

    // Handle Slash Options
    if (filePath.includes('Slash') && data.options) {
        for (const [oldOpt, newOptData] of Object.entries(data.options)) {
            // Replace option name and description in the options array
            // This is a bit tricky with regex, let's try to be specific
            const optNameRegex = new RegExp(`name:\\s*['"]${oldOpt}['"]`, 'g');
            content = content.replace(optNameRegex, `name: "${newOptData.name}"`);

            const optDescRegex = new RegExp(`description:\\s*['"][^'"]+['"](?=[^}]*name:\\s*['"]${newOptData.name}['"])`, 'g');
            // This lookahead might not work if name comes before description. 
            // Let's try a simpler approach for description if it's right after/before name.
            
            // Re-read with simple replace for description of the specific option
            // We'll search for the block containing the new option name
            const lines = content.split('\n');
            for(let i=0; i<lines.length; i++) {
                if(lines[i].includes(`name: "${newOptData.name}"`)) {
                    // Check previous or next few lines for description
                    for(let j=Math.max(0, i-2); j<Math.min(lines.length, i+3); j++) {
                        if(lines[j].includes('description:')) {
                            lines[j] = lines[j].replace(/description:\s*['"][^'"]+['"]/, `description: "${newOptData.desc}"`);
                            lines[j] = lines[j].replace(/description:\s*`[^`]+`/, `description: \`${newOptData.desc}\``);
                        }
                    }
                }
            }
            content = lines.join('\n');

            // Replace code usage: interaction.options.getXXX('oldOpt')
            const usageRegex = new RegExp(`\\.get\\w+\\(['"]${oldOpt}['"]\\)`, 'g');
            content = content.replace(usageRegex, (match) => match.replace(oldOpt, newOptData.name));
        }
    }

    fs.writeFileSync(filePath, content);
    console.log(`Updated ${filePath}`);
}

const directories = [
    'Commands/Message/Information',
    'Commands/Message/Music',
    'Commands/Message/Playlist',
    'Commands/Message/Settings',
    'Commands/Slash/Information',
    'Commands/Slash/Music',
    'Commands/Slash/Playlist',
    'Commands/Slash/Settings'
];

directories.forEach(dir => {
    if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        files.forEach(file => {
            if (file.endsWith('.js')) {
                processFile(path.join(dir, file));
            }
        });
    }
});

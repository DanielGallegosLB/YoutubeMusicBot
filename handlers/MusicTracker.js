/**
 * MusicTracker - registra canciones reproducidas en la BD del economy bot
 * para usar en el sistema de afinidad/compatibilidad.
 */
const mongoose = require('mongoose');

const ECONOMY_MONGO_URI = process.env.ECONOMY_MONGO_URI || 'mongodb://Lagextremo:lagextremo1@ac-vmd86tb-shard-00-00.11ho8hk.mongodb.net:27017,ac-vmd86tb-shard-00-01.11ho8hk.mongodb.net:27017,ac-vmd86tb-shard-00-02.11ho8hk.mongodb.net:27017/test?ssl=true&replicaSet=atlas-se89cz-shard-0&authSource=admin&appName=Cluster0';

const musicPlaySchema = new mongoose.Schema({
    guildID:   { type: String, required: true },
    userID:    { type: String, required: true },
    songName:  { type: String, required: true },
    artist:    { type: String, default: '' },
    source:    { type: String, default: 'youtube' },
    duration:  { type: Number, default: 0 },
    playedAt:  { type: Date, default: Date.now },
});
musicPlaySchema.index({ guildID: 1, userID: 1, playedAt: -1 });

let MusicPlay = null;
let connected = false;

async function connect() {
    if (connected) return;
    try {
        const conn = await mongoose.createConnection(ECONOMY_MONGO_URI, {
            serverSelectionTimeoutMS: 5000,
        });
        MusicPlay = conn.model('MusicPlay', musicPlaySchema);
        connected = true;
        console.log('[MusicTracker] Conectado a BD del economy bot');
    } catch (err) {
        console.warn('[MusicTracker] No se pudo conectar a la BD del economy bot:', err.message);
    }
}

async function logPlay(guildID, userID, song) {
    if (!MusicPlay) return;
    try {
        await MusicPlay.create({
            guildID,
            userID,
            songName: song.name || 'Unknown',
            artist: song.uploader?.name || '',
            source: song.source || 'youtube',
            duration: song.duration || 0,
        });
    } catch (err) {
        console.warn('[MusicTracker] Error guardando play:', err.message);
    }
}

module.exports = { connect, logPlay };

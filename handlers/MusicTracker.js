/**
 * MusicTracker - registra canciones reproducidas en la BD del economy bot
 * para usar en el sistema de afinidad/compatibilidad.
 */
const mongoose = require('mongoose');

const ECONOMY_MONGO_URI = process.env.ECONOMY_MONGO_URI || 'mongodb://Lagextremo:Lagextremo12@ac-vmd86tb-shard-00-00.11ho8hk.mongodb.net:27017,ac-vmd86tb-shard-00-01.11ho8hk.mongodb.net:27017,ac-vmd86tb-shard-00-02.11ho8hk.mongodb.net:27017/test?ssl=true&replicaSet=atlas-se89cz-shard-0&authSource=admin&appName=Cluster0';

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

// Perfil social del economy bot (colección "socialprofiles"): contiene `music`
// = historial de Spotify [{ name, artist, lastSeen }]. Es la MISMA fuente que
// el perfil ("Artistas que escucha": milo j x371) usa para contar artistas.
const socialProfileSchema = new mongoose.Schema({
    userID:  String,
    guildID: String,
    music:   [{ name: String, artist: String, lastSeen: Date }],
}, { strict: false, collection: 'socialprofiles' });

let MusicPlay = null;
let SocialProfile = null;
let connected = false;

async function connect() {
    if (connected) return;
    try {
        const conn = await mongoose.createConnection(ECONOMY_MONGO_URI, {
            serverSelectionTimeoutMS: 5000,
        });
        MusicPlay = conn.model('MusicPlay', musicPlaySchema);
        SocialProfile = conn.model('SocialProfile', socialProfileSchema);
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

// Top artistas REALES que escucha un usuario (agregado de toda su historia de
// reproducciones). Es la MISMA fuente que el perfil (/miperfil: "Artistas que
// escucha ... x371"). Devuelve [{ name, count }] ordenado por count desc.
// Se cachea en memoria por (guildID,userID) unos segundos para no golpear la
// DB en cada refill del AutoDJ.
const _topCache = new Map(); // key -> { at, data }
const TOP_TTL = Math.max(30000, Number(process.env.MUSICTRACKER_TOP_TTL) || 120000);

async function topArtists(guildID, userID, limit = 20) {
    if (!MusicPlay) return [];
    const key = `${guildID}:${userID}:${limit}`;
    const hit = _topCache.get(key);
    if (hit && (Date.now() - hit.at) < TOP_TTL) return hit.data;
    try {
        const rows = await MusicPlay.aggregate([
            { $match: { guildID: String(guildID), userID: String(userID) } },
            { $group: { _id: '$artist', count: { $sum: 1 } } },
            { $match: { _id: { $nin: ['', null] } } },
            { $sort: { count: -1 } },
            { $limit: Math.max(1, Number(limit) || 20) },
        ]);
        const data = (rows || [])
            .map((r) => ({ name: String(r._id || '').trim(), count: Number(r.count) || 0 }))
            .filter((a) => a.name);
        _topCache.set(key, { at: Date.now(), data });
        return data;
    } catch (err) {
        console.warn('[MusicTracker] Error topArtists:', err.message);
        return [];
    }
}

// Top artistas REALES de TODOS los usuarios de un guild en UNA sola consulta.
// Devuelve { [userId]: [{ name, count }, ...] } (máx `perUser` por usuario).
// Se cachea corto para el loop de snapshots.
const _guildCache = new Map(); // guildID -> { at, data }
const GUILD_TTL = Math.max(30000, Number(process.env.MUSICTRACKER_GUILD_TTL) || 120000);

async function topArtistsForGuild(guildID, perUser = 12) {
    if (!MusicPlay) return {};
    const key = `${guildID}:${perUser}`;
    const hit = _guildCache.get(key);
    if (hit && (Date.now() - hit.at) < GUILD_TTL) return hit.data;
    try {
        const rows = await MusicPlay.aggregate([
            { $match: { guildID: String(guildID), artist: { $nin: ['', null] } } },
            { $group: { _id: { u: '$userID', a: '$artist' }, count: { $sum: 1 } } },
            { $sort: { '_id.u': 1, count: -1 } },
            { $group: {
                _id: '$_id.u',
                artists: { $push: { name: '$_id.a', count: '$count' } },
            } },
            { $project: { artists: { $slice: ['$artists', Math.max(1, Number(perUser) || 12)] } } },
        ]);
        const data = {};
        for (const r of (rows || [])) {
            const uid = String(r._id || '');
            if (!uid) continue;
            data[uid] = (r.artists || [])
                .map((a) => ({ name: String(a.name || '').trim(), count: Number(a.count) || 0 }))
                .filter((a) => a.name);
        }
        _guildCache.set(key, { at: Date.now(), data });
        return data;
    } catch (err) {
        console.warn('[MusicTracker] Error topArtistsForGuild:', err.message);
        return {};
    }
}

// Artistas del PERFIL SPOTIFY (colección socialprofiles) de un usuario,
// agregados por el campo `music.artist` y contados. Misma data que el perfil
// ("Artistas que escucha": milo j x371). Devuelve [{ name, count }] desc.
const _spCache = new Map();
const SP_TTL = Math.max(30000, Number(process.env.MUSICTRACKER_SP_TTL) || 120000);

async function spotifyTopArtists(guildID, userID, limit = 20) {
    if (!SocialProfile) return [];
    const key = `${guildID}:${userID}:${limit}`;
    const hit = _spCache.get(key);
    if (hit && (Date.now() - hit.at) < SP_TTL) return hit.data;
    try {
        const rows = await SocialProfile.aggregate([
            { $match: { userID: String(userID), guildID: String(guildID) } },
            { $unwind: '$music' },
            { $match: { 'music.artist': { $nin: ['', null] } } },
            { $group: { _id: { $toLower: '$music.artist' }, name: { $first: '$music.artist' }, count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: Math.max(1, Number(limit) || 20) },
        ]);
        const data = (rows || [])
            .map((r) => ({ name: String(r.name || r._id || '').trim(), count: Number(r.count) || 0 }))
            .filter((a) => a.name);
        _spCache.set(key, { at: Date.now(), data });
        return data;
    } catch (err) {
        console.warn('[MusicTracker] Error spotifyTopArtists:', err.message);
        return [];
    }
}

// Igual que topArtistsForGuild pero para Spotify: { [userId]: [{name,count}] }.
const _spGuildCache = new Map();

async function spotifyArtistsForGuild(guildID, perUser = 12) {
    if (!SocialProfile) return {};
    const key = `${guildID}:${perUser}`;
    const hit = _spGuildCache.get(key);
    if (hit && (Date.now() - hit.at) < SP_TTL) return hit.data;
    try {
        const rows = await SocialProfile.aggregate([
            { $match: { guildID: String(guildID) } },
            { $unwind: '$music' },
            { $match: { 'music.artist': { $nin: ['', null] } } },
            { $group: { _id: { u: '$userID', a: { $toLower: '$music.artist' } }, name: { $first: '$music.artist' }, count: { $sum: 1 } } },
            { $sort: { '_id.u': 1, count: -1 } },
            { $group: { _id: '$_id.u', artists: { $push: { name: '$name', count: '$count' } } } },
            { $project: { artists: { $slice: ['$artists', Math.max(1, Number(perUser) || 12)] } } },
        ]);
        const data = {};
        for (const r of (rows || [])) {
            const uid = String(r._id || '');
            if (!uid) continue;
            data[uid] = (r.artists || [])
                .map((a) => ({ name: String(a.name || '').trim(), count: Number(a.count) || 0 }))
                .filter((a) => a.name);
        }
        _spGuildCache.set(key, { at: Date.now(), data });
        return data;
    } catch (err) {
        console.warn('[MusicTracker] Error spotifyArtistsForGuild:', err.message);
        return {};
    }
}

module.exports = { connect, logPlay, topArtists, topArtistsForGuild, spotifyTopArtists, spotifyArtistsForGuild };
// lib/playlists.js
const path = require('path');
const fs = require('fs');
const {
  PLAYLIST_URLS,
  DOWNLOAD_ROOT
} = require('./config');
const {
  extractPlaylistId,
  getPlaylistMetadata,
  getPlaylistTracks
} = require('./spotify');
const { startPlaylistDownload, listAudioFiles } = require('./downloader');

const playlists = new Map(); // key: playlistId

function slugify(str) {
  return (str || '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

function buildTrackKey(track) {
  return slugify(`${track.artists} - ${track.name}`);
}

function getOrCreatePlaylist(id, url, opts = {}) {
  if (!playlists.has(id)) {
    playlists.set(id, {
      id,
      url,
      name: 'Loading...',
      owner: '',
      description: '',
      tracksTotal: 0,
      tracks: [],
      images: [],
      status: 'idle', // idle | syncing | error
      lastSyncAt: null,
      lastMetadataRefreshAt: null,
      downloadedCount: 0,
      errorMessage: null,
      downloadDir: path.join(DOWNLOAD_ROOT, id),
      process: null,
      logs: [],
      isManual: Boolean(opts.isManual), // true when added from the web form
      lastContentAt: null // when we last had downloaded content for TTL cleanup
    });
  }
  return playlists.get(id);
}

async function refreshMetadataAndTracks(playlist) {
  try {
    const meta = await getPlaylistMetadata(playlist.id);
    const tracks = await getPlaylistTracks(playlist.id);

    playlist.name = meta.name;
    playlist.owner = meta.owner;
    playlist.description = meta.description;
    playlist.tracksTotal = meta.tracksTotal;
    playlist.url = meta.url || playlist.url;
    playlist.images = meta.images || [];
    playlist.tracks = tracks.map(t => ({
      ...t,
      key: buildTrackKey(t),
      localStatus: 'pending' // will be updated by filesystem scan
    }));
    playlist.lastMetadataRefreshAt = new Date();
    playlist.errorMessage = null;
    await updateDownloadStatus(playlist);
  } catch (err) {
    playlist.errorMessage = err.message;
    console.error(
      `[playlists] Failed to refresh metadata for ${playlist.id}:`,
      err
    );
  }
}

async function updateDownloadStatus(playlist) {
  const files = listAudioFiles(playlist.downloadDir);
  const fileSlugs = files.map(f => slugify(f.replace(path.extname(f), '')));

  let downloaded = 0;
  let pending = 0;

  for (const track of playlist.tracks) {
    const key = track.key || buildTrackKey(track);
    const found = fileSlugs.some(s => s.includes(key));
    track.localStatus = found ? 'downloaded' : 'pending';
    if (track.localStatus === 'downloaded') downloaded++;
    else pending++;
  }

  playlist.downloadedCount = downloaded;
  playlist.tracksTotal = playlist.tracksTotal || downloaded + pending;

  // If we currently have any downloaded tracks, update lastContentAt
  if (downloaded > 0) {
    playlist.lastContentAt = new Date();
  }
}

async function initPlaylistsFromEnv() {
  if (!PLAYLIST_URLS.length) {
    console.warn('[playlists] No PLAYLIST_URLS configured.');
    return;
  }

  for (const url of PLAYLIST_URLS) {
    const id = extractPlaylistId(url);
    if (!id) continue;
    const pl = getOrCreatePlaylist(id, url, { isManual: false });
    refreshMetadataAndTracks(pl); // fire & forget
  }
}

function getAllPlaylistsSummary() {
  return Array.from(playlists.values()).map(p => ({
    id: p.id,
    name: p.name,
    owner: p.owner,
    description: p.description,
    tracksTotal: p.tracksTotal,
    downloadedCount: p.downloadedCount,
    status: p.status,
    lastSyncAt: p.lastSyncAt,
    lastMetadataRefreshAt: p.lastMetadataRefreshAt,
    url: p.url,
    images: p.images,
    isManual: p.isManual
  }));
}

function getPlaylistById(id) {
  return playlists.get(id);
}

function startSync(playlistId) {
  const playlist = playlists.get(playlistId);
  if (!playlist) throw new Error('Playlist not found');
  if (playlist.process) throw new Error('Sync already in progress');

  playlist.status = 'syncing';
  playlist.errorMessage = null;

  const child = startPlaylistDownload(
    playlist.url,
    playlist.downloadDir,
    (line, stream) => {
      const ts = new Date().toISOString();
      playlist.logs.push(`[${ts}] [${stream}] ${line}`);
      if (playlist.logs.length > 500) playlist.logs.shift();
    }
  );

  playlist.process = child;

  child.on('close', async code => {
    playlist.process = null;
    playlist.lastSyncAt = new Date();
    if (code === 0) {
      playlist.status = 'idle';
    } else {
      playlist.status = 'error';
      playlist.errorMessage = `spotdl exited with code ${code}`;
    }
    try {
      await updateDownloadStatus(playlist);
    } catch (err) {
      console.error(
        '[playlists] Failed to update download status after sync:',
        err
      );
    }
  });

  child.on('error', err => {
    playlist.process = null;
    playlist.status = 'error';
    playlist.errorMessage = `Failed to start spotdl: ${err.message}`;
  });
}

/**
 * Add a playlist from a Spotify URL (manual web form).
 * This does NOT persist to .env – it exists only in memory
 * until the server restarts.
 */
async function addPlaylistFromUrl(url) {
  const id = extractPlaylistId(url);
  if (!id) {
    throw new Error('Could not extract playlist ID from URL.');
  }

  const playlist = getOrCreatePlaylist(id, url, { isManual: true });
  await refreshMetadataAndTracks(playlist);
  return playlist;
}

/**
 * Cleanup helper: remove downloaded content for playlists whose
 * lastContentAt is older than ttlMs. Only deletes files; playlists
 * themselves remain in memory so they can be re-synced.
 */
function cleanupOldPlaylistContent(ttlMs) {
  const now = Date.now();
  for (const playlist of playlists.values()) {
    if (!playlist.lastContentAt) continue;
    const age = now - playlist.lastContentAt.getTime();
    if (age < ttlMs) continue;

    const dir = playlist.downloadDir;
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
      }
      // Reset track statuses
      for (const track of playlist.tracks) {
        track.localStatus = 'pending';
      }
      playlist.downloadedCount = 0;
      playlist.lastContentAt = null;
      console.log(
        `[cleanup] Removed downloaded content for playlist ${playlist.id} (${playlist.name}) after TTL`
      );
    } catch (err) {
      console.error(
        `[cleanup] Failed to clean playlist content for ${playlist.id}:`,
        err
      );
    }
  }
}

module.exports = {
  initPlaylistsFromEnv,
  refreshMetadataAndTracks,
  updateDownloadStatus,
  getAllPlaylistsSummary,
  getPlaylistById,
  startSync,
  addPlaylistFromUrl,
  cleanupOldPlaylistContent
};

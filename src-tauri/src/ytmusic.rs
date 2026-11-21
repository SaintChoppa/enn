//! Búsqueda de música para el descargador (ADR #112–#114).
//!
//! Fuente principal: la interfaz interna de YouTube Music (`youtubei/v1`,
//! cliente `WEB_REMIX`), la misma que usa la web y que yt-dlp consulta por
//! dentro. Responde en ~0,6–0,8 s, así que los resultados salen mientras se
//! escribe, y trae título, artista, álbum, duración y carátula.
//!
//! Respaldo: si esa interfaz falla (YouTube la cambia, o bloquea), se usa el
//! yt-dlp que ya viaja con la app: primero la búsqueda de YouTube Music y,
//! si no da nada, `ytsearch` de YouTube normal (~3 s, sin artista en Music).
//!
//! Privacidad: solo se envía el texto buscado y el idioma (`es`); ningún dato
//! del usuario, cookie ni identificador.

use serde::Serialize;
use serde_json::{json, Value};
use std::process::{Command, Stdio};
use std::time::Duration;

const API: &str = "https://music.youtube.com/youtubei/v1/";
const CLIENT_VERSION: &str = "1.20241106.01.00";
/// filtros de la búsqueda de YouTube Music (los que usa la propia web)
const FILTER_SONGS: &str = "EgWKAQIIAWoMEA4QChADEAQQCRAF";
const FILTER_ALBUMS: &str = "EgWKAQIYAWoMEA4QChADEAQQCRAF";
const MAX_SONGS: usize = 8;
const MAX_ALBUMS: usize = 3;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Song {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration: Option<String>,
    pub thumb: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Album {
    pub browse_id: String,
    pub playlist: Option<String>,
    pub title: String,
    pub artist: String,
    /// «Álbum», «EP», «Sencillo»… tal como lo da YouTube Music
    pub label: Option<String>,
    pub year: Option<String>,
    pub thumb: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Item {
    Song(Song),
    Album(Album),
}

#[derive(Serialize, Debug)]
pub struct SearchResult {
    /// "ytmusic", "ytdlp-music" o "youtube"
    pub source: &'static str,
    /// sin conexión: ninguna fuente pudo llegar a internet
    pub offline: bool,
    pub items: Vec<Item>,
}

#[derive(Serialize, Debug)]
pub struct AlbumDetail {
    pub browse_id: String,
    pub playlist: Option<String>,
    pub title: String,
    pub artist: String,
    pub year: Option<String>,
    pub thumb: Option<String>,
    pub tracks: Vec<Song>,
}

/// Error de red: distingue «no hay conexión» de «la interfaz falló».
#[derive(Debug)]
enum NetErr {
    Offline,
    Other(String),
}

fn call(endpoint: &str, body: Value) -> Result<Value, NetErr> {
    let mut b = body;
    b["context"] = json!({ "client": { "clientName": "WEB_REMIX", "clientVersion": CLIENT_VERSION, "hl": "es" } });
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .build();
    let res = agent
        .post(&format!("{API}{endpoint}?prettyPrint=false"))
        .set("Content-Type", "application/json")
        .set("Origin", "https://music.youtube.com")
        .set("User-Agent", "Mozilla/5.0")
        .send_json(b);
    match res {
        Ok(r) => r
            .into_json::<Value>()
            .map_err(|e| NetErr::Other(e.to_string())),
        Err(ureq::Error::Transport(t)) => match t.kind() {
            ureq::ErrorKind::Dns | ureq::ErrorKind::ConnectionFailed | ureq::ErrorKind::Io => {
                Err(NetErr::Offline)
            }
            _ => Err(NetErr::Other(t.to_string())),
        },
        Err(e) => Err(NetErr::Other(e.to_string())),
    }
}

/// Radio de YouTube Music de un vídeo (Sprint 3): las ~50 canciones que
/// la propia web pondría después. `Err(None)` = sin conexión.
pub fn radio_next(video_id: &str) -> Result<Value, Option<String>> {
    call(
        "next",
        json!({ "videoId": video_id, "playlistId": format!("RDAMVM{video_id}"), "isAudioOnly": true }),
    )
    .map_err(|e| match e {
        NetErr::Offline => None,
        NetErr::Other(m) => Some(m),
    })
}

// ---------------------------------------------------------------- lectura del JSON

/// Todos los objetos con clave `key` del árbol, en orden de documento.
fn find_all<'a>(v: &'a Value, key: &str, out: &mut Vec<&'a Value>) {
    match v {
        Value::Object(m) => {
            for (k, x) in m {
                if k == key {
                    out.push(x);
                }
                find_all(x, key, out);
            }
        }
        Value::Array(a) => a.iter().for_each(|x| find_all(x, key, out)),
        _ => {}
    }
}

fn first_str<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    let mut all = Vec::new();
    find_all(v, key, &mut all);
    all.into_iter().find_map(|x| x.as_str())
}

fn runs(v: &Value) -> Vec<&Value> {
    v.get("runs")
        .and_then(|r| r.as_array())
        .map(|a| a.iter().collect())
        .unwrap_or_default()
}

fn run_text(r: &Value) -> &str {
    r.get("text").and_then(|t| t.as_str()).unwrap_or("")
}

fn page_type(r: &Value) -> Option<&str> {
    r.pointer("/navigationEndpoint/browseEndpoint/browseEndpointContextSupportedConfigs/browseEndpointContextMusicConfig/pageType")
        .and_then(|p| p.as_str())
}

fn flex_runs(item: &Value, col: usize) -> Vec<&Value> {
    item.pointer(&format!(
        "/flexColumns/{col}/musicResponsiveListItemFlexColumnRenderer/text"
    ))
    .map(runs)
    .unwrap_or_default()
}

/// Carátula a un tamaño razonable para la lista (las de álbum llegan a 544 px).
fn thumb_of(item: &Value) -> Option<String> {
    let list = item
        .pointer("/thumbnail/musicThumbnailRenderer/thumbnail/thumbnails")?
        .as_array()?;
    let url = list.last()?.get("url")?.as_str()?;
    Some(resize_thumb(url, 226))
}

fn resize_thumb(url: &str, px: u32) -> String {
    // las de googleusercontent terminan en «=w120-h120-…»: se pide otro tamaño
    if let Some(i) = url.rfind("=w") {
        let tail = &url[i + 2..];
        if let Some(j) = tail.find('-') {
            let rest = &tail[j + 1..];
            if let Some(k) = rest.find('-') {
                return format!("{}=w{px}-h{px}-{}", &url[..i], &rest[k + 1..]);
            }
        }
    }
    url.to_string()
}

fn is_duration(s: &str) -> bool {
    let s = s.trim();
    !s.is_empty() && s.contains(':') && s.chars().all(|c| c.is_ascii_digit() || c == ':')
}

fn parse_song(item: &Value, fallback_artist: &str) -> Option<Song> {
    let id = item
        .pointer("/playlistItemData/videoId")
        .and_then(|v| v.as_str())
        .or_else(|| first_str(item, "videoId"))?
        .to_string();
    let title = flex_runs(item, 0)
        .first()
        .map(|r| run_text(r).to_string())?;
    let meta = flex_runs(item, 1);
    let artists: Vec<&str> = meta
        .iter()
        .filter(|r| {
            page_type(r) == Some("MUSIC_PAGE_TYPE_ARTIST")
                || page_type(r) == Some("MUSIC_PAGE_TYPE_USER_CHANNEL")
        })
        .map(|r| run_text(r))
        .collect();
    let artist = if artists.is_empty() {
        // en las pistas de un álbum la columna trae el texto sin enlace
        meta.first()
            .map(|r| run_text(r))
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(fallback_artist)
            .to_string()
    } else {
        artists.join(", ")
    };
    let album = meta
        .iter()
        .find(|r| page_type(r) == Some("MUSIC_PAGE_TYPE_ALBUM"))
        .map(|r| run_text(r).to_string());
    let duration = meta
        .iter()
        .map(|r| run_text(r))
        .find(|s| is_duration(s))
        .map(|s| s.to_string())
        .or_else(|| {
            item.pointer("/fixedColumns/0/musicResponsiveListItemFixedColumnRenderer/text")
                .map(runs)
                .and_then(|rs| rs.first().map(|r| run_text(r).to_string()))
                .filter(|s| is_duration(s))
        });
    Some(Song {
        id,
        title,
        artist,
        album,
        duration,
        thumb: thumb_of(item),
    })
}

/// Un álbum solo cuenta si su artista es un canal oficial de artista.
fn parse_album(item: &Value) -> Option<Album> {
    let browse_id = item
        .pointer("/navigationEndpoint/browseEndpoint/browseId")?
        .as_str()?
        .to_string();
    let title = flex_runs(item, 0)
        .first()
        .map(|r| run_text(r).to_string())?;
    let meta = flex_runs(item, 1);
    let artist_run = meta
        .iter()
        .find(|r| page_type(r) == Some("MUSIC_PAGE_TYPE_ARTIST"))?;
    let label = meta
        .first()
        .map(|r| run_text(r).to_string())
        .filter(|s| !s.trim().is_empty() && s != run_text(artist_run));
    let year = meta
        .iter()
        .map(|r| run_text(r).trim())
        .find(|s| s.len() == 4 && s.chars().all(|c| c.is_ascii_digit()))
        .map(|s| s.to_string());
    let playlist = first_str(item, "playlistId").map(|s| s.to_string());
    Some(Album {
        browse_id,
        playlist,
        title,
        artist: run_text(artist_run).to_string(),
        label,
        year,
        thumb: thumb_of(item),
    })
}

fn norm(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'á' | 'à' | 'ä' | 'â' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ñ' => 'n',
            c => c,
        })
        .flat_map(|c| c.to_lowercase())
        .filter(|c| c.is_alphanumeric() || *c == ' ')
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Álbumes «del artista buscado»: su artista sale en las canciones o en la
/// consulta. Así no se cuelan recopilatorios ni álbumes de otros artistas.
fn relevant_albums(albums: Vec<Album>, songs: &[Song], query: &str) -> Vec<Album> {
    let q = norm(query);
    let song_artists: Vec<String> = songs
        .iter()
        .flat_map(|s| s.artist.split(", ").map(norm).collect::<Vec<_>>())
        .collect();
    albums
        .into_iter()
        .filter(|a| {
            let ar = norm(&a.artist);
            !ar.is_empty() && (q.contains(&ar) || song_artists.iter().any(|s| s == &ar))
        })
        .take(MAX_ALBUMS)
        .collect()
}

/// Mezcla: los álbumes se intercalan entre las canciones (posiciones 2, 5 y 8).
pub fn interleave(songs: Vec<Song>, albums: Vec<Album>) -> Vec<Item> {
    let mut out: Vec<Item> = songs.into_iter().map(Item::Song).collect();
    for (k, a) in albums.into_iter().enumerate() {
        let at = (2 + k * 3).min(out.len());
        out.insert(at, Item::Album(a));
    }
    out
}

fn ytm_search(query: &str) -> Result<Vec<Item>, NetErr> {
    // canciones y álbumes a la vez: dos peticiones en paralelo
    let q2 = query.to_string();
    let albums_t =
        std::thread::spawn(move || call("search", json!({ "query": q2, "params": FILTER_ALBUMS })));
    let songs_v = call("search", json!({ "query": query, "params": FILTER_SONGS }))?;
    let mut items = Vec::new();
    find_all(&songs_v, "musicResponsiveListItemRenderer", &mut items);
    let songs: Vec<Song> = items
        .iter()
        .filter_map(|i| parse_song(i, ""))
        .take(MAX_SONGS)
        .collect();
    let albums = match albums_t.join() {
        Ok(Ok(v)) => {
            let mut a = Vec::new();
            find_all(&v, "musicResponsiveListItemRenderer", &mut a);
            relevant_albums(
                a.iter().filter_map(|i| parse_album(i)).collect(),
                &songs,
                query,
            )
        }
        _ => Vec::new(),
    };
    if songs.is_empty() && albums.is_empty() {
        return Err(NetErr::Other("sin resultados".into()));
    }
    Ok(interleave(songs, albums))
}

// ---------------------------------------------------------------- respaldo con yt-dlp

fn ytdlp_json(url: &str) -> Option<Value> {
    let bin = crate::downloader::yt_dlp_path();
    let mut cmd = Command::new(&bin);
    cmd.args([
        "--flat-playlist",
        "-J",
        "--no-warnings",
        "--encoding",
        "utf-8",
        "--playlist-end",
        "8",
    ])
    .arg(url)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: sin consola emergente
    }
    let out = cmd.output().ok()?;
    serde_json::from_slice(&out.stdout).ok()
}

/// `m:ss`, o `h:mm:ss` desde una hora (auditoría 2026-11-12, bug #5: una
/// pista de una hora salía como `60:00`).
fn fmt_secs(s: f64) -> String {
    let s = s.round() as u64;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, (s % 3600) / 60, s % 60)
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}

fn ytdlp_songs(v: &Value, music: bool) -> Vec<Item> {
    v.get("entries")
        .and_then(|e| e.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|e| {
                    let id = e.get("id")?.as_str()?.to_string();
                    let title = e.get("title")?.as_str()?.to_string();
                    let artist = e
                        .get("channel")
                        .or_else(|| e.get("uploader"))
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let duration = e.get("duration").and_then(|d| d.as_f64()).map(fmt_secs);
                    let thumb = Some(format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg"));
                    let _ = music;
                    Some(Item::Song(Song {
                        id,
                        title,
                        artist,
                        album: None,
                        duration,
                        thumb,
                    }))
                })
                .take(MAX_SONGS)
                .collect()
        })
        .unwrap_or_default()
}

/// Busca canciones (y álbumes oficiales) para `query`.
pub fn search(query: &str) -> SearchResult {
    let query = query.trim();
    if query.is_empty() {
        return SearchResult {
            source: "ytmusic",
            offline: false,
            items: Vec::new(),
        };
    }
    let first = ytm_search(query);
    match first {
        Ok(items) => {
            return SearchResult {
                source: "ytmusic",
                offline: false,
                items,
            }
        }
        Err(NetErr::Offline) => {
            return SearchResult {
                source: "ytmusic",
                offline: true,
                items: Vec::new(),
            }
        }
        Err(NetErr::Other(e)) => {
            crate::player::log_warn(&format!("búsqueda YouTube Music falló, se usa yt-dlp: {e}"))
        }
    }
    let enc: String = query
        .bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            b' ' => "+".into(),
            _ => format!("%{b:02X}"),
        })
        .collect();
    if let Some(v) = ytdlp_json(&format!("https://music.youtube.com/search?q={enc}#songs")) {
        let items = ytdlp_songs(&v, true);
        if !items.is_empty() {
            return SearchResult {
                source: "ytdlp-music",
                offline: false,
                items,
            };
        }
    }
    match ytdlp_json(&format!("ytsearch{MAX_SONGS}:{query}")) {
        Some(v) => SearchResult {
            source: "youtube",
            offline: false,
            items: ytdlp_songs(&v, false),
        },
        // yt-dlp tampoco llegó a nada: lo más probable es que no haya red
        None => SearchResult {
            source: "youtube",
            offline: true,
            items: Vec::new(),
        },
    }
}

const FILTER_ARTISTS: &str = "EgWKAQIgAWoMEA4QChADEAQQCRAF";

/// Foto actual de un artista en YouTube Music (la de su canal oficial).
/// Busca con el filtro de artistas y se queda con el primero cuyo nombre
/// coincide; si ninguno coincide, None (la UI usa la carátula de sus canciones).
pub fn artist_photo(name: &str) -> Result<Option<String>, String> {
    let v = call("search", json!({ "query": name, "params": FILTER_ARTISTS })).map_err(
        |e| match e {
            NetErr::Offline => "sin conexión a internet".to_string(),
            NetErr::Other(m) => m,
        },
    )?;
    let want = norm(name);
    let mut items = Vec::new();
    find_all(&v, "musicResponsiveListItemRenderer", &mut items);
    for it in items {
        let title = flex_runs(it, 0)
            .first()
            .map(|r| norm(run_text(r)))
            .unwrap_or_default();
        if title == want {
            return Ok(thumb_of(it).map(|u| resize_thumb(&u, 240)));
        }
    }
    Ok(None)
}

/// Canciones de un álbum de YouTube Music.
pub fn album(browse_id: &str) -> Result<AlbumDetail, String> {
    let v = call("browse", json!({ "browseId": browse_id })).map_err(|e| match e {
        NetErr::Offline => "sin conexión a internet".to_string(),
        NetErr::Other(m) => m,
    })?;
    let mut hdr = Vec::new();
    find_all(&v, "musicResponsiveHeaderRenderer", &mut hdr);
    let h = hdr.first().copied().unwrap_or(&Value::Null);
    let title = h
        .get("title")
        .map(runs)
        .and_then(|r| r.first().map(|x| run_text(x).to_string()))
        .unwrap_or_default();
    let artist = h
        .get("straplineTextOne")
        .map(runs)
        .map(|r| r.iter().map(|x| run_text(x)).collect::<String>())
        .unwrap_or_default();
    let year = h.get("subtitle").map(runs).and_then(|r| {
        r.iter()
            .map(|x| run_text(x).trim().to_string())
            .find(|s| s.len() == 4 && s.chars().all(|c| c.is_ascii_digit()))
    });
    let thumb = h
        .pointer("/thumbnail/musicThumbnailRenderer/thumbnail/thumbnails")
        .and_then(|t| t.as_array())
        .and_then(|a| a.last())
        .and_then(|t| t.get("url"))
        .and_then(|u| u.as_str())
        .map(|u| resize_thumb(u, 544));
    let mut items = Vec::new();
    find_all(&v, "musicResponsiveListItemRenderer", &mut items);
    let tracks: Vec<Song> = items
        .iter()
        .filter_map(|i| parse_song(i, &artist))
        .map(|mut s| {
            s.thumb = thumb.clone();
            s.album = Some(title.clone());
            s
        })
        .collect();
    let playlist = {
        let mut ids = Vec::new();
        find_all(&v, "playlistId", &mut ids);
        ids.into_iter()
            .filter_map(|x| x.as_str())
            .find(|s| s.starts_with("OLAK5uy_"))
            .map(|s| s.to_string())
    };
    if tracks.is_empty() {
        return Err("el álbum no trajo canciones".into());
    }
    Ok(AlbumDetail {
        browse_id: browse_id.to_string(),
        playlist,
        title,
        artist,
        year,
        thumb,
        tracks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song_item(title: &str, artist: &str, album: &str, dur: &str, id: &str) -> Value {
        json!({
            "flexColumns": [
                { "musicResponsiveListItemFlexColumnRenderer": { "text": { "runs": [ { "text": title } ] } } },
                { "musicResponsiveListItemFlexColumnRenderer": { "text": { "runs": [
                    { "text": artist, "navigationEndpoint": { "browseEndpoint": { "browseId": "UC1", "browseEndpointContextSupportedConfigs": { "browseEndpointContextMusicConfig": { "pageType": "MUSIC_PAGE_TYPE_ARTIST" } } } } },
                    { "text": " • " },
                    { "text": album, "navigationEndpoint": { "browseEndpoint": { "browseId": "MPREb_1", "browseEndpointContextSupportedConfigs": { "browseEndpointContextMusicConfig": { "pageType": "MUSIC_PAGE_TYPE_ALBUM" } } } } },
                    { "text": " • " },
                    { "text": dur }
                ] } } }
            ],
            "thumbnail": { "musicThumbnailRenderer": { "thumbnail": { "thumbnails": [ { "url": "https://yt3.googleusercontent.com/abc=w120-h120-l90-rj" } ] } } },
            "playlistItemData": { "videoId": id }
        })
    }

    #[test]
    fn parses_a_song_row() {
        let s = parse_song(
            &song_item("Amorfoda", "Bad Bunny", "Amorfoda", "2:34", "ddDYuehbO74"),
            "",
        )
        .unwrap();
        assert_eq!(s.id, "ddDYuehbO74");
        assert_eq!(s.artist, "Bad Bunny");
        assert_eq!(s.album.as_deref(), Some("Amorfoda"));
        assert_eq!(s.duration.as_deref(), Some("2:34"));
        assert_eq!(
            s.thumb.as_deref(),
            Some("https://yt3.googleusercontent.com/abc=w226-h226-l90-rj")
        );
    }

    #[test]
    fn only_albums_of_the_searched_artist_and_interleaved() {
        let songs = vec![
            parse_song(&song_item("A", "Bad Bunny", "X", "3:00", "1"), "").unwrap(),
            parse_song(&song_item("B", "Bad Bunny", "X", "3:00", "2"), "").unwrap(),
            parse_song(&song_item("C", "Bad Bunny", "X", "3:00", "3"), "").unwrap(),
        ];
        let mk = |t: &str, a: &str| Album {
            browse_id: t.into(),
            playlist: None,
            title: t.into(),
            artist: a.into(),
            label: None,
            year: None,
            thumb: None,
        };
        let albums = relevant_albums(
            vec![mk("UVST", "Bad Bunny"), mk("Recop", "Varios artistas")],
            &songs,
            "bad bunny",
        );
        assert_eq!(albums.len(), 1);
        let mixed = interleave(songs, albums);
        assert!(matches!(mixed[2], Item::Album(_)));
        assert_eq!(mixed.len(), 4);
    }

    #[test]
    fn normalizes_accents_and_case() {
        assert_eq!(norm("Tití Me Preguntó!"), "titi me pregunto");
    }

    /// Auditoría 2026-11-12, bug #5: una hora salía como `60:00`.
    #[test]
    fn formats_hours() {
        assert_eq!(fmt_secs(59.0), "0:59");
        assert_eq!(fmt_secs(3599.0), "59:59");
        assert_eq!(fmt_secs(3600.0), "1:00:00");
        assert_eq!(fmt_secs(5400.0), "1:30:00");
        assert_eq!(fmt_secs(7384.0), "2:03:04");
    }
}

/// Prueba contra la red real (no corre en CI): `cargo test ytm_live -- --ignored --nocapture`
#[cfg(test)]
mod live {
    #[test]
    #[ignore]
    fn ytm_live() {
        let t = std::time::Instant::now();
        let r = super::search("bad bunny");
        println!(
            "{} en {:?}: {} resultados",
            r.source,
            t.elapsed(),
            r.items.len()
        );
        for i in r.items.iter().take(6) {
            println!("  {i:?}");
        }
        assert!(!r.items.is_empty());
        if let Some(super::Item::Album(a)) =
            r.items.iter().find(|i| matches!(i, super::Item::Album(_)))
        {
            let d = super::album(&a.browse_id).unwrap();
            println!(
                "álbum {} · {} pistas · lista {:?}",
                d.title,
                d.tracks.len(),
                d.playlist
            );
            assert!(!d.tracks.is_empty());
        }
    }
}

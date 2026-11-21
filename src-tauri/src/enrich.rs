//! Rescate de etiquetas (Sprint 3, T3).
//!
//! Hoy todas las pistas dicen «Music». En segundo plano, de la más escuchada
//! a la menos, y con caché de 90 días, se buscan etiquetas reales:
//!
//! 1. el archivo (género si no es de la lista negra) — sin red;
//! 2. Deezer: géneros del álbum y BPM, validado por título, artista y
//!    duración ± 5 s;
//! 3. Last.fm, solo si hay clave en Ajustes;
//! 4. iTunes, de respaldo;
//! 5. la radio de YouTube Music: qué canciones de tu biblioteca son vecinas;
//! 6. propagación: una canción sin etiquetas hereda, con menos peso, las de
//!    sus vecinas y las de su artista.
//!
//! El propietario eligió «datos en línea encendidos» (2026-11-17). Solo se
//! envía artista y título, o el id de YouTube; sin cuenta.

use std::collections::HashMap;

use serde_json::Value;

use crate::taxonomy::{self, norm};

/// Margen de duración para dar por buena una coincidencia.
pub const DUR_TOLERANCE_S: f64 = 5.0;

/// Peso de cada fuente al sumar etiquetas.
pub fn source_weight(source: &str) -> f32 {
    match source {
        "deezer" | "lastfm" => 1.0,
        "itunes" => 0.7,
        "archivo" => 0.6,
        "ytmusic" => 0.5,
        "propagado" => 0.4,
        _ => 0.3,
    }
}

/// Una canción de la radio de YouTube Music.
#[derive(Clone, Debug, PartialEq)]
pub struct RadioItem {
    pub video_id: String,
    pub title: String,
    pub artists: Vec<String>,
    pub dur: Option<f64>,
}

/// Artistas de un texto «A, B & C feat. D».
pub fn split_artists(s: &str) -> Vec<String> {
    let mut t = format!(" {s} ");
    for sep in [
        ",", " & ", " feat. ", " feat ", " ft. ", " ft ", " y ", " x ", " con ", " with ",
        " Feat. ", " Ft. ", " X ",
    ] {
        t = t.replace(sep, "\u{1}");
    }
    t.split('\u{1}')
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .map(String::from)
        .collect()
}

/// Título comparable: sin paréntesis de ruido («feat.», «Official Video»…).
fn title_key(t: &str) -> String {
    let mut out = String::new();
    let mut depth = 0usize;
    let mut buf = String::new();
    for c in t.chars() {
        match c {
            '(' | '[' => {
                depth += 1;
                buf.clear();
            }
            ')' | ']' if depth > 0 => {
                depth -= 1;
                let b = norm(&buf);
                let noise = [
                    "feat",
                    "ft",
                    "official",
                    "oficial",
                    "video",
                    "audio",
                    "lyrics",
                    "letra",
                    "visualizer",
                    "remaster",
                    "remastered",
                    "hd",
                    "hq",
                    "4k",
                    "radio edit",
                ];
                if !noise
                    .iter()
                    .any(|n| format!(" {b} ").contains(&format!(" {n} ")))
                {
                    out.push(' ');
                    out.push_str(&b);
                }
                buf.clear();
            }
            _ if depth > 0 => buf.push(c),
            _ => out.push(c),
        }
    }
    norm(&out)
}

fn artist_set(s: &str) -> Vec<String> {
    split_artists(s)
        .iter()
        .map(|a| norm(a))
        .filter(|a| !a.is_empty())
        .collect()
}

/// ¿Es la misma canción? Título sin «(feat. …)» ni «(Official Video)», algún
/// artista en común y, si se conocen las dos, duración ± 5 s.
pub fn same_song(a: (&str, &str, Option<f64>), b: (&str, &str, Option<f64>)) -> bool {
    if title_key(a.0) != title_key(b.0) || title_key(a.0).is_empty() {
        return false;
    }
    let (aa, bb) = (artist_set(a.1), artist_set(b.1));
    if !aa.iter().any(|x| bb.contains(x)) {
        return false;
    }
    match (a.2, b.2) {
        (Some(x), Some(y)) => (x - y).abs() <= DUR_TOLERANCE_S,
        _ => true,
    }
}

/// Deezer `search`: (id de pista, id de álbum) de la que coincide.
pub fn deezer_pick(v: &Value, title: &str, artist: &str, dur: Option<f64>) -> Option<(u64, u64)> {
    v["data"].as_array()?.iter().find_map(|t| {
        let ok = same_song(
            (title, artist, dur),
            (
                t["title"].as_str()?,
                t["artist"]["name"].as_str()?,
                t["duration"].as_f64(),
            ),
        );
        ok.then(|| Some((t["id"].as_u64()?, t["album"]["id"].as_u64()?)))?
    })
}

pub fn deezer_genres(album: &Value) -> Vec<String> {
    album["genres"]["data"]
        .as_array()
        .map(|g| {
            g.iter()
                .filter_map(|x| x["name"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

pub fn deezer_bpm(track: &Value) -> Option<f32> {
    track["bpm"].as_f64().filter(|b| *b > 0.0).map(|b| b as f32)
}

pub fn itunes_genre(v: &Value, title: &str, artist: &str, dur: Option<f64>) -> Option<String> {
    v["results"].as_array()?.iter().find_map(|t| {
        let d = t["trackTimeMillis"].as_f64().map(|ms| ms / 1000.0);
        let ok = same_song(
            (title, artist, dur),
            (t["trackName"].as_str()?, t["artistName"].as_str()?, d),
        );
        ok.then(|| t["primaryGenreName"].as_str().map(String::from))?
    })
}

pub fn lastfm_tags(v: &Value) -> Vec<(String, f32)> {
    let Some(tags) = v["toptags"]["tag"].as_array() else {
        return Vec::new();
    };
    let count = |t: &Value| {
        t["count"]
            .as_f64()
            .or_else(|| t["count"].as_str()?.parse().ok())
            .unwrap_or(0.0)
    };
    let max = tags.iter().map(count).fold(0.0, f64::max);
    if max <= 0.0 {
        return Vec::new();
    }
    tags.iter()
        .filter_map(|t| Some((t["name"].as_str()?.to_string(), (count(t) / max) as f32)))
        .filter(|(_, w)| *w >= 0.1)
        .collect()
}

fn runs_text(v: &Value) -> String {
    v["runs"]
        .as_array()
        .map(|r| r.iter().filter_map(|x| x["text"].as_str()).collect())
        .unwrap_or_default()
}

fn find_all<'a>(v: &'a Value, key: &str, out: &mut Vec<&'a Value>) {
    match v {
        Value::Object(m) => {
            for (k, x) in m {
                if k == key {
                    out.push(x);
                } else {
                    find_all(x, key, out);
                }
            }
        }
        Value::Array(a) => a.iter().for_each(|x| find_all(x, key, out)),
        _ => {}
    }
}

fn mmss(s: &str) -> Option<f64> {
    s.split(':').try_fold(0.0, |acc, p| {
        p.trim().parse::<f64>().ok().map(|n| acc * 60.0 + n)
    })
}

pub fn ytm_radio(v: &Value) -> Vec<RadioItem> {
    let mut found = Vec::new();
    find_all(v, "playlistPanelVideoRenderer", &mut found);
    found
        .into_iter()
        .filter_map(|r| {
            let byline = runs_text(&r["longBylineText"]);
            let artists = byline.split(" \u{2022} ").next().unwrap_or("");
            Some(RadioItem {
                video_id: r["videoId"].as_str()?.to_string(),
                title: runs_text(&r["title"]),
                artists: split_artists(artists),
                dur: mmss(&runs_text(&r["lengthText"])),
            })
        })
        .collect()
}

/// Suma las etiquetas en bruto de cada fuente en familias con peso (0–1,
/// la más fuerte vale 1); como mucho las 5 primeras.
pub fn combine(raw: &[(String, String, f32)]) -> Vec<(String, f32)> {
    let tax = taxonomy::get();
    let mut score: HashMap<String, f32> = HashMap::new();
    for (src, tag, w) in raw {
        // «Electro Pop/Electro Rock» da tres familias: cada una pesa menos
        let fams = tax.families_of(tag);
        let share = 1.0 / (fams.len().max(1) as f32).sqrt();
        for f in fams {
            *score.entry(f).or_default() += source_weight(src) * w * share;
        }
    }
    normalize(score, 1.0)
}

fn normalize(score: HashMap<String, f32>, top: f32) -> Vec<(String, f32)> {
    let max = score.values().copied().fold(0.0f32, f32::max);
    if max <= 0.0 {
        return Vec::new();
    }
    let mut v: Vec<(String, f32)> = score
        .into_iter()
        .map(|(f, s)| (f, s / max * top))
        .filter(|(_, w)| *w >= 0.15 * top)
        .collect();
    v.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    v.truncate(5);
    v
}

/// Etiquetas heredadas por una canción sin etiquetas: las de sus vecinas y
/// las de su artista, con menos peso (como mucho 0,5).
pub fn propagate(
    neighbors: &[&[(String, f32)]],
    same_artist: &[&[(String, f32)]],
) -> Vec<(String, f32)> {
    let mut score: HashMap<String, f32> = HashMap::new();
    for (lists, w) in [(neighbors, 1.0f32), (same_artist, 0.8)] {
        for l in lists {
            for (f, x) in l.iter() {
                *score.entry(f.clone()).or_default() += x * w;
            }
        }
    }
    normalize(score, 0.5)
}

// ---------------------------------------------------------------- la pasada

/// La caché de una consulta en línea dura esto.
pub const CACHE_SECS: u64 = 90 * 86_400;

/// Fallo de red: sin conexión (se para la pasada) u otro (se sigue).
#[derive(Debug)]
pub enum Net {
    Offline,
    Other(String),
}

/// De dónde salen los datos en línea (en las pruebas, una red falsa).
pub trait Source {
    fn get(&self, url: &str) -> Result<Value, Net>;
    /// Radio de YouTube Music de un vídeo (`youtubei/v1/next`, `RDAMVM<id>`).
    fn ytm_next(&self, id: &str) -> Result<Value, Net>;
}

pub struct Cfg {
    /// «Enriquecer con datos en línea» (encendido de fábrica)
    pub online: bool,
    pub lastfm_key: Option<String>,
    /// segundos Unix
    pub now: u64,
    /// pausas entre llamadas (Deezer 5/s, iTunes 20/min); apagadas en las pruebas
    pub pause: bool,
}

#[derive(Debug, Default)]
pub struct Outcome {
    pub total: usize,
    /// canciones con alguna etiqueta al terminar
    pub tagged: usize,
    /// se cortó por falta de conexión
    pub offline: bool,
}

/// Texto para una URL (`%20` en vez de espacios, y lo demás escapado).
fn enc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Título sin paréntesis («Get Lucky (feat. …)» → «Get Lucky»), para buscar.
fn plain_title(t: &str) -> String {
    let mut out = String::new();
    let mut depth = 0usize;
    for c in t.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn nap(cfg: &Cfg, ms: u64) {
    if cfg.pause {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
}

/// Lo que se sabe de una canción en línea: etiquetas en bruto, BPM y vecinas
/// (como pistas de la biblioteca).
struct Fetched {
    raw: Vec<(String, String, f32)>,
    bpm: Option<f32>,
    neighbors: Vec<String>,
}

fn fetch_one(
    t: &crate::library::Track,
    lib: &[crate::library::Track],
    keys: &[String],
    src: &dyn Source,
    cfg: &Cfg,
) -> Result<Fetched, Net> {
    let first_artist = split_artists(&t.artist)
        .into_iter()
        .next()
        .unwrap_or_default();
    let q = enc(&format!("{first_artist} {}", plain_title(&t.title)));
    let mut out = Fetched {
        raw: Vec::new(),
        bpm: None,
        neighbors: Vec::new(),
    };
    // Deezer: búsqueda → álbum (géneros) y pista (BPM)
    let found = src.get(&format!("https://api.deezer.com/search?q={q}&limit=10"))?;
    nap(cfg, 220);
    if let Some((tid, aid)) = deezer_pick(&found, &t.title, &t.artist, t.dur) {
        if let Ok(album) = src.get(&format!("https://api.deezer.com/album/{aid}")) {
            for g in deezer_genres(&album) {
                out.raw.push(("deezer".into(), g, 1.0));
            }
        }
        nap(cfg, 220);
        if let Ok(track) = src.get(&format!("https://api.deezer.com/track/{tid}")) {
            out.bpm = deezer_bpm(&track);
        }
        nap(cfg, 220);
    }
    // Last.fm, solo con clave
    if let Some(key) = cfg.lastfm_key.as_deref().filter(|k| !k.trim().is_empty()) {
        let url = format!(
            "https://ws.audioscrobbler.com/2.0/?method=track.gettoptags&artist={}&track={}&autocorrect=1&format=json&api_key={}",
            enc(&first_artist),
            enc(&plain_title(&t.title)),
            enc(key.trim())
        );
        if let Ok(v) = src.get(&url) {
            for (tag, w) in lastfm_tags(&v) {
                out.raw.push(("lastfm".into(), tag, w));
            }
        }
        nap(cfg, 250);
    }
    // iTunes de respaldo (20 consultas por minuto)
    if out.raw.is_empty() {
        nap(cfg, 3_100);
        let v = src.get(&format!(
            "https://itunes.apple.com/search?term={q}&entity=song&limit=10"
        ))?;
        if let Some(g) = itunes_genre(&v, &t.title, &t.artist, t.dur) {
            out.raw.push(("itunes".into(), g, 1.0));
        }
    }
    // radio de YouTube Music: qué canciones de la biblioteca son vecinas
    if let Some(id) = t.yt_id.as_deref() {
        if let Ok(v) = src.ytm_next(id) {
            for item in ytm_radio(&v).into_iter().filter(|r| r.video_id != id) {
                let hit = lib.iter().position(|l| {
                    l.path != t.path
                        && (l.yt_id.as_deref() == Some(item.video_id.as_str())
                            || same_song(
                                (&l.title, &l.artist, l.dur),
                                (&item.title, &item.artists.join(", "), item.dur),
                            ))
                });
                if let Some(i) = hit {
                    if !out.neighbors.contains(&keys[i]) {
                        out.neighbors.push(keys[i].clone());
                    }
                }
            }
        }
        nap(cfg, 300);
    }
    Ok(out)
}

/// Una pasada por la biblioteca: de la más escuchada a la menos, consulta en
/// línea lo que no esté al día (90 días) y después propaga etiquetas a las
/// que se quedaron sin ninguna. `progress(hechas, total)`.
pub fn run_pass(
    lib: &[crate::library::Track],
    ins: &std::sync::Mutex<crate::insights::Insights>,
    src: &dyn Source,
    cfg: &Cfg,
    progress: &dyn Fn(usize, usize),
) -> Outcome {
    use crate::insights::song_key;
    let keys: Vec<String> = lib
        .iter()
        .map(|t| song_key(&t.path, t.yt_id.as_deref()))
        .collect();
    let mut order: Vec<usize> = (0..lib.len()).collect();
    {
        let s = ins.lock().unwrap();
        let rank = |i: &usize| {
            s.songs
                .get(&keys[*i])
                .map(|x| (x.plays, x.last_played.unwrap_or(0)))
                .unwrap_or((0, 0))
        };
        order.sort_by_key(|i| std::cmp::Reverse(rank(i)));
    }
    let mut online = cfg.online;
    let mut out = Outcome {
        total: lib.len(),
        ..Outcome::default()
    };
    for (n, &i) in order.iter().enumerate() {
        let t = &lib[i];
        let fresh = {
            let s = ins.lock().unwrap();
            s.songs
                .get(&keys[i])
                .and_then(|x| x.fetched_at)
                .is_some_and(|f| cfg.now.saturating_sub(f) < CACHE_SECS)
        };
        if fresh {
            continue;
        }
        let mut raw: Vec<(String, String, f32)> = Vec::new();
        if !crate::taxonomy::get().is_blacklisted(&t.genre) {
            raw.push(("archivo".into(), t.genre.clone(), 1.0));
        }
        let mut fetched = None;
        if online {
            match fetch_one(t, lib, &keys, src, cfg) {
                Ok(f) => fetched = Some(f),
                Err(Net::Offline) => {
                    online = false;
                    out.offline = true;
                }
                Err(Net::Other(e)) => {
                    crate::player::log_warn(&format!("etiquetas de «{}»: {e}", t.title))
                }
            }
        }
        let mut s = ins.lock().unwrap();
        let st = s.songs.entry(keys[i].clone()).or_default();
        if let Some(f) = fetched {
            raw.extend(f.raw);
            if f.bpm.is_some() {
                st.bpm = f.bpm;
            }
            st.neighbors = f.neighbors;
            st.fetched_at = Some(cfg.now);
        }
        let tags = combine(&raw);
        if !tags.is_empty() {
            st.tags = tags;
            let mut srcs: Vec<String> = raw.iter().map(|r| r.0.clone()).collect();
            srcs.sort();
            srcs.dedup();
            st.sources = srcs;
        }
        drop(s);
        progress(n + 1, lib.len());
    }
    // propagación: las que no tienen etiquetas heredan de sus vecinas (en
    // las dos direcciones) y de las de su mismo artista
    let mut s = ins.lock().unwrap();
    let tags_of = |s: &crate::insights::Insights, k: &str| -> Vec<(String, f32)> {
        s.songs
            .get(k)
            .filter(|x| !x.sources.iter().any(|src| src == "propagado"))
            .map(|x| x.tags.clone())
            .unwrap_or_default()
    };
    let mut inherited: Vec<(usize, Vec<(String, f32)>)> = Vec::new();
    for (i, t) in lib.iter().enumerate() {
        let own = s.songs.get(&keys[i]);
        if own
            .is_some_and(|x| !x.tags.is_empty() && !x.sources.iter().any(|src| src == "propagado"))
        {
            continue;
        }
        let mut near: Vec<Vec<(String, f32)>> = Vec::new();
        if let Some(x) = own {
            for k in &x.neighbors {
                near.push(tags_of(&s, k));
            }
        }
        for (j, x) in s.songs.iter() {
            if x.neighbors.contains(&keys[i]) {
                near.push(tags_of(&s, j));
            }
        }
        let mine = artist_set(&t.artist);
        let same: Vec<Vec<(String, f32)>> = lib
            .iter()
            .enumerate()
            .filter(|(j, l)| *j != i && artist_set(&l.artist).iter().any(|a| mine.contains(a)))
            .map(|(j, _)| tags_of(&s, &keys[j]))
            .collect();
        let near_r: Vec<&[(String, f32)]> = near.iter().map(|v| v.as_slice()).collect();
        let same_r: Vec<&[(String, f32)]> = same.iter().map(|v| v.as_slice()).collect();
        let p = propagate(&near_r, &same_r);
        if !p.is_empty() {
            inherited.push((i, p));
        }
    }
    for (i, p) in inherited {
        let st = s.songs.entry(keys[i].clone()).or_default();
        st.tags = p;
        st.sources = vec!["propagado".into()];
    }
    out.tagged = keys
        .iter()
        .filter(|k| s.songs.get(*k).is_some_and(|x| !x.tags.is_empty()))
        .count();
    out
}

/// Espera hasta la siguiente pasada: un día, o una hora si no había conexión.
pub fn next_pass_in(offline: bool) -> std::time::Duration {
    std::time::Duration::from_secs(if offline { 3600 } else { 24 * 3600 })
}

/// La red de verdad (Deezer, iTunes, Last.fm y YouTube Music).
pub struct Http {
    agent: ureq::Agent,
}

impl Default for Http {
    fn default() -> Self {
        Http {
            agent: ureq::AgentBuilder::new()
                .timeout_connect(std::time::Duration::from_secs(6))
                .timeout(std::time::Duration::from_secs(15))
                .user_agent("Enn (reproductor de musica)")
                .build(),
        }
    }
}

impl Source for Http {
    fn get(&self, url: &str) -> Result<Value, Net> {
        match self.agent.get(url).call() {
            Ok(r) => r
                .into_json::<Value>()
                .map_err(|e| Net::Other(e.to_string())),
            Err(ureq::Error::Transport(t)) => match t.kind() {
                ureq::ErrorKind::Dns | ureq::ErrorKind::ConnectionFailed => Err(Net::Offline),
                _ => Err(Net::Other(t.to_string())),
            },
            Err(e) => Err(Net::Other(e.to_string())),
        }
    }

    fn ytm_next(&self, id: &str) -> Result<Value, Net> {
        crate::ytmusic::radio_next(id).map_err(|e| match e {
            None => Net::Offline,
            Some(m) => Net::Other(m),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Value {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name);
        serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
    }

    #[test]
    fn splits_artists() {
        assert_eq!(
            split_artists("Daft Punk, Pharrell Williams & Nile Rodgers"),
            ["Daft Punk", "Pharrell Williams", "Nile Rodgers"]
        );
        assert_eq!(
            split_artists("Bad Bunny feat. Drake"),
            ["Bad Bunny", "Drake"]
        );
        assert_eq!(
            split_artists("Daft Punk y Pharrell Williams"),
            ["Daft Punk", "Pharrell Williams"]
        );
    }

    #[test]
    fn matches_the_same_song_and_rejects_other_versions() {
        let local = (
            "Get Lucky (feat. Pharrell Williams and Nile Rodgers)",
            "Daft Punk, Pharrell Williams, Nile Rodgers",
            Some(369.0),
        );
        assert!(same_song(local, ("Get Lucky", "Daft Punk", Some(367.0))));
        // otra versión (radio edit): la duración no cuadra
        assert!(!same_song(
            local,
            (
                "Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers)",
                "Daft Punk",
                Some(248.0)
            )
        ));
        // homenaje de otro artista
        assert!(!same_song(
            local,
            ("Get Lucky - Tribute to Daft Punk", "Get Lucky", Some(369.0))
        ));
        // sin duración conocida basta título y artista
        assert!(same_song(
            ("Get Lucky", "Daft Punk", None),
            ("Get Lucky", "Daft Punk", Some(369.0))
        ));
    }

    #[test]
    fn deezer_finds_the_right_track_by_duration() {
        let v = fixture("deezer_search.json");
        // la versión larga (367 s) y la de radio (248 s) son pistas distintas
        let long = deezer_pick(
            &v,
            "Get Lucky (feat. Pharrell Williams and Nile Rodgers)",
            "Daft Punk",
            Some(369.0),
        );
        let radio = deezer_pick(
            &v,
            "Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers)",
            "Daft Punk",
            Some(248.0),
        );
        assert!(long.is_some() && radio.is_some());
        assert_ne!(long.unwrap().0, radio.unwrap().0);
        assert!(deezer_pick(&v, "Otra canción", "Nadie", Some(200.0)).is_none());
    }

    #[test]
    fn deezer_album_genres_and_bpm() {
        let g = deezer_genres(&fixture("deezer_album.json"));
        assert!(
            g.contains(&"Electro".to_string()) && g.contains(&"Soul & Funk".to_string()),
            "{g:?}"
        );
        assert_eq!(deezer_bpm(&fixture("deezer_track.json")), Some(116.13));
        assert_eq!(deezer_bpm(&serde_json::json!({ "bpm": 0 })), None);
    }

    #[test]
    fn itunes_primary_genre() {
        let v = fixture("itunes_search.json");
        assert_eq!(
            itunes_genre(&v, "Get Lucky", "Daft Punk", Some(369.6)).as_deref(),
            Some("Pop")
        );
        assert_eq!(itunes_genre(&v, "Nada", "Nadie", None), None);
    }

    #[test]
    fn youtube_music_radio_neighbors() {
        let r = ytm_radio(&fixture("ytm_next.json"));
        assert!(r.len() >= 40, "{}", r.len());
        let lose = r
            .iter()
            .find(|x| x.video_id == "iU7oF4OXZSE")
            .expect("Lose Yourself to Dance");
        assert!(lose.title.starts_with("Lose Yourself to Dance"));
        assert_eq!(lose.artists, ["Daft Punk", "Pharrell Williams"]);
        assert_eq!(lose.dur, Some(354.0));
        // un formato que no se entiende no rompe nada
        assert!(ytm_radio(&serde_json::json!({ "otra": "cosa" })).is_empty());
    }

    #[test]
    fn lastfm_tags_with_weights() {
        let v = serde_json::json!({ "toptags": { "tag": [
            { "name": "electronic", "count": 100 }, { "name": "disco", "count": 55 }, { "name": "seen live", "count": 3 }
        ]}});
        let t = lastfm_tags(&v);
        assert_eq!(t[0], ("electronic".to_string(), 1.0));
        assert!((t[1].1 - 0.55).abs() < 1e-6);
        assert!(
            t.len() == 2,
            "las etiquetas con muy poco peso se ignoran: {t:?}"
        );
    }

    #[test]
    fn combines_sources_into_weighted_families() {
        let raw = vec![
            ("archivo".to_string(), "Music".to_string(), 1.0),
            ("deezer".to_string(), "Electro".to_string(), 1.0),
            ("deezer".to_string(), "Dance".to_string(), 1.0),
            ("deezer".to_string(), "Soul & Funk".to_string(), 1.0),
            ("itunes".to_string(), "Pop".to_string(), 1.0),
            ("itunes".to_string(), "Dance".to_string(), 1.0),
        ];
        let f = combine(&raw);
        assert!(f.len() <= 5);
        assert_eq!(f[0], ("dance".to_string(), 1.0), "{f:?}"); // dos fuentes lo dicen
        assert!(f.iter().any(|(n, _)| n == "electronica"));
        assert!(f.iter().all(|(_, w)| *w > 0.0 && *w <= 1.0));
        assert!(combine(&[("archivo".into(), "Music".into(), 1.0)]).is_empty());
        assert!(source_weight("deezer") > source_weight("archivo"));
    }

    // ------------------------------------------------ la pasada completa, con red falsa

    use crate::insights::{song_key, Insights};
    use crate::library::Track;
    use std::cell::RefCell;
    use std::sync::Mutex;

    struct Fake {
        calls: RefCell<Vec<String>>,
        offline: bool,
    }

    impl Source for Fake {
        fn get(&self, url: &str) -> Result<Value, Net> {
            self.calls.borrow_mut().push(url.to_string());
            if self.offline {
                return Err(Net::Offline);
            }
            let lucky = url.contains("Get%20Lucky")
                || url.contains("Get+Lucky")
                || url.contains("get%20lucky");
            Ok(if url.contains("api.deezer.com/search") && lucky {
                fixture("deezer_search.json")
            } else if url.contains("api.deezer.com/album/") {
                fixture("deezer_album.json")
            } else if url.contains("api.deezer.com/track/") {
                fixture("deezer_track.json")
            } else if url.contains("itunes.apple.com") && lucky {
                fixture("itunes_search.json")
            } else {
                serde_json::json!({ "data": [], "results": [] })
            })
        }
        fn ytm_next(&self, id: &str) -> Result<Value, Net> {
            self.calls.borrow_mut().push(format!("ytm:{id}"));
            if self.offline {
                return Err(Net::Offline);
            }
            Ok(if id == "4D7u5KF7SP8" {
                fixture("ytm_next.json")
            } else {
                serde_json::json!({})
            })
        }
    }

    fn track(path: &str, title: &str, artist: &str, dur: f64, yt: Option<&str>) -> Track {
        Track {
            path: path.into(),
            title: title.into(),
            artist: artist.into(),
            album: String::new(),
            dur: Some(dur),
            rg: None,
            favorite: false,
            genre: "Music".into(),
            year: None,
            mtime: None,
            yt_id: yt.map(String::from),
        }
    }

    fn library() -> Vec<Track> {
        vec![
            track(
                "C:/m/lucky.m4a",
                "Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers)",
                "Daft Punk",
                248.0,
                Some("4D7u5KF7SP8"),
            ),
            track(
                "C:/m/lose.m4a",
                "Lose Yourself to Dance (feat. Pharrell Williams)",
                "Daft Punk, Pharrell Williams",
                354.0,
                Some("iU7oF4OXZSE"),
            ),
            track("C:/m/raro.m4a", "Algo Raro", "Nadie Conocido", 200.0, None),
        ]
    }

    fn cfg(now: u64) -> Cfg {
        Cfg {
            online: true,
            lastfm_key: None,
            now,
            pause: false,
        }
    }

    #[test]
    fn a_pass_tags_songs_finds_neighbors_and_propagates() {
        let lib = library();
        let ins = Mutex::new(Insights::default());
        let fake = Fake {
            calls: RefCell::new(Vec::new()),
            offline: false,
        };
        let out = run_pass(&lib, &ins, &fake, &cfg(1_000), &|_, _| {});
        assert!(!out.offline);
        let s = ins.lock().unwrap();
        let lucky = &s.songs[&song_key(&lib[0].path, lib[0].yt_id.as_deref())];
        let fams: Vec<&str> = lucky.tags.iter().map(|(f, _)| f.as_str()).collect();
        assert!(
            fams.contains(&"electronica") || fams.contains(&"dance"),
            "{fams:?}"
        );
        assert_eq!(lucky.bpm, Some(116.13));
        assert!(lucky.sources.contains(&"deezer".to_string()));
        assert_eq!(lucky.fetched_at, Some(1_000));
        // «Lose Yourself to Dance» está en la radio de «Get Lucky» y en la biblioteca
        let lose_key = song_key(&lib[1].path, lib[1].yt_id.as_deref());
        assert!(lucky.neighbors.contains(&lose_key), "{:?}", lucky.neighbors);
        // sin datos propios, hereda de su vecina y de su artista, con menos peso
        let lose = &s.songs[&lose_key];
        assert!(!lose.tags.is_empty(), "debería heredar etiquetas");
        assert!(lose.tags.iter().all(|(_, w)| *w <= 0.5));
        assert!(lose.sources.contains(&"propagado".to_string()));
        // la canción que nadie conoce se queda sin etiquetas, pero se anotó la consulta
        let raro = &s.songs[&song_key(&lib[2].path, None)];
        assert!(raro.tags.is_empty());
        assert_eq!(out.total, 3);
        assert_eq!(out.tagged, 2);
    }

    #[test]
    fn the_most_played_go_first_and_the_cache_lasts_90_days() {
        let lib = library();
        let ins = Mutex::new(Insights::default());
        {
            let mut s = ins.lock().unwrap();
            let k = song_key(&lib[2].path, None);
            s.on_start(&k, 200.0, true, 1);
            s.on_end(&k, 2);
        }
        let fake = Fake {
            calls: RefCell::new(Vec::new()),
            offline: false,
        };
        run_pass(&lib, &ins, &fake, &cfg(1_000), &|_, _| {});
        // la más escuchada («Algo Raro») se consultó primero
        assert!(
            fake.calls.borrow()[0].contains("Algo"),
            "{:?}",
            fake.calls.borrow()[0]
        );
        // al día siguiente no se vuelve a preguntar nada
        let fake2 = Fake {
            calls: RefCell::new(Vec::new()),
            offline: false,
        };
        run_pass(&lib, &ins, &fake2, &cfg(1_000 + 86_400), &|_, _| {});
        assert!(
            fake2.calls.borrow().is_empty(),
            "{:?}",
            fake2.calls.borrow()
        );
        // a los 91 días, sí
        let fake3 = Fake {
            calls: RefCell::new(Vec::new()),
            offline: false,
        };
        run_pass(&lib, &ins, &fake3, &cfg(1_000 + 91 * 86_400), &|_, _| {});
        assert!(!fake3.calls.borrow().is_empty());
    }

    #[test]
    fn offline_or_switched_off_keeps_working_with_local_data() {
        let mut lib = library();
        lib[2].genre = "Reggaeton".into(); // etiqueta del archivo, sin red
        let ins = Mutex::new(Insights::default());
        let fake = Fake {
            calls: RefCell::new(Vec::new()),
            offline: true,
        };
        let out = run_pass(&lib, &ins, &fake, &cfg(1_000), &|_, _| {});
        assert!(out.offline);
        let s = ins.lock().unwrap();
        let raro = &s.songs[&song_key(&lib[2].path, None)];
        assert_eq!(raro.tags[0].0, "regueton");
        // sin red no se apunta la consulta: se reintenta más tarde
        assert!(s.songs.values().all(|x| x.fetched_at.is_none()));
        drop(s);
        // con los datos en línea apagados no se llama a nada
        let fake2 = Fake {
            calls: RefCell::new(Vec::new()),
            offline: false,
        };
        let off = Cfg {
            online: false,
            ..cfg(2_000)
        };
        run_pass(&lib, &ins, &fake2, &off, &|_, _| {});
        assert!(fake2.calls.borrow().is_empty());
    }

    /// Con red: una pasada real con Deezer, iTunes y YouTube Music.
    /// `cargo test -- --ignored`
    #[test]
    #[ignore]
    fn a_real_pass_against_the_services() {
        let lib = library();
        let ins = Mutex::new(Insights::default());
        let t = std::time::Instant::now();
        let out = run_pass(
            &lib,
            &ins,
            &Http::default(),
            &Cfg {
                pause: true,
                ..cfg(1_000)
            },
            &|_, _| {},
        );
        let s = ins.lock().unwrap();
        for t in &lib {
            let x = &s.songs[&song_key(&t.path, t.yt_id.as_deref())];
            eprintln!(
                "{} → {:?} bpm={:?} fuentes={:?} vecinas={}",
                t.title,
                x.tags,
                x.bpm,
                x.sources,
                x.neighbors.len()
            );
        }
        eprintln!(
            "{} de {} con etiquetas en {:?}",
            out.tagged,
            out.total,
            t.elapsed()
        );
        assert!(!out.offline);
        assert!(out.tagged >= 2);
    }

    /// Medida del Sprint 3 con la biblioteca real (lee `ENN_LIBRARY`, escribe
    /// solo en una carpeta temporal). `cargo test -- --ignored real_library`
    #[test]
    #[ignore]
    fn real_library_coverage() {
        let Ok(path) = std::env::var("ENN_LIBRARY") else {
            eprintln!("sin ENN_LIBRARY");
            return;
        };
        let lib: crate::library::Library =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let mut tracks = lib.tracks;
        // id de YouTube de las que se indexaron antes del Sprint 3
        for t in tracks.iter_mut().filter(|t| t.yt_id.is_none()) {
            t.yt_id = crate::decode::Decoder::open(std::path::Path::new(&t.path))
                .ok()
                .and_then(|(_, o)| o.tags.yt_id);
        }
        let with_id = tracks.iter().filter(|t| t.yt_id.is_some()).count();
        let ins = Mutex::new(Insights::default());
        let t0 = std::time::Instant::now();
        let out = run_pass(
            &tracks,
            &ins,
            &Http::default(),
            &Cfg {
                pause: true,
                ..cfg(1_000)
            },
            &|d, n| {
                if d % 10 == 0 {
                    eprintln!("  {d}/{n}");
                }
            },
        );
        let s = ins.lock().unwrap();
        let mut by_src: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        let mut fams: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        let mut untagged = Vec::new();
        for t in &tracks {
            let x = s.songs.get(&song_key(&t.path, t.yt_id.as_deref()));
            match x {
                Some(x) if !x.tags.is_empty() => {
                    for src in &x.sources {
                        *by_src.entry(src.clone()).or_default() += 1;
                    }
                    *fams.entry(x.tags[0].0.clone()).or_default() += 1;
                }
                _ => untagged.push(format!("{} — {}", t.artist, t.title)),
            }
        }
        let neighbors: usize = s.songs.values().map(|x| x.neighbors.len()).sum();
        eprintln!(
            "pistas {}, con id de YouTube {with_id}, con etiquetas {} ({:.0} %), en {:?}",
            out.total,
            out.tagged,
            100.0 * out.tagged as f64 / out.total.max(1) as f64,
            t0.elapsed()
        );
        eprintln!("fuentes {by_src:?}");
        eprintln!("familia principal {fams:?}");
        eprintln!("enlaces de vecindad {neighbors}");
        eprintln!("sin etiquetas: {untagged:?}");
    }

    #[test]
    fn retries_hourly_when_offline_and_daily_otherwise() {
        assert_eq!(next_pass_in(true), std::time::Duration::from_secs(3600));
        assert_eq!(
            next_pass_in(false),
            std::time::Duration::from_secs(24 * 3600)
        );
    }

    #[test]
    fn a_tag_with_many_families_weighs_less_for_each() {
        let f = combine(&[
            ("deezer".into(), "Electro Pop/Electro Rock".into(), 1.0),
            ("deezer".into(), "Pop".into(), 1.0),
        ]);
        let w = |n: &str| f.iter().find(|x| x.0 == n).map(|x| x.1).unwrap_or(0.0);
        assert_eq!(w("pop"), 1.0);
        assert!(w("rock") < 0.5, "{f:?}");
    }

    #[test]
    fn propagation_inherits_with_less_weight() {
        let rock: Vec<(String, f32)> = vec![("rock".into(), 1.0)];
        let alt: Vec<(String, f32)> = vec![("alternativo".into(), 1.0), ("rock".into(), 0.5)];
        let p = propagate(&[&rock, &alt], &[]);
        assert_eq!(p[0].0, "rock");
        assert!(
            p.iter().all(|(_, w)| *w <= 0.5),
            "heredar pesa menos: {p:?}"
        );
        assert!(propagate(&[], &[]).is_empty());
    }
}
